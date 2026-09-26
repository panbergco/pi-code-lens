/**
 * Whether the index is actually being kept up to date — said out loud.
 *
 * For eight days code-lens described itself as working while it was not: one
 * repository's rebuild failed 234 times (its embedding service had been killed)
 * and every status surface still read "a few commits behind, auto-refresh will
 * catch up". The failures went only to a system log nobody reads, and the saved
 * state kept the last GOOD rebuild, so everything computed from it looked fine.
 * Separately, a stalled index pass in one repository made the refresh skip EVERY
 * repository for hours, each skip logged as a routine "already indexing".
 *
 * So the refresh writes down each failure and each blocked pass, and every
 * surface that reports freshness reads it from here.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export interface Failing {
  since: number;
  count: number;
  reason: string;
}

export interface Blocked {
  since: number;
  lastAt: number;
  count: number;
  reason: string;
}

const stateFile = () => join(homedir(), '.code-lens', 'refresh-state.json');
export const blockedFile = () => join(homedir(), '.code-lens', 'refresh-blocked.json');

/**
 * One readable line from a failed engine command.
 *
 * The raw message is mostly the engine's JSON warning chatter: the 400
 * characters the refresh used to keep were ENTIRELY warnings, so the reason the
 * rebuild failed never reached even the log. Drop structured log lines below
 * error level, then prefer a line that names an error.
 */
export function failureReason(e: unknown): string {
  const err = e as { message?: string; stderr?: string; stdout?: string };
  const text = [err?.stderr, err?.message, err?.stdout].filter(Boolean).join('\n');
  const lines = text.split('\n').flatMap((l) => l.split(/(?=\{"level":)/))
    .map((l) => l.trim()).filter(Boolean)
    .filter((l) => {
      const level = /^\{"level":(\d+)/.exec(l)?.[1];
      return level === undefined || Number(level) >= 50;
    })
    .map((l) => (l.startsWith('{"level"') ? (/"msg":"([^"]*)"/.exec(l)?.[1] ?? l) : l))
    .map((l) => l.replace(/^Command failed: .*?(--\S+\s*)*$/, '').trim())
    .filter(Boolean);
  const named = lines.find((l) => /error|fail|refus|ECONN|unreachable|timed? ?out|differs|denied|not found/i.test(l));
  const pick = named ?? lines[lines.length - 1] ?? 'failed with no message';
  return pick.length > 200 ? `${pick.slice(0, 197)}…` : pick;
}

export function noteFailure(prev: Failing | undefined, reason: string, now = Date.now()): Failing {
  return { since: prev?.since ?? now, count: (prev?.count ?? 0) + 1, reason };
}

export function readBlocked(): Blocked | undefined {
  try { return JSON.parse(readFileSync(blockedFile(), 'utf8')) as Blocked; } catch { return undefined; }
}

export function recordBlocked(reason: string, now = Date.now()): void {
  const prev = readBlocked();
  const next: Blocked = { since: prev?.since ?? now, lastAt: now, count: (prev?.count ?? 0) + 1, reason };
  try { mkdirSync(dirname(blockedFile()), { recursive: true }); writeFileSync(blockedFile(), JSON.stringify(next)); } catch { /* best effort */ }
}

export function clearBlocked(): void {
  try { if (existsSync(blockedFile())) rmSync(blockedFile()); } catch { /* best effort */ }
}

export const ago = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.round(h / 24)} days`;
};

const when = (t: number) => new Date(t).toISOString().slice(5, 16).replace('T', ' ');

/**
 * What is wrong with keeping THIS repository's index current, if anything, as
 * lines a person or an agent can act on. Empty when all is well.
 */
export function refreshProblems(cwd: string, now = Date.now()): string[] {
  const out: string[] = [];
  let state: Record<string, { failing?: Record<string, Failing | undefined> }> = {};
  try { state = JSON.parse(readFileSync(stateFile(), 'utf8')); } catch { /* no refresh has run */ }
  const failing = state[basename(cwd)]?.failing ?? {};
  for (const [layer, f] of Object.entries(failing)) {
    if (!f) continue;
    out.push(`index ${layer} rebuild FAILING since ${when(f.since)} (${f.count}×, ${ago(now - f.since)}): ${f.reason}`);
  }
  const b = readBlocked();
  if (b) out.push(`index refresh BLOCKED for ${ago(now - b.since)} (${b.count} pass${b.count === 1 ? "" : "es"} skipped): ${b.reason}`);
  return out;
}

/** Every repository's refresh problems, for machine-wide health (`lens doctor`). */
export function allRefreshProblems(now = Date.now()): string[] {
  let state: Record<string, unknown> = {};
  try { state = JSON.parse(readFileSync(stateFile(), 'utf8')); } catch { /* none yet */ }
  const perRepo = Object.keys(state).flatMap((repo) =>
    refreshProblems(`/${repo}`, now).filter((l) => !l.includes('BLOCKED')).map((l) => `${repo}: ${l}`));
  const b = readBlocked();
  return [...perRepo, ...(b ? [`all repositories: index refresh BLOCKED for ${ago(now - b.since)} (${b.count} pass${b.count === 1 ? "" : "es"} skipped): ${b.reason}`] : [])];
}
