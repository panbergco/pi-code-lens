/**
 * Fusion and ranking.
 *
 * Neither engine can produce "the spots that matter" alone: recall has no idea
 * what a match costs to change, and structure cannot find a starting point from
 * prose. The score is a PRODUCT, so a candidate with no consequence cannot be
 * rescued by wording alone — which is exactly the failure of similarity-only
 * search (a dead branch outranking a hub because the words line up).
 */
import type { Candidate, Neighbourhood } from '../engines/types.js';

export interface Weights { relevance: number; centrality: number; risk: number }
export const DEFAULT_WEIGHTS: Weights = { relevance: 1.0, centrality: 0.6, risk: 0.4 };

const RISK_SCORE = { LOW: 0, MEDIUM: 0.34, HIGH: 0.67, CRITICAL: 1 } as const;

export interface Spot {
  file: string;
  line?: number;
  symbol?: string;
  score: number;
  /** Every signal that produced the rank. An unexplained ranking is unauditable. */
  signals: string[];
  breaks: string[];
  source: Candidate['source'];
}

export function fuse(
  cands: Candidate[],
  hoods: Map<string, Neighbourhood>,
  w: Weights = DEFAULT_WEIGHTS,
): Spot[] {
  const byKey = new Map<string, Spot>();

  for (const c of cands) {
    // Collapse to one spot per SYMBOL where one is known: several chunks of the
    // same function are one place to look, and listing it four times spends the
    // caller's budget re-reading the same answer. Without a symbol, the chunk
    // location is the identity.
    const key = c.symbol ? `${c.file}:${c.symbol}` : `${c.file}:${c.startLine ?? 0}`;
    // Location is the join key: a chunk's file+line is a fact, its symbol name
    // is an inference. Fall back to the name only for anchor-style candidates.
    const hood = hoods.get(`${c.file}:${c.startLine ?? 0}`) ?? hoods.get(c.symbol ?? c.file);

    const relevance = clamp01(c.relevance ?? 0.5);
    // The location join reports callers as a single summary entry ("4 callers");
    // the name join reports them individually. Read the count from either.
    const callers = countOf(hood?.callers) ;
    const flows = hood?.flows.length ?? 0;
    // Saturating: the difference between 0 and 5 callers matters far more than
    // between 40 and 45, so a hub cannot dominate purely on degree.
    const centrality = 1 - Math.exp(-(callers + flows) / 6);
    const risk = hood?.risk ? RISK_SCORE[hood.risk] : 0;

    const score =
      Math.pow(Math.max(relevance, 0.01), w.relevance) *
      Math.pow(1 + centrality, w.centrality) *
      Math.pow(1 + risk, w.risk);

    const signals: string[] = [];
    if (c.relevance !== undefined) signals.push(`semantic ${relevance.toFixed(2)}`);
    if (callers) signals.push(`${callers} caller${callers === 1 ? '' : 's'}`);
    if (flows) signals.push(`on ${flows} flow${flows === 1 ? '' : 's'}`);
    if (hood?.risk) signals.push(`risk ${hood.risk}`);
    if (!signals.length) signals.push(`${c.source} only`);

    const prev = byKey.get(key);
    if (!prev || prev.score < score) {
      byKey.set(key, {
        file: c.file, line: c.startLine, symbol: c.symbol,
        score, signals, breaks: hood?.flows.slice(0, 6) ?? [], source: c.source,
      });
    }
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score);
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** "4 callers" counts as 4; a list of names counts as its length. */
function countOf(entries?: string[]): number {
  if (!entries?.length) return 0;
  const m = /^(\d+) caller/.exec(entries[0] ?? '');
  return m ? Number(m[1]) : entries.length;
}

/**
 * Render under a token budget. Elision is ALWAYS stated: silent truncation
 * reads as completeness, which is how an agent concludes it has seen
 * everything when it has seen the first three of seventeen.
 */
export function render(spots: Spot[], budgetTokens = 600): string {
  const lines: string[] = [];
  let used = 0, shown = 0;

  for (const s of spots) {
    const where = `${s.file}${s.line ? `:${s.line}` : ''}`;
    const block =
      `${shown + 1}. ${where}${s.symbol ? `  ${s.symbol}` : ''}\n` +
      `   why: ${s.signals.join(' · ')}\n` +
      (s.breaks.length ? `   breaks: ${s.breaks.join(', ')}\n` : '');
    const cost = Math.ceil(block.length / 4); // ~4 chars/token
    if (used + cost > budgetTokens) break;
    lines.push(block); used += cost; shown++;
  }

  const hidden = spots.length - shown;
  const head = `SPOTS (${shown}${hidden ? ` of ${spots.length}` : ''}, budget ${budgetTokens} tok)`;
  const tail = hidden > 0 ? `NOT SHOWN: ${hidden} lower-ranked spot${hidden === 1 ? '' : 's'} (--all to list)` : '';
  return [head, ...lines, tail].filter(Boolean).join('\n');
}
