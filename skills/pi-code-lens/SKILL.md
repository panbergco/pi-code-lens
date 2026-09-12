---
name: pi-code-lens
description: >-
  Search, understand, change, and review code with lens_ask, lens_breaks, lens_graph,
  and lens_semantic. Use for codebase questions or edits: where or how something is
  implemented, why a failure happens, what to change, what depends on a symbol, whether
  an edit is safe, what a change breaks, and whether a helper already exists. Use before
  broad grep/find searches or reading many files to locate code, and before editing a
  function, class, or method. Trigger for architecture exploration, debugging, impact
  analysis, change review, refactoring, and unfamiliar repositories.
compatibility: >-
  Requires the pi-code-lens extension tools and both indexing engines (GitNexus and
  cocoindex-code). Run `lens install --hot-load` once per machine and index each repository.
---

# pi-code-lens

Ask the index before walking the tree. `rg` remains right for an exact literal string; it is
the wrong tool for “where does this happen” and it cannot tell you what an edit breaks.

## Required sequence

1. **Locate by meaning** — `lens_ask { question }` before `rg`, `grep`, `find`, or opening
   files at random. Ask in plain words; the answer is ranked by callers and risk.
2. **Read the returned files.** The index narrows the search; it does not replace reading the
   real execution path.
3. **Check blast radius** — `lens_breaks { symbol }` immediately before editing any function,
   class, or method. The caller list is the review.
4. **Make the smallest root-cause change.** Use `rg` only to confirm exact identifiers.
5. **Review structural fallout** — `lens_graph { tool: "detect_changes", args: { scope:
   "compare", base_ref: "<branch>" } }` before committing.

## Choosing a tool

| Need | Call |
|---|---|
| Where is X handled, how does Y work, what should change | `lens_ask` |
| Callers, execution flows, and risk before an edit | `lens_breaks` |
| Named graph operations: `impact`, `context`, `trace`, `detect_changes`, `cypher` | `lens_graph` |
| Direct semantic-engine commands: `search`, `index`, `status` | `lens_semantic` |
| One exact literal string | `rg` |

## When an index is missing or stale

An answer carrying `! no index`, `not indexed`, or a staleness note is low-confidence. Do not
silently downgrade to a broad grep.

- Semantic index: `lens_semantic { command: "index" }`
- Graph index: run `gitnexus analyze` once in the repository
- Status and coverage: `/lens`

Then repeat the original call. Report the gap if it cannot be fixed.

## Blocks appended to search results

A `grep`, `find`, `read` or shell search may come back with an appended block headed
`[code-lens — what the index knows about "<symbol>"]`. That is this index answering the
search: definition, callers, execution flows and risk — what the text match cannot show.
Treat it as evidence, not decoration, and follow it instead of grepping again. It is absent
when the index had nothing structural to add.

## Context pushed in before a turn

A turn may open with `[code-lens — what the index already knows about this task]`, listing
spots with callers before any tool has run. That is this index answering the prompt up
front. Follow those pointers; do not grep for what is already listed. A line saying `no
strong structural match` means the probe found nothing solid — call `lens_ask` explicitly
before falling back to a broad search.

## Is it actually working here? — `lens kpi`

Run `lens kpi` (or `/lens kpi`) in a repository to get one number: **of the moments the
index could have answered, what share did it?** It reads the agents' own transcripts, so it
cannot be flattered by what this tool says about itself.

```
  moment        happened  index could  index did     KPI
  search            4415         1512        778   51.5%
  prompt            2414          120         31   25.8%
  edit              1012          109         14   12.8%
```

**The KPI is per checkout, and differences between repos are expected, not faults.**
Measured on one build, one day, four repositories: **47.3%**, **38.5%**, **97.2%**, **0.0%**.
The number moves with what that repo's agents spend the day doing and how complete its
index is — a repo whose agents file paperwork and poll panes sits far below one whose
agents read code, with nothing wrong anywhere. Never average them, and never quote one
repo's KPI as the tool's.

What the rows mean when a number looks bad:

- **search low** — searches are happening that the index could serve and is not. Check
  freshness first (`/lens`), then the missed-subject list the report prints.
- **prompt low** — prompts name code the index knows but no pack was injected: usually a
  cold engine timing out inside the per-prompt budget.
- **edit low** — symbols are being changed without their blast radius pulled first. This is
  normally the weakest row, and it is a habit gap rather than an index gap.
- **"because an agent chose a lens tool"** near zero is the expected shape. Adoption comes
  from the index speaking first, not from being selected.

## Duplicate work

Before writing a new helper, ask `lens_ask` whether it already exists. Reimplementing code
that lives a few files over is the most common avoidable change.
