# pi-code-lens

**code-lens as a native [pi](https://pi.dev) extension.** One surface over two
code-intelligence engines: semantic recall proposes; the knowledge graph disposes.

## Requirements — two engines, installed separately

**pi-code-lens is a client, not the engines.** Nothing works until both
code-intelligence engines are installed and running on the machine — they are
external processes, deliberately not npm dependencies of this package:

| Engine | Package | Install |
|---|---|---|
| Knowledge graph | [gitnexus](https://www.npmjs.com/package/gitnexus) | installed by `lens install` |
| Semantic recall | [cocoindex-code](https://pypi.org/project/cocoindex-code/) (`ccc`) | installed by `lens install` with the detected CPU/CUDA/ROCm runtime |

**No NVIDIA card? Nothing is lost.** Both engines run on CPU. On AMD Strix Point
(Ryzen AI 9 HX 370), ccc can run its unchanged code-specialised model on the Radeon 890M
through ROCm, while the XDNA2 NPU serves gitnexus's EmbeddingGemma vectors. The measured
ROCm profile indexes 1.75× faster than CPU and costs about 0.57 GiB more steady RAM; see
[docs/deployment.md § AMD, Apple, and plain CPU machines](docs/deployment.md).

Easiest path — install the pi package, then let its installer place both engines and
select a runtime from the actual hardware rather than a copied device name:

```bash
git clone https://github.com/panbergco/pi-code-lens.git && cd pi-code-lens
npm install && npm run build
pi install .
node bin/lens.mjs install --hot-load          # auto: CPU, NVIDIA CUDA, or AMD ROCm
node bin/lens.mjs install --hot-load --npu    # Ryzen AI: Radeon ccc + XDNA2 GitNexus vectors
# install runs both model/device probes and lens doctor --parity
```

Without the engines, the pi tools and CLI degrade with named notes (they never
crash) — but every answer will say the engine is unreachable. Each repository
also needs one-time indexing (`gitnexus analyze` in the repo; the pi extension
detects missing/stale indexes and says exactly what to run).

## Pi integration

```bash
pi install git:github.com/panbergco/pi-code-lens
```

Pi gets four first-class tools — `lens_ask`, `lens_breaks`, `lens_graph`,
`lens_semantic` — registered natively via `pi.registerTool()` (no MCP, which pi
deliberately does not ship), plus the bundled `pi-code-lens` skill and a `/lens` command
that completes its verbs — `status ask breaks spots dupe diff graph semantic caps doctor
refresh` — so a person can drive the engines by hand and see they answer, without spending
a model turn. Service verbs (`install`, `serve`, `mcp`) stay on the CLI: a chat session has
no business starting daemons. The skill
requires semantic location before broad search, blast-radius review before edits, and
structural change review before commit.

**Searches answer themselves.** Announcement does not produce use — pi's own docs say a
model *"doesn't always"* load a skill, and measured here: one session with all four tools
announced, the skill loaded and the instruction in its prompt ran **28 shell searches and
called the index zero times**. So the lens stops waiting to be called: a `grep`, `find`,
`read` or shell search comes back with what the index knows about its subject appended —
definition, callers, risk — through the same routed pipeline the tools use, so recall and
structure both answer. It stays silent unless it can say something the search could not — callers, flows or risk,
never a restatement of the text already on screen — and generic words never reach a lookup
at all. `/lens augment off` turns it off, and remembers. Pattern adapted from
[pi-gitnexus](https://github.com/tintinweb/pi-gitnexus) (MIT), which proved it for one engine.

**Measured on one active repository in one day: 3 tool calls made by agents, 462 answers
delivered by enrichment.**

**The tools also announce themselves three ways, so they are never idle by accident:** each
carries a `promptSnippet` (one line in the system prompt's *Available tools*) and
`promptGuidelines` (bullets in *Guidelines*); the skill description names the situations
that should trigger it; and a `before_agent_start` hook re-states the rule when a replaced
system prompt would otherwise drop both. Restart existing pi sessions after installation so
startup discovery includes the skill.

**Client-only by design.** The extension never boots, installs or supervises an
engine. It prefers the hot server (`:3939`) and falls back to the in-process
pipeline, whose engine adapters are themselves thin clients (graph over
MCP-HTTP `:3737`, semantic via the `ccc` CLI against its daemon). One shared
warm service serves every harness — pi, Claude Code, the CLI — with identical
answers. Measured from pi: **204 ms** for a fused 12-spot answer through the
warm service.

Everything below is the underlying engine surface, unchanged — the CLI still
works exactly as before.

---

An agent about to edit code has one real question — *which spots matter, and what breaks
if I touch them?* Neither available engine answers it alone:

- **Semantic search** finds candidates from a prose description, but cannot see a
  dependency. A match in a dead branch outranks a hub function if the words line up better.
- **The knowledge graph** knows callers, flows and blast radius, but cannot find a starting
  point from prose.

Handing an agent both is handing it a choice it makes badly. code-lens routes the question,
runs the stages that fit it, and returns one ranked, budgeted answer.

```
question ─▶ router ─┬─▶ SEED   (semantic engine: recall, strong code model)
                    └─▶ EXPAND (graph engine: callers, flows, risk)
                             └─▶ FUSE + RANK ─▶ budgeted answer
```

## Install

```bash
npm install && npm run build
node bin/lens.mjs install --hot-load             # installs GitNexus + ccc; detects CPU/CUDA/ROCm
node bin/lens.mjs install --hot-load --npu       # optional XDNA2 graph embeddings
node bin/lens.mjs doctor --parity                # prove binaries, model/device, and parity
```

`install` places both external engines, writes ccc's compatible model/device configuration,
supervises the services, and keeps models resident. See
[docs/installer.md](docs/installer.md).

## Use

```bash
lens ask "how does the gate decide to refuse"   # routed, fused, ranked
lens breaks emitEvent                               # blast radius only
lens diff --base main                               # changed symbols + related code
lens dupe src/new-thing.ts                          # "does this already exist?"

lens graph impact --target emitEvent                # passthrough: any graph tool
lens semantic search "retry policy" --limit 5       # passthrough: any semantic command
lens caps                                           # everything reachable
```

## Two layers, so nothing is lost

| layer | what | why |
|---|---|---|
| **Routed** — `ask spots breaks diff dupe` | fused fast path | the value-add: ranked by consequence, budgeted |
| **Passthrough** — `graph <tool>`, `semantic <cmd>` | mechanical forwarding to all 26 engine capabilities | adopting code-lens costs you nothing you had |

Parity is enforced, not claimed: `lens doctor --parity` enumerates both engines live and
**fails if either becomes unenumerable**. A parity check that cannot fail is decoration.

**Verified by invocation, not assertion:** all **26 of 26** engine capabilities were called
through the lens and reached their engine — 15 graph tools and 4 semantic commands invoked
live; the 7 destructive ones (`rename`, `group_sync`, `init`, `index`, `reset`, `mcp`,
`daemon`) confirmed forwardable by construction, since passthrough dispatches by name with
no allow-list. Zero parity breaks.

## Measured

| | |
|---|---|
| Fused answer, both engines warm | **~440 ms** |
| Same query with a cold engine process | ~2,550 ms |
| Structural stage against an unindexed repo — before the coverage check | 8,300 ms |
| …same, after | **442 ms**, with the gap named |
| Category error (expanding flow ids as symbols) — before the fix | 120,365 ms |

Latency is the product. Every design rule here exists to protect it: engines are
long-lived services, the CLI loads no model, the router never calls a model, and every
structural lookup is time-boxed.

## Documentation

| doc | covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | stages, routing table, fusion score, output contract |
| [docs/claude-md-block.md](docs/claude-md-block.md) | copy-paste instruction block for a project's CLAUDE.md |
| [docs/deployment.md](docs/deployment.md) | **start here** — prerequisites, install, GPU policy, services, indexing, verification, troubleshooting |
| [docs/installer.md](docs/installer.md) | how both engines are placed, GPU hot-load, keep-warm |
| [docs/engines.md](docs/engines.md) | the two engines, their models, what each is good at |
| [docs/parity.md](docs/parity.md) | the 100%-coverage requirement and how it is enforced |
| [docs/coexistence.md](docs/coexistence.md) | living beside a framework that owns the same hooks |
| [docs/decisions.md](docs/decisions.md) | design rulings and the measurements behind them |

## Status

**Working:** `doctor`, `install`, `caps`, `ask`, `diff`, `serve`, `mcp`, both passthrough
layers, routing, fusion, budgeted output, coverage checks, degraded-mode reporting.

- **Hot server** — `lens serve`, a user service on 127.0.0.1:3939. Holds both engines'
  connections open and pre-warms at boot; the CLI prefers it and falls back in-process
  silently when it is absent.
- **MCP surface** — `lens mcp` exposes **four** tools, not twenty-six: `lens_ask`,
  `lens_breaks`, and the two passthroughs. An agent asked to choose between a similarity
  engine and a graph engine chooses badly, so `lens_ask` takes the question and decides.

**Not built yet:** the three hooks, and `dupe`/`rename` as first-class verbs rather than
routed `ask` forms. See [docs/architecture.md](docs/architecture.md) § Roadmap.

## Services installed

| unit | role |
|---|---|
| `code-lens.service` | the hot server |
| `gitnexus-mcp.service` | graph engine, GPU-pinned, pre-warmed |
| `code-lens-warm.timer` | keep-warm, so models do not idle out of GPU memory |

## Licence

pi-code-lens itself is **MIT** ([LICENSE](LICENSE)) and bundles no third-party code.

**The engines are separate programs with their own terms, and one of them matters:
GitNexus — the knowledge-graph half the installer places for you — is licensed
PolyForm Noncommercial 1.0.0, so commercial use of that engine needs a grant from its
authors.** The semantic half (`ccc`) is Apache-2.0 and unrestricted; with the graph engine
absent the lens degrades with a named note rather than failing. Full component list, model
terms and attribution: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
