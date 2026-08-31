# Third-party components and their terms

pi-code-lens is MIT-licensed (see [LICENSE](LICENSE)) and **bundles no third-party code**.
The two engines are separate programs: the installer fetches each from its own upstream, and
the lens talks to them over a local socket. Their terms therefore apply to *you*, as the
person running them, independently of this package's licence.

| component | role | licence |
|---|---|---|
| **GitNexus** | knowledge-graph engine (`lens_graph`, structural ranking) | **PolyForm Noncommercial 1.0.0 — non-commercial use only** |
| cocoindex-code (`ccc`) | semantic recall engine | Apache-2.0 |
| cocoindex, sentence-transformers, transformers, PyTorch | pulled in by `ccc` | Apache-2.0 |
| `Shuu12121/CodeSearch-ModernBERT-Crow-Plus` | default code-retrieval model | Apache-2.0 |
| `google/embeddinggemma-300m` | optional NPU embedding lane (`--npu`) | Gemma Terms of Use |
| FastFlowLM | optional NPU runtime serving that model | no licence declared upstream at the time of writing — check before relying on it |

## ⚠️ GitNexus is non-commercial

PolyForm Noncommercial 1.0.0 permits use for **any purpose except commercial advantage**.
`lens install` installs GitNexus for you, so read this before using the graph half at work:

- personal projects, research, teaching and evaluation are covered;
- using it in or for a commercial product or service is **not**, without a separate grant
  from the GitNexus authors;
- pi-code-lens being MIT does not widen that. This package's own code is free to use
  commercially; the engine it calls is not.

The semantic half (`ccc`, Apache-2.0) has no such restriction, and the lens degrades with a
named note rather than failing when the graph engine is absent — so a commercial user can
run recall-only and lose ranking, not the tool.

## Attribution

Two designs were studied and adapted from MIT-licensed projects, as credited in
`extensions/index.ts`. No source file from either project is included here.

- **Index freshness** — refresh on the git events that actually cause staleness, check at
  session start, compare the indexed commit rather than a clock: from
  **gitnexus-opencode 0.5.3** and **pi-gitnexus 0.6.4**.
- **Answering searches instead of asking to be called** — hooking `tool_result` for search
  tools, reading the subject out of the tool input and its output, per-session caches for
  answered and unanswerable subjects, and a hard cap on what gets appended: from
  **pi-gitnexus 0.6.4**. The extraction rules were rewritten and the lookup replaced with
  this project's routed two-engine pipeline.
