---
name: pi-code-lens
description: >-
  Search, understand, change, and review code using the pi-code-lens tools lens_ask,
  lens_breaks, lens_graph, and lens_semantic. Use for every codebase question or edit:
  where or how something is implemented, why a bug or failure happens, what code to change,
  what a function or class affects, whether an edit is safe, and what a change breaks. Use
  before ripgrep, grep, find, or reading many files to locate code, and before editing any
  function, class, or method. Also use when asked to explore an unfamiliar repository,
  review a change, or check for duplicate functionality.
  Examples that should trigger it — finding code: "Where is X handled?", "How does the
  auth flow work?", "Which file owns Y?", "Show me where we parse Z". Before changing
  code: "Is it safe to change X?", "What depends on this function?", "What breaks if I
  rename Y?", "What calls this?". Debugging: "Why is X failing?", "Where does this error
  come from?", "Trace this bug". Reviewing: "Review this branch", "What did this change
  actually move?", "Is this PR risky?". Refactoring: "Rename this function safely",
  "Extract this into a module", "Does a helper for this already exist?".
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

## Duplicate work

Before writing a new helper, ask `lens_ask` whether it already exists. Reimplementing code
that lives a few files over is the most common avoidable change.
