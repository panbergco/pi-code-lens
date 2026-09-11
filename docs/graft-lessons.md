# What Graft does that pi-code-lens does not

Decomposition of `github.com/trailhq/Graft` @ `f9e6539` (17 h old at review),
against one question per row:

> **Does pi-code-lens have this, and does its promise — "the index answers, so
> the agent stops re-exploring" — survive without it?**

Verdicts are a closed set: **have** · **partial** · **missing** · **n/a** (with
a reason). Every row cites the Graft file it came from.

**Scope, by name.** Read in full: `README.md` (340 lines), `src/claude/hooks.ts`
(462), `src/claude/format.ts` (237), `src/mcp/instructions.ts` (57),
`src/graph/refresh.ts` (head, 70), `src/context/check.ts` (head, 60),
`src/context/savings.ts` (head, 50), `src/claude/settings-merge.ts` (hook block).
Listed but **not** opened, and therefore out of scope: `src/graph/*` extractors
(26 files), `src/app/*` (15), `src/telemetry/*` (11), `src/blast/*` (9),
`src/brain/*` (5), `viewer/`, `deploy/`, `test/` (126 files, read only as a count).

Measured, not asserted:
`find src -name '*.ts' | wc -l` → **139 files / 31,267 LOC**;
`find test -name '*.ts' | wc -l` → **126 files / 25,598 LOC**.

---

## 1. Adoption is won by a channel that fires whether or not the model cooperates

| ID | The obligation | Verdict | Citation |
|---|---|---|---|
| 1.1 | A directive naming the tools is injected into **every session**, not offered for the model to discover | **missing** | `format.ts:212-228` — "the reliable steering channel (fires every session, unlike the discretionary skill)" |
| 1.2 | That directive carries **call discipline** — pick one tool, act on it, don't re-ask reworded | **missing** | `format.ts:219` |
| 1.3 | Retrieval is injected **before the agent acts**, off the user's prompt | **missing** | `hooks.ts:445-462` (`event === 'prompt'`) |
| 1.4 | Injection is **gated on match strength**, and drops the pack when coverage is weak | **have** | `format.ts:193-209` vs our structural gate |
| 1.5 | Already-injected pointers are **never repeated** in a session | **partial** | `format.ts:201-207` (pointer set) vs our 30-min TTL |
| 1.6 | Trivial prompts are skipped outright | **have** | `hooks.ts:20` (`MIN_PROMPT_CHARS = 12`) |
| 1.7 | Steering survives **tool deferral**, when a host sends names without schemas | **missing** | `mcp/instructions.ts:1-25` — measured: 111 tools deferred, graft's six arrived as bare strings |

**Tally: 2 have · 1 partial · 4 missing.**

**The pattern:** every missing row is a *push* channel; every row we hold is a
*filter* on a channel we already had. We built good judgement about when to
speak, and no way to speak first.

---

## 2. Freshness is a property of the query, not of a schedule

| ID | The obligation | Verdict | Citation |
|---|---|---|---|
| 2.1 | Every retrieval call probes the tree and rebuilds **before answering** | **missing** | `graph/refresh.ts:1-13` — "freshness moves into the query path… ~3ms" |
| 2.2 | Freshness compares **working-tree bytes**, so uncommitted edits are visible | **missing** | `README.md:186` — ours is commit-count, so an uncommitted edit is invisible |
| 2.3 | The refresh is **$0 and offline** — never the expensive stage | **have** | `refresh.ts:15-17`; ours is tree-sitter/graph only too |
| 2.4 | A failed refresh **degrades to answering**, never to failing | **have** | `refresh.ts:18-20` |
| 2.5 | Concurrent refreshes **cannot stampede** — one lock, shared with the background sync | **have** | `refresh.ts:21-23`; ours: `indexRunning()` + PID guard |
| 2.6 | A query **writes only what a query reads** — no side effects on the passive surface | **partial** | `refresh.ts:24-30`; our refresh rebuilds everything |
| 2.7 | Per-file **content-hash caching** is what makes 2.1 affordable | **missing** | `README.md:180` — 0.74 s cold → 0.18 s after one edit |

**Tally: 3 have · 1 partial · 3 missing.**

**The pattern:** we match Graft on every safety property and miss the one
structural choice they built them for — the rebuild is cheap enough to run on
the read path, so staleness cannot exist. Ours is a timer racing the repo, which
is the design that produced today's 19–43-commit lag.

---

## 3. An answer carries meaning inline, so the follow-up read never happens

| ID | The obligation | Verdict | Citation |
|---|---|---|---|
| 3.1 | A hit carries the **code itself**, not only an address | **missing** | `README.md:238-244` — "Most code maps stop at an address… so it still has to open the source" |
| 3.2 | The stored excerpt is **text, not line numbers**, so it survives drift above it | **missing** | `README.md:248` |
| 3.3 | A plain-English summary exists **whether or not the code was documented** | **missing** | `README.md:241` (LLM pass, `--deep`) |
| 3.4 | Callers / blast radius are one call, N levels deep | **have** | `lens_breaks`, ours |
| 3.5 | A whole file's API at a tenth of the tokens | **missing** | `README.md` MCP table (`graft_file_api`) |
| 3.6 | Exhaustive mode exists alongside ranked mode, and says which is which | **partial** | `graft_find_all` vs our `lens_semantic` passthrough |

**Tally: 1 have · 1 partial · 4 missing.**

**The pattern:** ours answers *where*, theirs answers *what it says* — which is
why their per-prompt pack can be pointers-only and still remove a read.

---

## 4. Value is made visible, to the human and to the agent

| ID | The obligation | Verdict | Citation |
|---|---|---|---|
| 4.1 | Every retrieval output ends with a **measured saving** | **missing** | `context/savings.ts:1-14` — baseline = the files you would have read whole |
| 4.2 | The estimate is **omitted rather than faked** when the baseline is unknown | **n/a** — nothing to omit | `savings.ts:41-44` |
| 4.3 | The agent is asked to **report the tally in its reply**, so the human sees it | **missing** | `format.ts:228` |
| 4.4 | A **statusline** shows graph size and a stale warning continuously | **missing** | `README.md` (Claude Code deep integration) |
| 4.5 | Stale state is announced **in-band at session start** | **partial** | `hooks.ts:410` (`staleBanner`); ours notes lag only on an answer |
| 4.6 | Usage mix (index reads vs source reads) is **counted per session** | **partial** | `hooks.ts:250-268`; we measure ours by scraping transcripts afterwards |

**Tally: 0 have · 2 partial · 3 missing · 1 n/a.**

**The pattern:** Graft instruments itself; we instrument it from outside, after
the fact, which is why every adoption number I produced today had to be recomputed
three times before it was true.

---

## 5. Installation wires the host, not the user's memory

| ID | The obligation | Verdict | Citation |
|---|---|---|---|
| 5.1 | One command detects the agents present and wires each one's native file | **partial** | `README.md` Agent integration; ours installs for pi only |
| 5.2 | Writes are **marker-fenced and idempotent** — re-running never clobbers | **have** | `README.md`; our AGENTS.md block is fenced |
| 5.3 | `--dry-run` prints every file it would touch, before touching one | **partial** | `README.md` flag table |
| 5.4 | With no TTY it **writes nothing** and prints the command instead | **missing** | `README.md` — CI safety |
| 5.5 | Machine-wide writes are **labelled as such** and skippable | **missing** | `README.md` "Writes outside the repo" |

**Tally: 1 have · 2 partial · 2 missing.**

---

## Reconciliation

Every section of what I read maps to a group: README problem/solution → 1 and 3;
README freshness + `refresh.ts` + `check.ts` → 2; README benchmark + `savings.ts`
+ `hooks.ts` metrics → 4; README agent-integration + `settings-merge.ts` → 5.
`mcp/instructions.ts` → 1.7. Excluded by scope and named above: the extractors,
the app/telemetry/brain/blast trees, the viewer, and the tests.

## Totals

Counted from the tables: **31 items — 7 have · 7 partial · 16 missing · 1 n/a.**

## The one-sentence pattern

Every item we hold is a *judgement* (when to speak, when to stay silent, how not
to stampede); all sixteen we lack are *mechanisms* (a channel that always fires,
a rebuild on the read path, meaning stored inline, a number the human can see) —
we have been tuning the quality of an answer nobody asked for, while Graft built
the ways to be asked.

## What that rules out, and what it selects

**Ruled out:** tool descriptions, prompt snippets and skills as the adoption
route. Graft ships all three and calls the skill "discretionary", relying on
the session hook instead (`format.ts:212`). Our own 26-day measurement agrees:
66 agent-chosen calls in 77,029.

**Selected, in dependency order:**

1. **Refresh on the query path** (2.1, 2.2, 2.7) — until an answer is true about
   the working tree, nothing else is worth adopting. Blocks everything.
2. **An always-on directive at session start** (1.1, 1.2) — the channel that
   fires whether or not the model cooperates.
3. **Retrieval injected off the prompt, before the agent acts** (1.3), reusing
   the gate and memory we already have (1.4, 1.5).
4. **Inline the crux** (3.1, 3.2) so a pointer-sized pack still removes a read.
5. **A savings footer and a visible tally** (4.1, 4.3) — self-measurement, so
   adoption stops being an archaeology exercise.
