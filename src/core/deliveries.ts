/**
 * One line per automatic-answer decision, written when it happens.
 *
 * The effectiveness report used to reconstruct deliveries from pi's session
 * transcripts after the fact, and that broke every time the delivery format
 * moved: answers stored as a record type it did not read counted as zero, a
 * reworded nudge scored as an answer, a map-only message scored as an answer.
 * It also could not see why something was NOT delivered. This log records the
 * decision itself; transcripts stay as an independent cross-check.
 *
 * Privacy rules, deliberately narrow: local to this machine, one file per
 * repository, code names only (never prompt text), capped in size, and off
 * with LENS_DELIVERY_LOG=0. Writing must never fail or slow an answer, so every
 * error is swallowed and the write is a single small append.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export type Channel = 'search' | 'empty-search' | 'prompt' | 'map' | 'edit';

export interface Delivery {
  /** ms since epoch */
  t: number;
  channel: Channel;
  outcome: 'delivered' | 'silent';
  /** Why it was silent, or which path delivered it. Short, fixed vocabulary. */
  reason: string;
  /** Code names asked about. Never prompt text. */
  subjects?: string[];
  ms?: number;
  bytes?: number;
}

/** Rotate past this size: the log answers "what happened lately", not history. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function deliveryLogPath(cwd: string, home = homedir()): string {
  return join(home, '.code-lens', 'deliveries', `${basename(cwd)}.jsonl`);
}

export function recordDelivery(cwd: string, d: Omit<Delivery, 't'>, home = homedir()): void {
  if (process.env.LENS_DELIVERY_LOG === '0') return;
  try {
    const path = deliveryLogPath(cwd, home);
    // Two plain mkdirs, never `recursive: true`. Pointed at a home under /proc,
    // a recursive mkdir spun forever instead of failing — caught by this
    // module's own test — and a log call that can hang would hang the answer
    // it is recording. A plain mkdir either succeeds, exists, or throws.
    for (const dir of [join(home, '.code-lens'), join(home, '.code-lens', 'deliveries')]) {
      try { mkdirSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    }
    try { if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`); } catch { /* first write */ }
    const subjects = d.subjects?.slice(0, 5).map((s) => s.slice(0, 80));
    appendFileSync(path, JSON.stringify({ t: Date.now(), ...d, ...(subjects ? { subjects } : {}) }) + '\n');
  } catch { /* a log that can fail an answer is worse than no log */ }
}

export function readDeliveries(cwd: string, sinceMs: number, home = homedir()): Delivery[] {
  const out: Delivery[] = [];
  const path = deliveryLogPath(cwd, home);
  for (const file of [`${path}.1`, path]) {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const d = JSON.parse(line) as Delivery;
        if (d.t >= sinceMs) out.push(d);
      } catch { /* a torn last line from a crash is skipped, not fatal */ }
    }
  }
  return out;
}
