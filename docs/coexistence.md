# Living beside a framework that owns the same hooks

These repos are governed by a development framework whose hooks are **decision-making**:
they block commits, refuse stops, deny writes. code-lens must be a **passenger, never a
gate**.

## The contract

| rule | why |
|---|---|
| **Never emit a deny.** Enrichment output only; always exit 0 | the framework's guards are the sole refusal authority. Two refusal authorities on one event is an outage waiting for a disagreement |
| **Register on no stop event** | the loop's exit belongs to the framework alone |
| **Separate matcher blocks; additive registration** | verified in practice: the graph engine's 2 entries sit beside the framework's 141 without touching them, and matchers run in parallel |
| **≤ 50 ms at the hook**, enforced by a timeout that yields nothing on expiry | hooks run in parallel, so the chain costs as much as its slowest member. code-lens must never be that member |
| **No framework vocabulary in output**; no code-lens artifacts in its state directories | the framework is not the product, and code-lens is neither |
| **Index artifacts gitignored** | one index measured 93 MB; it must never enter a repo's history |
| **One fenced region in the instructions file**, outside the framework's managed markers | proven to coexist: each tool rewrites only between its own markers |

## Verified, not assumed

The 141-vs-2 coexistence above is an observation from a live machine, not a design hope:
the graph engine's hooks were added to a settings file already carrying the framework's
registrations, and every existing entry survived untouched.

The framework's own measurement work also settled a latency question that matters here:
**hooks matching the same event run in parallel**, so a chain costs its slowest member, not
the sum. That is why the code-lens hook budget is expressed as a per-hook ceiling rather
than a share of a total.

## The three hooks (designed, not yet built)

| event | does | never does |
|---|---|---|
| before a search (`Grep`/`Glob`) | attaches ranked spots for the pattern | block the search |
| after a write (`Edit`/`Write`) | marks the index stale; runs the duplicate check on what was just written | block the write |
| before an edit (`Edit`/`Write`) | injects `breaks:` when the target's blast radius is large, ≤400 tokens | block the edit |

Constraints carried from measurement:

- **Fail open and fast.** Engine down → emit nothing, agent proceeds.
- **One process, not a fan-out.** Hooks talk to the hot server over a local socket. They
  must never boot an engine; a per-call engine start is ~2.5 s, which no hook budget
  survives.
- **Enrichment is not instruction.** The hook adds context; it does not tell the agent what
  it may do.

## Interaction worth noting

The framework emits an execution event log; the graph engine maps a diff to affected
symbols. A later integration could annotate each unit of work with the blast radius it
actually touched. That is downstream and optional — nothing in code-lens depends on it.
