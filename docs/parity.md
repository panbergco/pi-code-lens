# Parity — covering 100% of what the engines can do

## The requirement

Adopting code-lens must cost you **nothing** you had before. Every capability of both
engines stays reachable, including the specialised ones a "simpler" unified surface would
quietly drop.

Measured surface, 2026-08-04:

| engine | capabilities | count |
|---|---|---|
| graph | `list_repos query cypher context detect_changes check rename impact explain pdg_query route_map tool_map shape_check api_impact group_list group_sync trace` | **17** |
| semantic | `init index search grep status reset doctor mcp daemon` | **9** |
| routed (code-lens' own) | `ask spots breaks diff dupe` | **5** |
| | **total reachable** | **31** |

## Why not fold everything into clever verbs

Because it would delete capability while looking tidy. `route_map`, `shape_check` and
`api_impact` are exactly the tools that earn their keep on a large TypeScript codebase;
`explain` and `pdg_query` are the security surface. No routed verb replaces them, and
inventing 26 verbs would just be the engines' surfaces with worse names.

**Parity is a hard requirement. Cleverness is not.**

## Two layers

| layer | mechanism |
|---|---|
| **Routed** | code-lens' own implementation — routing, fusion, ranking, budgeting |
| **Passthrough** | mechanical 1:1 forwarding: `lens graph <tool> [--k v]`, `lens semantic <cmd> [--k v]` |

Passthrough is **generated, not hand-written**. The lens asks each engine what it exposes
(`tools/list` for the graph; a fixed command set for the semantic CLI) and forwards by
name. A capability added upstream is reachable the day it ships, with no code-lens release.

```bash
lens graph api_impact --route /api/orders --repo my-app
lens semantic index --refresh
lens caps            # everything, counted
```

## Enforcement

```bash
lens doctor --parity     # exit 1 if parity cannot be asserted
```

The check enumerates both engines **live** and fails when:

- an engine cannot be interrogated (its surface is unknown, so parity is unprovable),
- an engine reports zero capabilities (it is up but not answering correctly).

The reasoning: since forwarding is by name, an enumerable capability is a reachable one.
The only real failure mode is losing the ability to enumerate — so that is what fails the
check.

**A parity claim that cannot fail is decoration.** This one fails, and it is wired into
`doctor`'s exit code so a script can gate on it.

## What parity does not mean

- Not that every engine capability is *routed* — most are passthrough, deliberately.
- Not that both engines cover every repo. Coverage is per-repo and asymmetric; that gap is
  reported per query, never silently absorbed.
- Not that flags are normalised across engines. Passthrough forwards them verbatim, so an
  engine's own documentation stays correct.
