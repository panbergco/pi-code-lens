# Deployment — for agents and operators

How to stand code-lens up on a machine, correctly, including the GPU policy. Written so
an agent can follow it without prior context.

---

## 0 · What you are deploying

Three long-lived pieces, none of which you write:

| piece | what it is | why long-lived |
|---|---|---|
| **semantic engine** (`ccc`) | code-specialised embedding search, its own daemon | holds the strong model; a cold start costs ~2.5 s per query |
| **graph engine** (`gitnexus`) | call graph, blast radius, control-flow substrate | holds an open index and its own model |
| **lens server** (`code-lens`) | routing + fusion over both | keeps both engines' connections warm; the CLI is a thin client |

The CLI (`lens`) loads no model and holds no state. If the server is absent it falls back
to running in-process — slower, but never an error.

---

## 1 · Prerequisites

```bash
node --version     # >= 22
npm --version
uv --version       # for the semantic engine (astral.sh/uv)
nvidia-smi         # OPTIONAL — see §3
```

No GPU is required. Everything below works on CPU; the GPU changes speed, not capability.

---

## 2 · Install

```bash
git clone https://github.com/panbergco/pi-code-lens.git && cd pi-code-lens
npm install && npm run build
node bin/lens.mjs install --hot-load        # places + supervises both engines
node bin/lens.mjs doctor --parity           # prove it
```

`install` does not vendor the engines — it installs each by its upstream's own method,
writes service units, and (with `--hot-load`) keeps their models resident. It is
idempotent: re-running it on a configured machine reports what is already present.

### Install traps it handles for you

| trap | symptom without the installer |
|---|---|
| global npm prefix | `EACCES` writing to `/usr/lib` — it installs to a user prefix |
| npm 11 + `npx` | crashes before the package runs — it installs globally instead |
| vendored grammars | minutes of build and a C++ toolchain requirement — skipped |
| unpinned `mcp` dependency | resolves to 2.x, which breaks the semantic engine's server mode. **The CLI keeps working, so the break is silent** — the installer pins it |

---

## 3 · GPU policy — optional, but use it if it is there

**The rule: GPU is never required. When GPUs exist, use them; when two or more exist, give
each engine its own.**

| hardware | placement | consequence |
|---|---|---|
| **2+ GPUs** | one engine per card — `--gpu-graph 0 --gpu-semantic 1` (the default) | **both engines index concurrently**; queries stay hot on separate cards |
| 1 GPU | both engines share it | works, but their combined embedding load may not fit, so full reindexes must run **one at a time** |
| no GPU | CPU | correct, just slower — no feature is lost |

Why the split matters, measured on two 6 GB cards: with both engines pinned to one card,
a full reindex had to be serialised because their combined embedding load did not fit the
free memory. Splitting them removed the constraint entirely and both indexed at once, one
card at 100% while the other parsed.

**A resource limit that comes from a placement decision is not a law.** If you find
yourself serialising work, check whether the contention is self-inflicted first.

### Pinning rules

- **Pin per service, never globally.** Exporting a device selection machine-wide renumbers
  devices for *every* CUDA tool on the box. The graph engine takes its device from its
  service unit; the semantic engine from its own config file.
- **Leave the display card room.** If one GPU drives a desktop, prefer the other for the
  heavier model — heavy indexing on the display card costs interactivity.

### CUDA prerequisites

The GPU path needs a matching CUDA runtime **and cuDNN**. Missing cuDNN is the common
failure and it is silent: the provider fails to load and everything falls back to CPU with
only a log line. `lens doctor` reports the truth:

```
CUDA:  ✓ redirected onnxruntime-node to the CUDA 13 build
hot:   RESIDENT (3440 MiB)
```

If you see `hot: NOT resident`, the models are not on the GPU regardless of what the flags
said.

### AMD, Apple, and plain CPU machines

Supported and fully functional. Verified on **AMD Ryzen AI 9 HX 370 (Strix Point,
Radeon 890M + XDNA2 NPU)**, 24 threads, 62 GB RAM, no NVIDIA hardware.

#### Radeon 890M ccc acceleration (ROCm)

ROCm 10's `gfx1150` PyTorch wheel runs ccc's existing
`CodeSearch-ModernBERT-Crow-Plus` model without changing its vector space or retrieval
quality. The same three search checks returned identical top-five results on CPU and GPU.
On this machine:

- full 211-chunk index: **47 s CPU → 26.8 s GPU**;
- warm query latency: effectively tied;
- CPU daemon: **2.00 GiB RAM**;
- ROCm daemon, batch 8 with three repositories warm: **2.57 GiB steady** and **under 3.7 GiB during a full 13,650-chunk reindex**;
- ROCm's default batching used about **0.8 GiB more**; limiting the sentence-transformers
  batch to 8 saved that memory without slowing the index.

The active profile uses PyTorch `2.13.0+rocm10.0.0`, `device: cuda` (PyTorch deliberately
uses the CUDA API name for HIP devices), and a batch-8 wrapper. `lens doctor` reads
`amd-smi`, reports the Radeon target and shared-memory use, and identifies the resident
ccc process. Arch is not AMD's validated distribution, so keep a CPU ccc shim for rollback.

For CPU-only machines, omit `device`; torch selects CPU. Keep `code-lens-warm.timer`
inside ccc's idle timeout so the first question does not pay model-load latency.

The iGPU and NPU remain separate: ROCm runs ccc on the Radeon, while XRT + FastFlowLM
serves gitnexus embeddings on XDNA2. `HSA_OVERRIDE_GFX_VERSION` does not affect XDNA.

#### Strix Point XDNA2 NPU (Arch Linux)

The NPU is useful for gitnexus's optional vector-recall lane without replacing ccc's
better primary recall model. This exact deployment is measured and live:

- kernel `amdxdna` 0.8 · firmware 1.1.2.64 · XRT 2.21.75;
- FastFlowLM **1.0.3+** serving EmbeddingGemma-300M (768 dimensions) at
  `http://127.0.0.1:52625/v1`;
- `/etc/systemd/system/flm-embed.service` runs as the project user with
  `LimitMEMLOCK=infinity`; the NPU otherwise fails at the default 8 MB limit;
- `lens doctor` reports the XDNA device and live endpoint separately from CUDA.

Install the supported Arch userspace (the kernel driver and firmware may already exist):

```bash
sudo pacman -S --needed xrt xrt-plugin-amdxdna fastflowlm
flm pull embed-gemma:300m
flm pull gemma3:1b       # FastFlowLM requires a companion LLM in server mode
flm validate             # run under an unlimited-memlock login/service
flm serve gemma3:1b --embed 1 --host 127.0.0.1 --port 52625
```

Configure the gitnexus server **and its indexing jobs** with the same vector space:

```ini
GITNEXUS_EMBEDDING_URL=http://127.0.0.1:52625/v1
GITNEXUS_EMBEDDING_MODEL=embed-gemma
GITNEXUS_EMBEDDING_API_KEY=flm
GITNEXUS_EMBEDDING_DIMS=768
GITNEXUS_EMBEDDING_HTTP_TIMEOUT_MS=30000
GITNEXUS_EMBEDDING_MAX_ATTEMPTS=4
GITNEXUS_EMBEDDING_RETRY_TIMEOUTS=1
```

Build the structural graph once, then fill vectors directly in the healthy index:

```bash
GITNEXUS_EMBEDDING_DIMS=768 gitnexus analyze --force --index-only <repo>
gitnexus embeddings sync <repo>
```

`embeddings sync` checkpoints every successful batch. If a request still exhausts its
bounded retries, rerun the same command; matching vectors are skipped rather than lost.

Use FastFlowLM 1.0.3 or newer: 1.0.0 stalled on ordinary code strings during a long
index. For a reliable long pass, `GITNEXUS_EMBEDDING_BATCH_SIZE=1` trades throughput
for isolation; four bounded attempts recover after the NPU releases a timed-out lock.

**Do not move ccc to EmbeddingGemma just because it is on the NPU.** On the same 205
code chunks, EmbeddingGemma took 154 s versus 47 s on CPU and 26.8 s on the Radeon for
the code model, and ranked the session-recovery function 7th or missed it;
`CodeSearch-ModernBERT-Crow-Plus` remains the primary semantic model. NPU graph recall supplements it instead of degrading it.

Moving an install between machines: the *config* travels badly even though the code does
not. Re-check the device pin, the service unit paths, and the per-repo indexes — indexes
are machine-local and never move with the checkout.

---

## 4 · Hot-loaded models — and why a service is not enough

A service keeps a *process* alive. It does not keep a *model* loaded.

The semantic engine's daemon **unloads its model after an idle period** (~3 h observed).
So "hot loaded" quietly stops being true, and the next question after the timeout pays a
full cold load. `--hot-load` therefore installs **both**:

1. service units, so the engines survive reboots and restarts, pre-warmed at start; and
2. a **keep-warm timer** that issues a real (trivial) query to each engine on an interval
   below the idle timeout. Only real use resets an idle timer — a health ping does not.

```bash
node bin/lens.mjs install --hot-load --warm-every 60
```

Measured effect: **~2,550 ms cold → ~190 ms warm**, roughly 13×.

---

## 5 · Services installed

| unit | role |
|---|---|
| `code-lens.service` | the hot server (loopback, port 3939) |
| `gitnexus-mcp.service` | graph engine, GPU-pinned, pre-warmed at start |
| `code-lens-warm.timer` | keep-warm, so models do not idle out of GPU memory |

All are **user** services (`systemctl --user`), loopback-bound. The server exposes
repository contents; do not bind it to a routable interface.

---

## 6 · Indexing a repository

Each engine indexes independently, and coverage is per-repo.

```bash
cd /path/to/repo
gitnexus analyze --index-only            # structure: symbols, calls, clusters, flows
gitnexus analyze --index-only --pdg      # + control-flow substrate (enables taint analysis)
ccc init && ccc index                    # semantic recall with the strong model
lens doctor                              # confirm both list the repo
```

### Use `--index-only` in any repo with a live agent

Without it, the graph engine writes an `AGENTS.md`, injects a block into the repo's
instruction file, and installs skill directories. That is **provisioning**, not indexing,
and it changes an agent's instructions underneath it. `--index-only` gives you the full
index and touches nothing else.

Put index artifacts in local-only excludes (`.git/info/exclude`) so a working agent's
`git status` does not change:

```
.gitnexus/
.gitnexusignore
```

### First: does the repo already state its own scope?

Check for a `.gitnexusignore` or existing `include_patterns` **before** setting any. If one
exists, it is the repo's decision and outranks the default below — a code-only scope is
right for an application, and wrong for a repo whose documents are the product.

Note also that `ccc init` appends to the repo's **tracked** `.gitignore`. In a repo someone
else is working in, revert that and use `.git/info/exclude` instead so their `git status`
is unchanged.

### Otherwise: scope the index to code

Index prose and you bury code under it. On one large repo, markdown alone was **29,233 of
87,270 semantic chunks** — and because your query is also prose, a document *describing* a
behaviour outranks the code implementing it, for exactly the questions where you wanted the
code. Use `.gitnexusignore` (graph) and `include_patterns` (semantic) to exclude `*.md`,
`*.txt`, data formats, images and build output.

Note that prose is also structurally inert: the graph cannot parse it into symbols, so a
markdown hit can never carry callers or risk. In the fusion score it is permanently
second-class — but it still consumes recall slots.

---

## 6a · Keeping indexes current

Both engines support incremental updates; nothing triggers them by default. `lens refresh`
is the trigger, installed as a 15-minute timer.

```bash
lens refresh [--repo R] [--graph-only] [--semantic-every MIN] [--dry-run]
```

Cadence follows the measured ~30x cost gap between the engines: the graph delta runs every
cycle (**8-11 s per repo** observed), while the semantic pass is gated to a minimum
interval *and* only runs when the commit has changed.

Three rules it enforces, each learned the hard way:

1. **Never start an index while one is running.** Two passes over one index means whichever
   finishes last decides the contents, and measurements taken from the other describe an
   index that no longer exists.
2. **Reproduce the index's layers.** Re-running `analyze` without the flags the index was
   built with *deletes* the layers those flags produced — a bare re-analyse destroyed a
   169,617-node control-flow substrate with no error, visible only as a smaller number in a
   log line. `refresh` inspects the index and passes the flags that match it.
3. **Scope changes are not deltas.** Changing what is indexed makes previously-excluded
   files "added", so the next pass is a full one. Expect it, and verify the new scope reads
   back from the config *before* launching — an unverified scope change is how a 50-minute
   run ends up building the wrong index.

State lives in `~/.code-lens/refresh-state.json`; a lock file prevents overlapping runs.

## 7 · Verifying a deployment

```bash
lens doctor --parity
```

Confirm four things:

1. **both engines `✓`** — a probe answered, not merely "the binary exists";
2. **`hot: RESIDENT (N MiB)`** for each — models are actually on the GPU;
3. **GPU headroom** — a third service arriving silently is how an out-of-memory failure
   gets discovered mid-sprint;
4. **parity ✓** — every engine capability is enumerable, therefore reachable. This check
   **fails** when an engine gains a capability the lens has not seen.

Then a real query end to end:

```bash
lens ask "how does the gate decide to refuse" --repo <name>
```

A healthy answer names `file:line`, the symbol, and why it ranked (`semantic 0.72 ·
4 callers · risk MEDIUM`). If the structural half is missing, the answer says so.

---

## 8 · Wiring agents to it

Register the MCP surface once; agents then have **four** tools instead of twenty-six:

```json
{ "mcpServers": { "code-lens": {
    "command": "node",
    "args": ["/path/to/code-lens/bin/lens.mjs", "mcp"],
    "env": { "CUDA_VISIBLE_DEVICES": "1", "GITNEXUS_EMBEDDING_DEVICE": "cuda" } } } }
```

**Unregister the engines individually.** Leaving them announced alongside the router
recreates the problem code-lens exists to solve: an agent choosing between a similarity
engine and a graph engine, badly. Everything they can do stays reachable through
`lens_graph` and `lens_semantic`.

The same applies to instruction files and skills: name **code-lens**, not the engines. An
instruction that says `impact({target: ...})` binds a repo to an engine and quietly defeats
the router.

---

## 8a · Argument signatures for passthrough

Graph tools **exit rc=0 on a wrong argument name**, returning instantly with an empty or
error-shaped payload. A benchmark or agent reads that as a fast success, which is how a
working tool gets reported as broken. Correct names:

| tool | required argument |
|---|---|
| `query` | `search_query` |
| `cypher` | `statement` (or `query`, build-dependent — check `tools/list`) |
| `context` | `name` |
| `trace` | `from` **and** `to` |
| `impact` | `target` |
| `pdg_query` | `mode` **and** `target` |
| `api_impact` | `route` or `file` |

When a passthrough call returns suspiciously fast with nothing useful, check the argument
name before concluding the tool is broken.

## 9 · Troubleshooting

| symptom | cause | fix |
|---|---|---|
| `hot: NOT resident` | cuDNN missing, or keep-warm interval exceeds the idle timeout | install cuDNN; lower `--warm-every` |
| answers take ~2.5 s | the hot server is not running; the CLI fell back in-process | `systemctl --user status code-lens` |
| `structure unavailable: no index for X` | the graph has not indexed that repo | `gitnexus analyze --index-only` there |
| `DEGRADED: recall came from the weaker model` | the semantic engine has no index for that repo | `ccc init && ccc index` there |
| `Multiple repositories indexed` | more than one repo indexed and none named | pass `--repo <name>` |
| a full rebuild finishes suspiciously fast | `analyze --force` does **not** rebuild a current index | `gitnexus clean --force` first |
| duplicate-key error while embedding | `--drop-embeddings` and `--embeddings` in one run | run them as separate steps |
| semantic `grep` returns nothing, always | that subcommand needs an unreleased dependency and fails as a **silent false negative** | use a literal searcher instead |
