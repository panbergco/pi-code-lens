/**
 * A refresh that fails or is blocked must SAY so, everywhere freshness is shown.
 *
 * For eight days one repository's rebuild failed 234 times while every surface
 * read "a few commits behind, auto-refresh will catch up": the failures went to
 * a log nobody reads, and the reason itself was lost under warning chatter. And
 * a stalled index pass in one repository skipped every repository's refresh
 * for hours, each skip logged as a routine "already indexing".
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'lens-health-'));
process.env.HOME = home;
mkdirSync(join(home, '.code-lens'));
const { failureReason, noteFailure, refreshProblems, allRefreshProblems, recordBlocked, clearBlocked } =
  await import('../dist/core/refresh-health.js');
const { saveState, passVerdict, STALLED_MS } = await import('../dist/commands/refresh.js');
const { staleness } = await import('../dist/core/ask.js');
const { freshnessCaveat } = await import('../dist/core/augment.js');

try {
  // ── the reason survives the engine's chatter ──────────────────────────────
  const warn = '{"level":40,"time":1,"name":"gitnexus","msg":"[scope-resolution] 86 property read/write site(s) name a field that IS defined in this workspace, but only in another language"}';
  const e = Object.assign(new Error(`Command failed: gitnexus analyze --index-only ${warn}`),
    { stderr: `${warn}\n${warn}\nError: embedding request to http://127.0.0.1:52625/v1 failed: connect ECONNREFUSED` });
  const why = failureReason(e);
  assert.match(why, /ECONNREFUSED/, `the real error is kept (got: ${why})`);
  assert.ok(!/scope-resolution/.test(why), 'and the warnings are not');
  assert.equal(failureReason(new Error('')), 'failed with no message');

  const f1 = noteFailure(undefined, 'x', 1000), f2 = noteFailure(f1, 'y', 5000);
  assert.deepEqual([f2.since, f2.count, f2.reason], [1000, 2, 'y'], 'a streak keeps its start, counts, and the latest reason');

  // ── a failure is recorded, reported everywhere, and cleared by a success ──
  const repo = join(home, 'Code', 'demo');
  mkdirSync(join(repo, '.gitnexus'), { recursive: true });   // an indexed repository: only those are kept current
  writeFileSync(join(repo, '.gitnexus', 'meta.json'), JSON.stringify({ lastCommit: 'c'.repeat(40) }));
  const now = Date.now();
  saveState({ demo: { failing: { graph: { since: now - 3 * 86_400_000, count: 234, reason: 'embedding service unreachable' } } } });
  const lines = refreshProblems(repo);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /index graph rebuild FAILING since .* \(234×, 3 days\): embedding service unreachable/);
  assert.match(staleness(repo) ?? '', /FAILING/, 'the shared staleness note says it, even with no commit lag to report');
  assert.match(freshnessCaveat([staleness(repo)]), /! index graph rebuild FAILING/, 'and so does every automatic answer');
  assert.match(allRefreshProblems().join('\n'), /^demo: index graph rebuild FAILING/m, 'and lens doctor, per repository');

  // Saving merges per repository with what is on disk; a cleared failure must stay cleared.
  saveState({ demo: { failing: { graph: undefined } } });
  assert.deepEqual(refreshProblems(repo), [], 'a success clears it for good');
  assert.equal(staleness(repo), undefined, 'and a healthy index adds no words');

  // ── a blocked refresh is recorded, not just skipped ───────────────────────
  recordBlocked('a semantic index pass (pid 7, in big-repo) has been running 1 h 26 min');
  recordBlocked('a semantic index pass (pid 7, in big-repo) has been running 1 h 41 min');
  const b = refreshProblems(repo);
  assert.match(b[0], /index refresh BLOCKED for 0 min \(2 passes skipped\): .*1 h 41 min/, 'blocked passes are counted, with the latest reason');
  assert.match(allRefreshProblems().join('\n'), /all repositories: index refresh BLOCKED/, 'a block affects every repository, and says so');
  clearBlocked();
  assert.deepEqual(refreshProblems(repo), [], 'a pass that runs clears the block');

  // ── a stalled semantic pass stops blocking the graph ──────────────────────
  assert.equal(passVerdict(null), 'go');
  assert.equal(passVerdict({ engine: 'semantic', ageMs: 5 * 60_000 }), 'wait', 'a young pass is waited for');
  assert.equal(passVerdict({ engine: 'semantic', ageMs: STALLED_MS + 1 }), 'stalled', 'an old semantic pass is stalled, not busy');
  assert.equal(passVerdict({ engine: 'graph', ageMs: STALLED_MS * 4 }), 'wait', 'a long graph pass is still real work on the same index');
  console.log('ok — a failing or blocked refresh is recorded and said everywhere freshness is shown');
} finally {
  rmSync(home, { recursive: true, force: true });
}
