/**
 * The most valuable names in a codebase are the short, ordinary ones — and they
 * are exactly the names that match many nodes.
 *
 * Asked about such a name, the engine does not answer with callers; it answers
 * with a LIST of candidates. Reading that as "no structure" made the lens silent
 * on precisely the symbols people search for most: measured in one repository,
 * `sprint` (19 candidates, searched 47 times in six hours), `tick` (20
 * candidates, 18 times), `store`, `witness`, `lanes` — every one refused, while
 * a unique name like `enqueueInbox` answered with 17 callers.
 *
 * Worse, the candidate list is capped and ranked by the engine's own score, so
 * for `tick` all 20 slots were constants in generated proof directories and the
 * real definitions never appeared at all.
 */
import assert from 'node:assert/strict';
import { GraphEngine } from '../dist/engines/graph.js';

// ── choosing among same-named nodes ─────────────────────────────────────────
const pick = (c) => GraphEngine.pickCandidate(c)?.uid;

assert.equal(
  pick([
    { uid: 'Property:src/status.ts:sprint', kind: 'Property', filePath: 'src/status.ts', score: 0.9 },
    { uid: 'Function:src/sprint.ts:sprint', kind: 'Function', filePath: 'src/sprint.ts', score: 0.5 },
  ]),
  'Function:src/sprint.ts:sprint',
  'something that can HAVE callers beats a better-scoring property',
);

assert.equal(
  pick([
    { uid: 'Function:test/x.test.ts:tick', kind: 'Function', filePath: 'packages/core/test/x.test.ts', score: 0.9 },
    { uid: 'Function:src/tick.ts:tick', kind: 'Function', filePath: 'packages/core/src/tick.ts', score: 0.6 },
  ]),
  'Function:src/tick.ts:tick',
  'shipped code beats a test that merely names the same thing',
);

assert.equal(
  pick([
    { uid: 'Const:proof/sprint-822/producer.mjs:tick', kind: 'Const', filePath: 'pisg-proof/sprint-822/producer.mjs', score: 0.5 },
    { uid: 'Method:src/engine.ts:tick', kind: 'Method', filePath: 'packages/core/src/engine.ts', score: 0.5 },
  ]),
  'Method:src/engine.ts:tick',
  'a generated proof directory is not where an answer should come from',
);

// Ties fall back to the engine's own ranking rather than to input order.
assert.equal(
  pick([
    { uid: 'Function:src/a.ts:run', kind: 'Function', filePath: 'src/a.ts', score: 0.2 },
    { uid: 'Function:src/b.ts:run', kind: 'Function', filePath: 'src/b.ts', score: 0.8 },
  ]),
  'Function:src/b.ts:run',
  'with everything else equal, the engine score decides',
);

assert.equal(pick([]), undefined, 'no candidates is not a crash');

console.log('ok — a name that matches many nodes resolves to the one that can answer');
