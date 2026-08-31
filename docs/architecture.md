# Architecture

## The problem this shape solves

Recall and consequence live in different engines, and neither can produce "the spots that
matter" alone:

- **Recall** (semantic search) proposes candidate locations from a vague description. It
  has no way to rank them by what they cost to change.
- **Consequence** (the knowledge graph) knows callers, flow membership and blast radius,
  but needs an anchor to start from.

So the composition is **not** "run both, concatenate". It is two-stage retrieval: recall
proposes, structure disposes.

## Stages

```
question
   │
   ├─ route()            deterministic intent classification (src/core/router.ts)
   │
   ├─ SEED               semantic engine: top-K candidates with relevance
   │                     (falls back to the graph's weaker model, marked DEGRADED)
   │
   ├─ coverage check     does the graph even index this repo? one cheap lookup
   │                     instead of one timeout per candidate
   │
   ├─ EXPAND             graph engine: callers, callees, flows, risk per candidate
   │                     time-boxed at 8 s per symbol, run concurrently
   │
   ├─ fuse()             weighted product ranking (src/core/fuse.ts)
   │
   └─ render()           budgeted output, elision stated
```

## Routing table

The router is patterns and shape, **never a model call** — an inference-priced router has
already lost the latency argument it exists to win.

| question shape | intent | seed | expand | hops |
|---|---|---|---|---|
| bare symbol or `file.ts:42` | `breaks` | no | yes | 2 |
| "what breaks / blast radius / safe to change / who calls" | `breaks` | no | yes | 2 |
| "review this diff / what did I change" | `diff` | yes | yes | 1 |
| "already exists / duplicate / do we have" | `dupe` | yes | yes | 1 |
| "why / fail / error / broken / refuses" | `why` | yes | yes | 2 |
| "rename / extract / split / move / refactor" | `refactor` | yes | yes | 2 |
| anything else | `locate` | yes | yes | 1 |

An anchor skips recall entirely: embedding a symbol name to find the symbol you already
named is latency without information.

## The fusion score

```
score = relevance^α · (1 + centrality)^β · (1 + risk)^γ
```

Defaults: α 1.0, β 0.6, γ 0.4.

- **relevance** — similarity from the strong code model, 0–1.
- **centrality** — `1 − e^−((callers + flows) / 6)`. Saturating on purpose: the gap between
  0 and 5 callers matters far more than between 40 and 45, so a hub cannot win on degree
  alone.
- **risk** — the graph's blast-radius class, mapped LOW 0 → CRITICAL 1.

It is a **product**, not a sum, so a candidate with no consequence cannot be rescued by
wording alone — which is exactly how similarity-only search surfaces dead code.

Every spot lists the signals that produced its rank. An unexplained ranking is an
unauditable one.

## Output contract

```
SPOTS (3 of 17, budget 600 tok)
1. src/gate/decide.ts:2841  evaluateGate
   why: semantic 0.81 · 11 callers · on 4 flows · risk HIGH
   breaks: checkout, refund, audit-log, retry-queue
NOT SHOWN: 14 lower-ranked spots (--all to list)
```

Three rules:

1. **Every spot is `file:line` + why + consequence.** Never a bare path; never a dump the
   caller has to re-read.
2. **Elision is visible.** Silent truncation reads as completeness — that is how an agent
   concludes it has seen everything when it has seen three of seventeen.
3. **Machine twin.** `--json` for programmatic use; prose for a context window.

## Degradation is stated, never silent

A lens that quietly answers from half its inputs is worse than one that refuses. Every
partial answer names what was missing:

| situation | reported as |
|---|---|
| semantic engine has no index for this repo | `DEGRADED: recall came from the graph engine's weaker model` |
| graph has no index for this repo | `structure unavailable: … — run: gitnexus analyze` |
| candidates are flows, not symbols | `flow-level results: no symbol anchors to expand` |
| an engine is down | named in the note with its error |

## Roadmap

| component | state | why it matters |
|---|---|---|
| CLI, router, fuser, adapters, doctor, installer | **built** | the working core |
| `lens serve` — hot server | **built** | engines stay connected; CLI prefers it, falls back silently |
| MCP surface (`lens mcp`) | **built** | four tools, so agents cannot pick the wrong engine |
| Three hooks | not built | the behaviour change — see [coexistence.md](coexistence.md) |
| `dupe` / `rename` as first-class verbs | routed forms only | the duplicate-detection seam neither engine covers today |

### The MCP surface — why four tools and not twenty-six

| tool | purpose |
|---|---|
| `lens_ask` | the routed, fused answer — "use this instead of grep" |
| `lens_breaks` | blast radius before an edit |
| `lens_graph` | passthrough to any of the 17 graph tools |
| `lens_semantic` | passthrough to any of the 9 semantic commands |

Exposing all 26 to an agent recreates exactly the problem code-lens exists to solve: a
choice it makes badly. Two routed tools carry the common path; two passthroughs preserve
parity for the rest.

### Where the shared pipeline lives

`src/core/ask.ts` is the single implementation of route → seed → coverage-check → expand →
fuse. The CLI, the hot server and the MCP surface all call it. Three copies would drift,
and the copy that drifts is always the one an agent is actually using.
