/**
 * Intent routing.
 *
 * Deterministic by design: patterns and shape, never a model call. A router
 * that costs an inference has already lost the latency argument it exists to
 * win — the whole point is answering in ~200 ms.
 */

export type Intent = 'locate' | 'breaks' | 'why' | 'diff' | 'refactor' | 'dupe';

export interface Plan {
  intent: Intent;
  /** Recall stage: propose candidates from prose. Skipped when the anchor is known. */
  seed: boolean;
  /** Structure stage: expand candidates into consequence. */
  expand: boolean;
  /** Hops of graph expansion; deeper costs latency, so it is intent-driven. */
  hops: 1 | 2;
  why: string;
}

const RULES: Array<{ intent: Intent; re: RegExp; plan: Omit<Plan, 'intent' | 'why'>; why: string }> = [
  { intent: 'breaks', re: /\b(break|blast radius|impact|safe to (change|edit|remove)|what depends|who calls)\b/i,
    plan: { seed: false, expand: true, hops: 2 },
    why: 'consequence question with a named anchor — structure only, no recall stage' },
  { intent: 'diff', re: /\b(review (this|the) (diff|change|pr)|what did i change|uncommitted)\b/i,
    plan: { seed: true, expand: true, hops: 1 },
    why: 'diff maps to symbols structurally, then recall finds related-but-untouched code' },
  { intent: 'dupe', re: /\b(already exist|duplicat|reimplement|similar code|do we have)\b/i,
    plan: { seed: true, expand: true, hops: 1 },
    why: 'recall over the code being written; structure then says if the original is load-bearing' },
  { intent: 'why', re: /\b(why|fail|error|broken|bug|refus|reject)\b/i,
    plan: { seed: true, expand: true, hops: 2 },
    why: 'locate the symptom by meaning, then trace structurally to the deciding branch' },
  { intent: 'refactor', re: /\b(rename|extract|split|move|restructure|refactor)\b/i,
    plan: { seed: true, expand: true, hops: 2 },
    why: 'graph gives call-aware sites; recall finds copies a call graph cannot see' },
];

/** A bare symbol or file:line is an anchor, not a description — skip recall. */
const ANCHOR = /^[\w$.]+(\(\))?$|^[\w./-]+\.\w+:\d+$/;

export function route(question: string): Plan {
  const q = question.trim();

  if (ANCHOR.test(q)) {
    return { intent: 'breaks', seed: false, expand: true, hops: 2,
      why: 'input is a symbol or file:line anchor — recall would add latency without adding information' };
  }
  for (const r of RULES) {
    if (r.re.test(q)) return { intent: r.intent, ...r.plan, why: r.why };
  }
  return { intent: 'locate', seed: true, expand: true, hops: 1,
    why: 'open description — recall proposes, one hop of structure ranks by consequence' };
}
