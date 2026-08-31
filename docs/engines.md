# The two engines

code-lens is a router and a fuser. All capability comes from two external engines that it
supervises but never reimplements.

## Semantic engine — `cocoindex-code` (`ccc`)

Chunks source along AST boundaries, embeds each chunk, and serves nearest-neighbour search
from a local index. **Owns the strong model**, which is why it is the recall stage.

| | |
|---|---|
| Model | `Shuu12121/CodeSearch-ModernBERT-Crow-Plus` |
| Dimensions / context | **768 / 8,192 tokens** |
| Code-retrieval score | **0.89** |
| Resident size | ~3,440 MiB |
| Transport | CLI, `--json` |
| Capabilities (9) | `init index search grep status reset doctor mcp daemon` |

The 8,192-token window is the decisive property: a whole file usually fits in one vector
with its imports and call sites intact, where a 512-token model sees only fragments.

**Caveat — measured, and narrower than it first appears.** Its `grep` subcommand has two
modes and only one works:

| pattern | result |
|---|---|
| `return null` (plain literal) | real hit, with file and line |
| `console.log($$$)`, `export function $F`, `async function $F($$$) { $$$ }` | **"No matches found"** |

Structural matching — the metavariable syntax that is the subcommand's whole purpose —
silently returns nothing. Verified against ground truth: `export async function $NAME($$$)`
found zero while 514 files contain that exact construct. It reports an empty result rather
than an error, so an agent reads "no matches" as an answer.

**Never trust an empty result from it.** Literal patterns do work, but `grep`/`rg` are
faster and more predictable for those, so there is no case where this subcommand is the
right tool.

## Graph engine — `gitnexus`

Parses the repo into a knowledge graph of symbols and call edges, then **precomputes**
structure at index time: clusters, execution flows, blast radius. Answers structural
questions in one call rather than making the caller explore.

| | |
|---|---|
| Model (its own, for semantic search) | `Snowflake/snowflake-arctic-embed-xs` |
| Dimensions / context | 384 / 512 tokens |
| Code-retrieval score | 0.67 |
| Resident size | ~282 MiB |
| Transport | MCP over HTTP (always-on server) |
| Capabilities (17) | `list_repos query cypher context detect_changes check rename impact explain pdg_query route_map tool_map shape_check api_impact group_list group_sync trace` |

**Its search is hybrid — BM25 keyword retrieval fused with vector similarity via RRF — so
it works with or without embeddings.** Without them it is BM25-only: strong on identifiers
and exact terms, weak on paraphrase. That is a *different shape* of recall, not an absent
one, and it is why a repo indexed with `--skip-embeddings` (or one that trips the 50,000-node
embedding cap) still answers. Its embedding model is the weaker of the two, and that is
fine: its value is structural.
Several tools are specialised and must not be lost to a "simpler" unified surface —
`route_map`, `shape_check` and `api_impact` earn their keep on large TypeScript codebases,
and `explain`/`pdg_query` are the data-flow security surface.

**Quirks encoded in the adapter:**

- Tool results are JSON **followed by a markdown hint**, so strict parsing fails on every
  call. The adapter extracts the leading balanced JSON value.
- `query` returns **three** arrays — `definitions`, `process_symbols`, `processes`. On an
  embedding-free index the first carries the hits and `processes` is empty, so reading only
  `processes` makes a working search look like a failed one.
- `--drop-embeddings` combined with `--embeddings` in one run fails on duplicate keys; drop
  and regenerate are separate runs.
- `analyze --force` does **not** force a rebuild when the index is current — a true rebuild
  needs `clean --force` first.
- Its search path hardcodes the local model name and ignores config, so changing models
  locally would leave search embedding questions with the old one and silently returning
  meaningless matches. Only the external-embedding route moves both sides together.

## Which answers what

| the question | engine | why |
|---|---|---|
| "where is X handled?" | semantic → graph | prose needs recall; ranking needs consequence |
| "what breaks if I change X?" | graph | recall adds nothing to a named anchor |
| "does this already exist?" | semantic | only similarity can catch a re-implementation |
| "what does this diff affect?" | graph | it maps hunks to symbols and flows directly |
| "trace this data to its sink" | graph | the data-flow surface |

## Coverage is per-repo, and asymmetric

Each engine indexes repos independently. A repo indexed by only one gets a **stated
degraded answer**, never a silent half-answer. `lens doctor` lists each engine's repos;
`lens ask` names the gap and the command that closes it.
