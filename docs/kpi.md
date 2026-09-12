# Effectiveness KPI — when code-lens could have helped, and when it did

One number, honestly bounded: **of the moments the index could have answered,
what share did it actually answer?**

Run it in the repository you care about:

```bash
lens kpi [--since-hours N]     # or /lens kpi inside a pi session
```

## What counts as a moment

| moment | what it is | counted as served when |
|---|---|---|
| **search** | the agent searched code, and the search named a subject | an answer rode back on it, or it called a lens tool for that subject |
| **prompt** | the human asked for work (≥12 chars) | a pack was injected for that prompt |
| **edit** | the agent changed a code file | its blast radius was pulled first |

## What counts as *could have*

This is where the number is won or lost. Three filters, each added after a
measurement lied:

1. **The index must hold structure for the subject** — verified against the
   graph's own list of names that have callers, not assumed.
2. **The command must be a code search.** A command containing the word `grep`
   is not one: of 33,189 here, 21,389 were sprint paperwork and 8,895 were
   `tmux capture-pane | grep Working` polling other agents.
3. **The subject must look like code.** `sprint`, `CHECK` and `resident` are
   English words that also exist as symbols; requiring camelCase, an underscore
   or a code path keeps English out of the denominator.

Skipping filter 2 inflates the opportunity count ~15× and understates the KPI by
the same factor. Skipping filter 3 adds another ~2×.

## Latest run — a large monorepo, since the prompt hook shipped

```
moment                  happened  index could  index did     KPI
search                      1669          583        278   47.7%
prompt                       807           31         31  100.0%
edit                         298           18          2   11.1%
----------------------------------------------------------------
OVERALL                     2774          632        311   49.2%

served by an answer riding on the search: 278
served because the agent called a tool:   0
prompts that got a pack:                  31   (nudged instead: 0)
distinct subjects the index knew and never spoke about: 87
top misses: sprint×147, tick×11, PREFLIGHT×10, refused×6, declared×6, serve×5, readCheckManifest×4, attributedTitles×4
```

## It is per project — expect repos to differ

The KPI belongs to a checkout, not to the tool. Measured on ONE build, one day, four
repositories:

| repo | overall KPI | why |
|---|---:|---|
| pi-multi-line-status | **97.2%** | conversational work on a small, fully indexed tree — nearly every prompt got a pack |
| a large monorepo | **47.3%** | huge repo, agents mostly file release paperwork and poll panes; the code searches they do make are answered about half the time |
| pi-code-lens | **38.5%** | few sessions, mostly editing rather than searching |
| a small extension repo | **0.0%** | 3 addressable moments in 72h — too small to mean anything yet |

Differences of this size are normal and are not faults. Never average them, and never
quote one repo's KPI as "code-lens's number". When a repo looks bad, the rows say why.

## How to read it

- **search 47.7 %** is the working number: of code searches the index could
  answer, nearly half came back carrying callers or flows.
- **prompt 100 % / 31** is true but small: every addressable prompt got a pack,
  and the channel is one day old.
- **edit 11.1 %** is the weakest surface — an agent edits a symbol without
  pulling its blast radius nine times in ten.
- **served by a tool the agent chose: 0.** Every delivery came from the index
  speaking first. That is the finding the whole adoption argument rests on.
