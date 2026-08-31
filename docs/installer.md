# The installer — placing both engines

```bash
git clone https://github.com/panbergco/pi-code-lens.git
cd pi-code-lens
npm install && npm run build
pi install .
node bin/lens.mjs install --hot-load [--npu] [--gpu N] [--warm-every MIN] [--dry-run]
```

This is the complete install path: the pi package supplies the native tools and bundled
`pi-code-lens` skill; `lens install` installs **GitNexus and cocoindex-code (`ccc`)**, detects
the available accelerator, installs a compatible model runtime, writes both services, and
proves the result. The engines remain independently usable — nothing here forks them.

Hardware selection is automatic:

| detected hardware | ccc semantic model | GitNexus embeddings |
|---|---|---|
| NVIDIA CUDA | `CodeSearch-ModernBERT-Crow-Plus` on the selected CUDA device | CUDA |
| AMD ROCm target such as `gfx1150` | same model in a target-specific ROCm PyTorch environment | CPU, or XDNA2 with `--npu` |
| no installable GPU runtime | same model on CPU | CPU |

**Licence note before you run it:** this installs GitNexus, which is licensed PolyForm
Noncommercial 1.0.0 — free for personal, research and evaluation use, not for commercial
use without a grant from its authors. The semantic engine it installs alongside is
Apache-2.0. See [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).

Prerequisites are Node 22+, npm, and `uv`; AMD acceleration also needs a working `/dev/kfd`.
The detector uses `rocm-bootstrap-detect`; it does not guess from the display-adapter name.
Unsupported targets fall back to CPU instead of installing an incompatible wheel.

## Why an installer at all

Both engines have install traps that cost real time to discover. They are encoded here so
nobody rediscovers them:

| trap | what happens | what the installer does |
|---|---|---|
| Global npm prefix | `npm i -g` targets `/usr/lib` and fails with `EACCES` without root | installs to a **user prefix** |
| npm 11 + npx | crashes mid-install (`Cannot destructure property 'package'`) before the package runs | installs globally, never via npx |
| Vendored grammars | four extra language grammars add minutes and need a C++ toolchain | sets `GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1` |
| Unpinned `mcp` | resolves to 2.x, which dropped the module the semantic engine's MCP mode imports; **the CLI keeps working, so the break is easy to miss** | pins `--with 'mcp<2'` |
| Missing cuDNN | the CUDA provider fails to load and silently falls back to CPU | rejected by `ccc doctor` and reported by `lens doctor` |
| CUDA PyTorch on AMD | ccc imports successfully but sees no usable GPU | installs ROCm PyTorch for the detected `gfx*` target |
| Oversized AMD batches | shared-memory use grows without improving throughput | caps sentence-transformers batches at 8; measured saving ~0.8 GiB on `gfx1150` |

## The four steps

1. **Engines** — installs GitNexus and ccc. AMD receives a target-specific ROCm wheel;
   NVIDIA and CPU use ccc's standard distribution.
2. **Accelerator** — writes ccc's model/device configuration and assigns GitNexus to CUDA,
   CPU, or the optional NPU endpoint. Device selection is never exported globally.
3. **Services** — writes user units, refresh timers, and optional keep-warm timers.
4. **Verify** — runs `gitnexus --version`, `ccc doctor` (which downloads and executes the
   selected model), and `lens doctor --parity`. Installation fails if any probe fails.

## Hot-load: what it actually fixes

Resident-now is not resident-later.

- The **graph engine** runs as a supervised server; its model stays loaded for the
  process's life. Pre-warmed at start.
- The **semantic engine** ships a daemon that **unloads its model after an idle period**
  (observed ~3 hours). Without intervention, "hot loaded" quietly stops being true and the
  next question pays a full cold load.

So `--hot-load` also installs a **keep-warm timer** that issues a real (trivial) query to
each engine on an interval below that idle timeout. Only real use resets an idle timer, so
a ping must be a genuine query. Failures are silent by design — this runs unattended and
must not fill the journal while a repo is mid-reindex.

```bash
node bin/lens.mjs install --hot-load --gpu 1 --warm-every 60
```

Without a GPU the installer says so plainly and configures CPU operation — correct, just
slower. `--hot-load` still keeps the CPU model warm; acceleration and residency are
separate choices.

## XDNA2 NPU graph embeddings

On Ryzen AI systems, `--npu` sends GitNexus graph embeddings to FastFlowLM's local
EmbeddingGemma endpoint. ccc independently uses the Radeon through ROCm when its target is
supported, otherwise CPU:

```bash
sudo pacman -S --needed xrt xrt-plugin-amdxdna fastflowlm
node bin/lens.mjs install --npu --hot-load
```

The installer verifies `/dev/accel/accel0`, downloads `embed-gemma:300m` plus the required
`gemma3:1b` companion, and either reuses a live endpoint on port 52625 or creates a user
`flm-embed.service`. The service requires an unlimited memlock hard limit; on systems
still capped at 8 MB, apply the PAM/systemd limits described in `deployment.md` and log
in again.

GitNexus receives the same 768-dimension endpoint settings in both its query service and
the refresh service. One-item batches plus three bounded timeout retries favor reliable,
checkpointable indexing over peak throughput.

## What it writes

| path | purpose |
|---|---|
| `~/.local/share/uv/tools/cocoindex-code-rocm/` | target-specific AMD ccc runtime, only on supported ROCm hardware |
| `~/.local/bin/lens` | CLI entry point linked to this package checkout |
| `~/.local/bin/ccc` | ccc entry point; points at the detected runtime |
| `~/.config/systemd/user/gitnexus-mcp.service` | graph server; CUDA-pinned, CPU, or NPU-endpoint configured |
| `~/.config/systemd/user/flm-embed.service` | FastFlowLM NPU server when `--npu` cannot reuse one already running |
| `~/.config/systemd/user/code-lens-warm.{service,timer}` | keep-warm, only with `--hot-load` |
| `~/.config/systemd/user/code-lens-refresh.{service,timer}` | incremental index refresh; inherits the NPU endpoint when selected |
| `~/.cocoindex_code/global_settings.yml` | semantic engine's model + device (curated — edited surgically, never rewritten) |

Nothing is written into indexed repositories except each engine's own gitignored index.
The pi package also exposes the bundled `pi-code-lens` skill and announces its four tools
through `promptSnippet`, `promptGuidelines`, and a per-turn fallback that survives a
replaced system prompt. Restart existing pi sessions after installing or updating the
package so startup discovery includes the skill.

For repositories where indexed navigation is required, put this line in `AGENTS.md`:

```markdown
**Before any code search or edit, load and follow the packaged `pi-code-lens` skill; its locate → blast-radius → change-review sequence is mandatory.**
```

## Verifying

```
$ lens doctor --parity
Engines
  ✓ semantic  Chunks: 87270
      model:  Shuu12121/CodeSearch-ModernBERT-Crow-Plus  device: cuda:1
      hot:    RESIDENT (3440 MiB)
  ✓ graph     17 tools
      hot:    RESIDENT (282 MiB)
GPU
  GPU 1: 3759/6138 MiB used  (2379 MiB headroom)
Parity
  ✓ 26 engine capabilities reachable (graph 17, semantic 9) + 5 routed verbs
```

`hot: NOT resident` is the signal that the keep-warm is missing or the timer interval
exceeds the engine's idle timeout.

### Searches answer themselves

The extension hooks every `grep`, `find`, `read` and shell search, reads what it was looking
for, and appends what the index knows about that subject — so the engines pay off without
anyone choosing a tool. Rules that keep it honest:

- **silent unless it adds structure.** A purely textual match is dropped: the search already
  showed those lines;
- **one subject per search, best first**, asked sequentially. Three in parallel was measured
  at 6-second timeouts because the graph engine serialises on its session; one at a time
  answers in ~120 ms;
- **caps**: 220 tokens and a 6-second budget SHARED across subjects, so a second answer
  appears only while there is room and never at the cost of the first; per-session caches
  so a subject is answered once and a subject with no answer is not retried;
- **only certain rejections are made without asking**: language keywords, shell nouns and
  English that no index will hold a symbol for. It does NOT guess from word shape — that
  rule threw away the best subjects in the repository (`sprint`, 13 callers; `tick`, 15;
  `store`, 62), so the index itself decides, at ~40 ms a question;
- **a name that matches many nodes is resolved, not abandoned** — preferring something that
  can have callers, and shipped code over tests or generated fixtures;
- **an answer is repeated after 30 minutes** (`repeatAfterMinutes`). Sessions here run for
  days, so "already said" wears off long before the session ends;
- `/lens augment off` disables it, **and the choice is remembered** in
  `~/.code-lens/settings.json` (`augment`, `maxSubjects`, `budgetTokens`, `timeoutMs`;
  out-of-range values are clamped, a corrupt file falls back to defaults);
- `/lens` reports how many searches were answered, and the caps in force;
- `LENS_AUGMENT_DEBUG=/path/to/log` records why each search was or was not answered.

### One engine configuration, in one file

`~/.code-lens/engine-env` (`KEY=VALUE` lines) is read by the refresh timer AND by `lens
refresh` run by hand. It exists because an index carrying embeddings records how they were
made: reach it with a different endpoint and the engine refuses the **whole** rebuild, not
just the vectors. Keeping that configuration inside a service unit meant a refresh by hand
could never succeed. Variables already set in the environment always win.

### Verifying by hand inside a session

`/lens <verb>` runs the read-only CLI verbs through the same engine clients the tools use,
and its verbs complete as you type: `status ask breaks spots dupe diff graph semantic caps
doctor refresh`. Use it to prove the engines answer without spending a model turn — for
example `/lens caps`, `/lens breaks <symbol>`, or `/lens doctor`. `install`, `serve` and
`mcp` are absent on purpose: a chat session must not start or supervise services.

### Verifying that pi actually announces the tools

Measured in a live session rather than assumed:

- with pi's default system prompt, all four tools appear under `Available tools`
  (`- lens_ask: …`) and their rules under `Guidelines`, and the per-turn fallback stays
  silent so nothing is said twice;
- with `--system-prompt` replacing that prompt, both sections disappear and the fallback
  block `### pi-code-lens tool rules` is present in the provider payload instead.

The guard is anchored to pi's own announcement line, not to any mention of `lens_ask`;
an `AGENTS.md` that merely names the tools does not suppress it.
