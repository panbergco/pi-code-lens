# Instruction block for a project

Copy the fenced block below into a project's `CLAUDE.md` (or `AGENTS.md`). It is
self-contained and framework-agnostic — it names only code-lens and the two engines it
supervises, so it can sit alongside any other tooling that manages its own regions of that
file.

Keep the `code-lens:start` / `code-lens:end` markers: they let the block be updated in place
without touching anything else in the file.

---

```markdown
<!-- code-lens:start -->
## Code intelligence — code-lens

This project uses **code-lens** for finding code and assessing impact: one surface over a
semantic search engine and a code knowledge graph. It answers "which spots matter, and what
breaks if I touch them".

### Install (once per machine)

```bash
git clone https://github.com/panbergco/pi-code-lens.git && cd pi-code-lens
npm install && npm run build
node bin/lens.mjs install --hot-load   # installs + supervises both engines; uses GPUs if present
node bin/lens.mjs doctor --parity      # verify: both engines up, models resident, all capabilities reachable
```

### Index this repository (once, then it stays current)

```bash
gitnexus analyze --index-only   # structure. add --pdg for data-flow analysis
ccc init && ccc index           # semantic recall
```

A timer keeps both indexes current afterwards. `--index-only` matters: without it the graph
engine writes its own files into the repo.

### Use it

| when you… | call |
|---|---|
| need to find code from a description | `lens_ask({question: "how does X work"})` — **use instead of grep** |
| are about to edit a function, class or method | `lens_breaks({symbol: "name"})` **first** |
| want a specific structural tool | `lens_graph({tool: "impact"\|"trace"\|"context"\|"detect_changes"\|…, args: {}})` |
| want raw semantic search | `lens_semantic({command: "search", args: {}})` |

**Never drive the engines directly.** Everything they can do is reachable through the two
passthrough tools; naming an engine binds this repo to one implementation.

**A degraded answer names itself.** If the result says structure or recall was unavailable,
treat it as partial and say so rather than presenting it as complete.

Deployment, GPU policy and troubleshooting: `docs/deployment.md` in the code-lens repo.
<!-- code-lens:end -->
```
