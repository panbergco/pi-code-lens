# Making this work reliably

Everything below is a conclusion from one day of measuring this tool against six
real agents, not a design sketch. Each rule exists because its absence cost
something specific, and the cost is named.

## The five failures that actually happened

| # | what happened | how long it hid |
|---|---|---|
| 1 | A channel shipped and delivered **nothing** — crux, savings and edit-radius each did — because a bare-symbol answer carries no file path | hours, found only by grepping transcripts |
| 2 | The index sat **19–43 commits behind** at all times; a cost rule deferred rebuilds for an hour, and nothing said so | weeks |
| 3 | The **denominator was fake**: `tmux capture-pane \| grep Working` and `vitest run \| grep FAIL` counted as code searches, inflating opportunities ~15× | the whole adoption argument |
| 4 | **Measurement tools lied** four separate times — a dangling `else`, a `system` field that was null, session files that never stored tool lists, a `.d.ts` stub mistaken for a call site | each produced a confident wrong report |
| 5 | A measurement **broke the thing it measured**: a batch of queries exhausted the engine's 1,000-session cap, after which every answer said "no index" | one run, and it looked exactly like data loss |

Reliability is not "the engine is up". It is: **the channel fires, on the right
moments, with true content, and says so loudly when it does not.**

## The system, in five parts

### 1. Push channels, never a request for adoption

Announcement is measured at **66 agent-chosen calls in 77,029** over 26 days.
Every delivery that matters comes from the index speaking first. So the surface
area is a set of hooks, each with one job and one gate:

| channel | fires on | gate |
|---|---|---|
| prompt pack | a prompt ≥ 12 chars | structure exists · not already shown |
| search answer | a search with a subject | the index adds what text cannot |
| empty-search answer | a search that found nothing | the shell did not break |
| edit blast radius | a write to a code file | something imports or calls it |
| session orientation | first turn | an index exists |

A channel with no gate becomes noise; a gate with no channel is silence. Both
are failures, and the next part is how you tell them apart.

### 2. Every channel proves itself, continuously

**This is the part that was missing.** Three channels shipped and delivered zero
for hours; nothing anywhere said so, because silence is this tool's normal
state. The repair is a heartbeat per channel:

- Each channel records **when it last fired** and **when it was last eligible**.
- A channel eligible N times and fired zero times is **broken until proven
  otherwise**, and says so in `/lens` and in `lens kpi`.
- A post-deploy `lens selftest` drives every channel through its real registered
  handler against a fixture repository, because "the code compiles" and "the
  hook fires in a live session" are different claims — and the gap between them
  is where all three silent failures lived.

### 3. Freshness belongs to the read, not to a clock

A timer loses to a repository that commits eight times an hour. The rules:

- A question asked of a lagging index **starts the repair** and answers from
  what is on disk now.
- Staleness is measured against **working-tree bytes**, not commits, so an
  uncommitted edit to the file being discussed is visible.
- Past a threshold the tool **refuses to make structural claims** rather than
  dressing an old tree in a confident block.
- Rebuild cost decides cadence **proportionally** — never a cliff, because a
  cliff turns a one-second difference into an hour of staleness.

### 4. The denominator is enforced in code, or the number is theatre

An effectiveness number is only as honest as its definition of "could have
helped". Three filters, each added after a measurement lied:

1. The index must **hold structure for that subject** — verified, not assumed.
2. The command must be a **code search**: a grep fed by a pipe from a test run
   is someone watching output, not asking about code.
3. The subject must **look like code** — `sprint`, `CHECK`, `verdict` are English
   words that are also symbols.

And the KPI must **attribute its own misses**, or the reader writes their own
script and gets a different answer. Two scripts disagreeing about the same hour
is how a day gets lost.

### 5. Per repository, always — and some repositories are not the point

Measured on one build, one day: **97.2 %, 47.3 %, 38.5 %, 0.0 %**. The number
moves with what those agents spend the day doing.

The strongest example is this one: over four hours the six agents in
A large monorepo produced **four edits, all Markdown**, and five of them were idle
the whole time, waiting on a human reply after finishing their reports. A code
index cannot serve a fleet that is writing sprint documents and waiting for
rulings, and a tool that reports a bad number in that situation is measuring the
wrong thing.

So a repository carries a **profile**: how much of its work is code reading at
all. Where that is near zero, the honest output is "few opportunities here", not
a percentage. Optimising a channel in such a repo is effort spent where no
opportunity exists.

## What to build next, in order

1. **Channel heartbeats + `lens selftest`** — the only defence against a channel
   that ships and silently does nothing. Highest value: it closes failure #1,
   which happened three times in one day.
2. **KPI snapshots** — write each run to `~/.code-lens/kpi/<repo>.jsonl`, so a
   regression is visible as a trend rather than rediscovered by hand.
3. **Opportunity density in the report** — state how many moments existed at all,
   so a low percentage on ten moments is never confused with a low percentage on
   a thousand.
4. **Edit-radius coverage** — the weakest live row (13–16 %), half of it repeat
   saves to the same file inside the repeat window.
