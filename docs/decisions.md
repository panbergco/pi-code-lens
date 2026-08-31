# Design decisions

Each entry records the ruling and the measurement or observation behind it. Where a
decision came from a bug, the bug is named — a decision whose reason is forgotten gets
reverted by the next person who finds it inconvenient.

---

## D-01 — Two engines stay separate; code-lens routes, never reimplements

**Ruling.** Both engines remain independently installed, independently usable, reached
through adapters.

**Why.** Their value is in their indexes and models, not their surfaces. Forking either
would mean maintaining a code parser and an embedding pipeline to gain nothing. A third
engine is a new adapter, not a fork.

---

## D-02 — Recall proposes, structure disposes — a product, not a sum

**Ruling.** `score = relevance^α · (1+centrality)^β · (1+risk)^γ`.

**Why.** A sum lets pure wording similarity carry a candidate with no consequence, which
is precisely how similarity-only search surfaces dead code. A product cannot: zero
consequence caps the score no matter how well the words match. Centrality saturates
(`1 − e^−n/6`) so a hub cannot win on raw degree.

---

## D-03 — The router is deterministic

**Ruling.** Intent classification is patterns and input shape. Never a model call.

**Why.** The product is a ~200 ms answer. An inference-priced router loses the argument it
exists to win. Cost of the ruling: some questions route imperfectly — acceptable, since
every answer states the intent it chose and why.

---

## D-04 — Engines are always-on services with GPU-resident models

**Ruling.** Never spawn an engine per call. Supervise both; pre-warm at start.

**Why (measured).** Cold engine process ~2,550 ms; warm ~190 ms — **13×**. The entire
latency case for code-lens rests on this.

---

## D-05 — Hot-load requires a keep-warm, not just a service

**Ruling.** `--hot-load` installs a timer that issues a real query to each engine below its
idle timeout.

**Why (observed).** The semantic engine's daemon unloads its model after an idle period
(~3 h). Resident-now is not resident-later: without the timer, "hot loaded" quietly stops
being true and the next question pays a full cold load. Only real use resets an idle timer,
so the ping must be a genuine query.

---

## D-06 — GPU pinning is per-service, never global

**Ruling.** Device selection lives in each service's environment and in the semantic
engine's own config. Never exported machine-wide.

**Why.** A global device selection renumbers devices for every other CUDA tool on the
machine, silently changing where unrelated work runs.

---

## D-07 — Parity by generated passthrough, enforced by a failing check

**Ruling.** Two layers: routed fast path plus mechanical forwarding of all 26 engine
capabilities. `lens doctor --parity` fails when an engine cannot be enumerated.

**Why.** Folding 26 capabilities into clever verbs would delete the specialised ones while
looking tidy. And a parity claim that cannot fail is decoration — this one is wired to an
exit code.

---

## D-08 — Never expand flow ids as symbols

**Ruling.** Only symbol-level candidates enter the structural stage.

**Why (bug, measured).** When the semantic engine has no index for a repo, the fallback
returns execution *flows*. Asking the graph for symbol context on a flow id is a category
error: one round trip per candidate, nothing returned. It turned a sub-second answer into
**120,365 ms**. Fixed by filtering candidates by source and shape; every structural lookup
is additionally time-boxed at 8 s.

---

## D-09 — Check coverage before expanding

**Ruling.** One `list_repos` lookup decides whether the structural stage runs at all.

**Why (measured).** Expanding against an engine that has never indexed the repo cost
**8,327 ms** of parallel timeouts and returned nothing. With the check: **442 ms**, and the
answer names the gap plus the command that closes it.

---

## D-10 — Degradation is always stated

**Ruling.** Any partial answer names what was missing and why.

**Why.** A lens that silently answers from half its inputs is worse than one that refuses,
because the caller cannot tell the difference between "nothing there" and "the half that
would have found it was not consulted".

---

## D-11 — Parse the leading balanced JSON, not the whole block

**Ruling.** The graph adapter extracts the first balanced JSON value from a tool result.

**Why (bug).** Tool results are JSON followed by a human-facing markdown hint, so strict
parsing fails on **every** call — silently degrading every structural answer to an opaque
string. Discovered only because a fused query returned zero spots while the same call
through passthrough looked fine.

---

## D-12 — `repo` means different things to the two engines

**Ruling.** Reconciled once, in the semantic adapter: a name is resolved to a directory if
one exists, otherwise the current directory is used.

**Why (bug).** The graph takes a repo *name* (its server holds many indexes); the semantic
CLI is *cwd-scoped*. Passing a name through as a working directory made every semantic
query fail with `ENOENT` — which surfaced as "recall unavailable", pointing at the wrong
component entirely.

---

## D-22 — A repo's own scope config outranks the default

**Ruling.** Before indexing a repository, read any scope config it already carries
(`.gitnexusignore`, the semantic engine's `include_patterns`). If one exists, it is the
decision — do not replace it with the standard scope.

**Why (incident).** A code-only scope is right for an application repo, where prose buries
code in recall. It is wrong for a repo whose *documents are the product*. One target
already had a tracked `.gitnexusignore` carrying 32 lines of documented reasoning —
"1,240 files, of which 180 are source… **Kept**: the instrument and its harnesses, mission,
roadmap, decisions, research, docs" — and it was overwritten with the generic scope without
being read.

**What makes this its own rule** rather than a special case of "read before overwriting":
the config was *tracked in git and explicitly reasoned*, which is as loud as a repository
can be about a decision. A default applied over a stated decision is not a default, it is
an override.

**Also:** `ccc init` appends to the repo's **tracked** `.gitignore`. In a repo being worked
by someone else that is an unrequested change to their tree — revert it and use
`.git/info/exclude` instead.

---

## D-20 — A refresh must reproduce the index's LAYERS, not just re-run analyze

**Ruling.** `lens refresh` inspects the index for which analysis layers it carries
(control-flow substrate, embeddings) and passes the flags that rebuild them.

**Why (incident).** The first version ran a bare `analyze --index-only`. Because the
control-flow substrate is opt-in via `--pdg`, re-analysing without it **deleted 169,617
basic blocks** — the entire layer that taint analysis depends on, six minutes of GPU work,
gone. Embeddings survived only because they are preserved by default.

**What makes this dangerous is the symptom.** There was no error, no warning. The only
visible sign was a node count in a log line that was smaller than before, and it was caught
by arithmetic (218,160 − 169,617 = 48,543 exactly), not by any check. A maintenance job
that silently degrades the thing it maintains is worse than one that fails loudly.

**The general rule.** Any automated re-run must reproduce the configuration of what it is
replacing. "Re-run the build command" is not a refresh unless the command is the same one.

---

## D-21 — Never start an index while one is running

**Ruling.** `refresh` checks for a live indexing process first and refuses.

**Why.** Killing a parent script left its indexer child alive; a second run was then
launched over the same index. Both completed, and whichever finished last decided the
contents — so a measurement taken from one run described an index that the other had
replaced. Verified working: the guard refused a refresh while a pass was live.

---

## D-19 — The graph engine is usable WITHOUT embeddings

**Ruling.** Embeddings are optional for the graph engine, and skipping them on a large repo
is a legitimate configuration rather than a degraded one.

**Why (corrected after being asserted wrongly).** Its search is hybrid: BM25 keyword
retrieval fused with vector similarity by reciprocal rank fusion. With no embeddings it
runs BM25 alone — which found the correct function on a 218,160-node index with zero
embeddings, first try. An earlier note in this file claimed such a repo had "no recall at
all"; that was inference from the model specs, never tested, and false.

**The bug it hid.** The adapter read only the `processes` array from `query` results. On an
embedding-free index that array is empty and the hits sit in `definitions`, so the fallback
returned nothing and presented as "the graph found no match" — the exact opposite of the
truth. Fixed by reading all three result arrays, symbol-level first.

**The lesson.** An untested claim about a dependency's behaviour will eventually be encoded
as a code path. This one was: the false belief that the fallback could not work made the
empty result look expected instead of wrong.

---

## D-14 — Join semantic hits to the graph BY LOCATION, never by guessed name

**Ruling.** `expandByLocation` resolves candidates in one query: `filePath` plus a line
inside `[startLine, endLine]` gives the enclosing function and its caller count.

**Why (bug, measured).** A semantic engine returns *chunks*. Inferring a symbol name from
chunk text yields local variables — `decision`, `step`, `results` — which the graph has
never heard of, so every structural lookup missed and every answer arrived with no
consequence signal at all. A chunk's file and line are **facts**; its symbol name is an
inference. On `a large TypeScript monorepo`, `workflow-runner.ts:163` resolves to
`runWorkflow(58–233)` with 4 callers. Result: 8,625 ms with no signals → **579 ms**
with symbols, caller counts and risk.

**Corollary.** Name-based expansion now runs only for candidates with *no line to join
on*. Running it for line-carrying candidates meant every chunk with no function in the
graph (tests, generated code) burned a lookup timeout — 8.5 s of an 8.6 s response.

---

## D-15 — One spot per symbol

**Ruling.** Candidates collapse per `file:symbol` when a symbol is known.

**Why.** Four chunks of one function are one place to look. Listing it four times spends
the caller's budget making them re-read the same answer — 12 spots became 7 distinct ones
on the same query.

---

## D-16 — Index-only in any repo with a live agent

**Ruling.** Provisioning a repo that is being actively worked uses `--index-only`: no
`AGENTS.md`, no instruction-file block, no skill injection. Index artifacts go in
**local-only** git excludes.

**Why.** Coverage and provisioning are different things. `a large TypeScript monorepo` was indexed
while an agent was mid-sprint with 39 dirty files; after a 40,549-node index its
`git status` was still exactly 39 files. Changing an agent's instructions underneath it is
a behaviour change nobody asked for, and it is not needed to make the lens work.

---

## D-17 — Cutover removes the plain surface, keeps the engine

**Ruling.** The semantic engine's direct agent registration was removed; its daemon, model
and index stay and are reached through `lens_semantic`.

**Why.** The point of one surface is that an agent cannot pick the wrong engine — but the
engine itself is load-bearing, since it owns the strong model that does recall. Removing
the *registration* achieves the first without touching the second. Verified after cutover:
passthrough still returns real results.

---

## D-18 — One GPU per engine; index in parallel

**Ruling.** Each engine is bound to its own card — graph on GPU 0, semantic on GPU 1 —
and full reindexes run **concurrently**.

**Supersedes an earlier ruling in this file** that said to index sequentially. That ruling
was correct about the risk and wrong about the cause: both engines were pinned to the same
card, so their combined embedding load did not fit in its ~2.4 GB of headroom. Serialising
them treated the symptom. Splitting the cards dissolves the constraint entirely — the two
models are independent, neither saturates a card alone, and wall-clock roughly halves.

**Why it is safe.** GPU 0 had more free memory (3,384 MiB) than GPU 1 (2,379 MiB), because
GPU 1 already holds the strong code model. The desktop also runs on GPU 0, so heavy
indexing there can cost some interactivity; that is a real trade and the reason the split
is configurable rather than assumed.

**The general lesson.** A resource limit that comes from a placement decision is not a law.
Before serialising work, check whether the contention was self-inflicted.

---

## D-13 — The CLI loads no model and holds no state

**Ruling.** `bin/lens.mjs` is a thin client. All residency lives in the engines.

**Why.** A third model in the lens would spend GPU memory duplicating what is already
resident — the strong model is one hop away in an engine that already holds it hot.
