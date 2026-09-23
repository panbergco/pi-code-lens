/**
 * Freshness belongs to the READ, not to a clock.
 *
 * A timer refreshing every 15 minutes is a race against the repository, and on
 * a repo committing ~8 times an hour the repository wins: measured on
 * a large monorepo, the graph sat 19-43 commits behind at all times, and every
 * answer described a tree that no longer existed. Graft's structural rebuild is
 * ~3ms so it simply rebuilds inside the query (trailhq/Graft, src/graph/refresh.ts);
 * ours is a 30-60s full re-parse, so it cannot block an answer — but the TRIGGER
 * can still move onto the read path, which is what actually decides staleness.
 *
 * So: any question asked of a lagging index kicks a rebuild in the background
 * and answers from what is on disk now. The index heals because it is being
 * used, and the repos nobody asks about cost nothing.
 *
 * Graft's four properties are kept deliberately:
 *   - $0 and offline — the graph pass only, never a summariser or a vector pass.
 *   - never fatal — a failed heal must never turn a working answer into an error.
 *   - never a stampede — the refresh command holds the same lock the timer takes,
 *     and this module additionally refuses to queue a second one.
 *   - writes only what a read needs — `--graph-only`, so the expensive semantic
 *     pass stays with the timer.
 */
import { execFileSync, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';

/**
 * Files whose bytes moved since the index was written — the drift a commit count
 * cannot see.
 *
 * Adapted from Graft's pre-query probe (trailhq/Graft, MIT, src/graph/fingerprint.ts):
 * git supplies the visible file set, but freshness is measured against the
 * WORKING TREE, so an uncommitted edit, a staged one and a committed one all
 * look the same. Theirs keeps a `(size, mtime, hash)` sidecar written by its own
 * builder; ours cannot — the graph is built by an engine that writes no such
 * record — so the index's own timestamp stands in for the print, and mtime
 * stands in for the hash. Cheaper and blinder: a rewrite that restores identical
 * bytes counts as drift here, where Graft confirms by hash.
 *
 * ~5ms: one `git status` and a stat per changed path. Never throws — a freshness
 * probe that can fail an answer is worse than no probe.
 */
export function workingTreeDrift(cwd: string, indexedAt: string): string[] {
  const since = Date.parse(indexedAt);
  if (!since) return [];
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'],
      { cwd, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const drifted: string[] = [];
    for (const line of out.split('\n')) {
      const rel = line.slice(3).trim();
      if (!rel || !/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|php|swift|kt|c|cc|cpp|h|hpp|cs|scala|ex|lua)$/.test(rel)) continue;
      try { if (statSync(join(cwd, rel)).mtimeMs > since) drifted.push(rel); } catch { /* gone since */ }
    }
    return drifted;
  } catch { return []; }
}

/** Commits behind before a read is worth a rebuild. One is noise on a busy repo;
 *  by five the caller list is describing someone else's tree. */
export const HEAL_AT_COMMITS = 5;

/** Floor between heals for one repo. A rebuild costs ~30-60s of CPU, and a
 *  session asks many questions a minute — without this, every one of them would
 *  queue another pass behind the first. */
export const HEAL_COOLDOWN_MS = 5 * 60_000;

const lastHeal = new Map<string, number>();
let inFlight = 0;

/** Test seam: what has been kicked off, without spawning anything. */
export interface HealHooks { now?: () => number; spawnFn?: typeof spawn }

/**
 * Kick a background graph rebuild if this read found the index too far behind.
 * Returns the reason it acted, or undefined when it deliberately did nothing —
 * so callers (and tests) can see the decision rather than infer it.
 */
export function healIfStale(
  cwd: string, behind: number, hooks: HealHooks = {},
): string | undefined {
  if (behind < HEAL_AT_COMMITS) return undefined;
  const now = hooks.now?.() ?? Date.now();
  const last = lastHeal.get(cwd) ?? 0;
  if (now - last < HEAL_COOLDOWN_MS) return undefined;
  // One at a time across every repo: these passes are CPU-bound and the machine
  // is shared with the agents asking the questions.
  if (inFlight > 0) return undefined;
  lastHeal.set(cwd, now);
  inFlight++;
  try {
    const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
    // Only the repository that was read. Without `--repo` the refresh walks
    // every registered repository, so one stale index made the machine re-check
    // all fifteen — launching the engine for each of them — to heal one.
    const child = (hooks.spawnFn ?? spawn)(
      process.execPath, [cli, 'refresh', '--graph-only', '--repo', basename(cwd)],
      { cwd, detached: true, stdio: 'ignore' },
    );
    child.on?.('exit', () => { inFlight--; });
    child.unref?.();
    return `index was ${behind} commits behind — rebuilding in the background`;
  } catch {
    inFlight--;   // never fatal: the answer still goes out
    return undefined;
  }
}

/** Test helper — the module holds per-repo state by design. */
export function resetHealState(): void { lastHeal.clear(); inFlight = 0; }
