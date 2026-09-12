/**
 * Two ways a refresh destroys work, both caught in the act on a live machine.
 *
 * 1. It started a rebuild while a 20-minute vector pass was writing to the same
 *    index, because the "is anything indexing?" check named only two of the
 *    three passes that exist.
 * 2. It cached "this index has no control-flow layer" and kept believing it
 *    after someone built that layer by hand — so the next rebuild would have
 *    dropped 90,417 basic blocks, silently, as a smaller number in a log line.
 *
 * Both are invisible in normal operation and expensive when they fire.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectLayers, indexRunning, loadEngineEnv, saveState, minGapMs } from '../dist/commands/refresh.js';

// ── every indexing pass must be recognised, including the vector one ─────────
// These decoys look EXACTLY like a real indexing pass, because that is the
// point. So they are short-lived and reaped BY PID: one that outlived its test
// blocked a real refresh on this machine for 30 seconds, and reaping them by
// name matched the shell running the test and killed it. A test that sabotages
// the tool it tests is worse than no test.
const decoys = [];
const sleeper = (title) => {
  const pid = Number(execFileSync('bash',
    ['-c', `setsid nohup bash -c 'exec -a "${title}" sleep 5' >/dev/null 2>&1 & echo $!`],
    { encoding: 'utf8' }).trim());
  decoys.push(pid);
  return pid;
};
const reapDecoys = () => { for (const pid of decoys.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch {} } };
process.on('exit', reapDecoys);
// Wait for a settled state rather than assuming one: a real pass, or a decoy
// from a previous run, may still be finishing. A fixed sleep would be a guess.
const settle = (want) => {
  for (let i = 0; i < 120; i++) {
    if ((indexRunning() === null) === want) return true;
    execFileSync('sleep', ['0.05']);
  }
  return false;
};
// A real pass may legitimately be running on this machine. Two checks below
// need a quiet baseline; rather than fail on someone else's index, they are
// skipped and SAID to be skipped. A test that quietly narrows its own coverage
// is worse than one that names its blind spot.
const quiet = settle(true);
if (!quiet) console.log('note: an index pass is running here — the "nothing is indexing" checks are skipped');
for (const [title, expected] of [
  ['/usr/bin/gitnexus analyze --index-only', 'graph'],
  ['/usr/bin/gitnexus embeddings sync .', 'graph vector'],
  ['/usr/bin/ccc index --path /tmp', 'semantic'],
]) {
  // Re-check quietness for EVERY case, not once at the top. A real pass can
  // start mid-loop — and since a lagging index now rebuilds because someone
  // asked it a question, that is common rather than rare. When it happened, the
  // real `gitnexus analyze` was found before the decoy and the vector case read
  // as 'graph': a true answer about the wrong process, failing a correct test.
  if (!settle(true)) {
    console.log(`note: a real pass started — skipping the "${expected}" case`);
    continue;
  }
  const pid = sleeper(title);
  try {
    settle(false);   // wait for it to appear in the process table
    assert.equal(indexRunning(), expected, `a running "${title}" must be seen as ${expected}`);
  } finally { try { process.kill(pid, 'SIGKILL'); } catch {} reapDecoys(); }
}
if (quiet) assert.ok(settle(true), 'the decoys were reaped');

// A process that merely NAMES a pass is not a pass. An unanchored check matched
// a shell running `grep "gitnexus analyze"` — and every refresh then skipped,
// silently, for a reason nobody could see from the outside.
if (quiet) {
  const bystander = sleeper('grep -rn "gitnexus analyze --index-only" src');
  try {
  for (let i = 0; i < 10; i++) execFileSync('sleep', ['0.05']);
  assert.equal(indexRunning(), null, 'merely mentioning a pass must not look like one');
  } finally { try { process.kill(bystander, 'SIGKILL'); } catch {} }
}

// ── a cached layer answer is only valid for the index it described ──────────
const repo = mkdtempSync(join(tmpdir(), 'lens-layers-'));
mkdirSync(join(repo, '.gitnexus'), { recursive: true });
const writeMeta = (stamp) => writeFileSync(join(repo, '.gitnexus', 'meta.json'),
  JSON.stringify({ lastCommit: 'b'.repeat(40), indexedAt: stamp }));

writeMeta('2026-08-29T01:00:00.000Z');
const state = { layers: { pdg: false, embeddings: false }, layersFor: '2026-08-29T01:00:00.000Z' };
// The engine is unreachable here, so any re-probe answers "no layers" — which
// means a WRONG cache hit is indistinguishable from a correct one by result.
// What is observable is whether the cache was trusted: a hit leaves the stamp
// untouched, a re-probe rewrites it.
const before = { ...state };
await detectLayers('repo', state, repo, 200);
assert.equal(state.layersFor, before.layersFor, 'the cache is used while it still describes this index');

writeMeta('2026-08-29T02:30:00.000Z');   // someone rebuilt, or added a layer by hand
await detectLayers('repo', state, repo, 200);
assert.equal(state.layersFor, '2026-08-29T02:30:00.000Z',
  'a rewritten index invalidates the cached layer answer');

// A layer that was once there stays REQUESTED even when the probe finds nothing.
// Observation alone made loss permanent: the control-flow layer was rebuilt by
// hand twice on a large monorepo and deleted by the next refresh both times,
// because the refresh asked the damaged index what it should contain.
writeMeta('2026-08-29T03:00:00.000Z');
const latched = { wantPdg: true };
const layers = await detectLayers('repo', latched, repo, 200);   // engine unreachable → probes 0
assert.equal(layers.pdg, true,
  'a layer the index is meant to carry is re-requested even when the probe sees none');


// ── one engine configuration, wherever a refresh is launched from ───────────
// An interrupted vector pass leaves a checkpoint that records HOW the vectors
// were made. Launch the next rebuild without that configuration and the engine
// refuses the whole thing — measured: every graph refresh for a repository
// failed until the config was shared instead of living in a service unit.
const envDir = mkdtempSync(join(tmpdir(), 'lens-env-'));
const envFile = join(envDir, 'engine-env');
writeFileSync(envFile, [
  '# a comment, and a blank line follow',
  '',
  'GITNEXUS_EMBEDDING_URL=http://127.0.0.1:52625/v1',
  'GITNEXUS_EMBEDDING_MODEL="embed-gemma"',
  'CUDA_VISIBLE_DEVICES=',
  'GITNEXUS_EMBEDDING_DIMS=768',
].join('\n'));
const env = { GITNEXUS_EMBEDDING_MODEL: 'set-by-hand' };
const applied = loadEngineEnv(envFile, env);
assert.equal(env.GITNEXUS_EMBEDDING_URL, 'http://127.0.0.1:52625/v1', 'the shared config is applied');
assert.equal(env.CUDA_VISIBLE_DEVICES, '', 'an empty value is a real value, not an absence');
assert.equal(env.GITNEXUS_EMBEDDING_MODEL, 'set-by-hand', 'a deliberate override is never overruled');
assert.ok(!applied.includes('GITNEXUS_EMBEDDING_MODEL'), 'and is not reported as applied');
assert.deepEqual(loadEngineEnv(join(envDir, 'absent'), {}), [], 'no file is an ordinary case');
rmSync(envDir, { recursive: true, force: true });

rmSync(repo, { recursive: true, force: true });
console.log('ok — no refresh starts on top of another pass, and no stale layer answer survives a rebuild');
// The graph engine keeps its connection alive and exposes no way to close it;
// the refresh command exits the process instead. Do the same rather than hang.
reapDecoys();
process.exit(0);


// ── a pass may not revert what it never read ────────────────────────────────
// State is read when a pass starts and written when it ends, minutes later.
// Anything set in between used to vanish: `wantPdg`, set by hand to stop the
// control-flow layer being deleted, was reverted by a pass already in flight,
// and the layer was then rebuilt without it.
{
  const file = join(mkdtempSync(join(tmpdir(), 'lens-state-')), 'refresh-state.json');
  writeFileSync(file, JSON.stringify({ alpha: { graphMs: 1, wantPdg: true }, beta: { graphMs: 2 } }));
  saveState({ alpha: { graphMs: 99 } }, file);          // a pass that only ever saw alpha
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(after.alpha.wantPdg, true, 'a field written mid-pass survives the pass that never read it');
  assert.equal(after.alpha.graphMs, 99, 'the pass still records what it measured');
  assert.equal(after.beta.graphMs, 2, 'a repo this pass never touched is left alone');
}


// ── cost decides the wait, in proportion — never as a cliff ─────────────────
// The old rule deferred anything over 60s by a full hour. a large monorepo came
// in at 121s and sat 19-43 commits behind permanently; after the scope fix it
// came in at 58.7s, on the same cliff from the other side. A second of measured
// cost must not decide an hour of staleness.
assert.equal(minGapMs(5_000), 50_000, 'a cheap repo waits a trivial gap and refreshes every cycle');
assert.equal(minGapMs(58_700), 587_000, 'the measured cost of this repo stays under a 15-minute cycle');
assert.equal(minGapMs(121_000), 1_210_000, 'twice the cost buys twice the wait, not twenty times');
assert.equal(minGapMs(3_600_000), 3_600_000, 'and nothing is ever deferred beyond an hour');
assert.equal(minGapMs(), 0, 'a repo never measured is due now');


// ── a lagging index heals because it was READ, not because a clock fired ────
// The timer lost the race on a repo committing ~8 times an hour: measured
// 19-43 commits behind at all times. Graft puts the rebuild inside the query
// (trailhq/Graft, src/graph/refresh.ts); ours is far too slow to block an
// answer, so the TRIGGER moves to the read path instead and the answer still
// goes out immediately.
{
  const { healIfStale, resetHealState, HEAL_AT_COMMITS } = await import('../dist/core/heal.js');
  const spawned = [];
  const spawnFn = (bin, args, opts) => { spawned.push({ args, cwd: opts?.cwd }); return { on() {}, unref() {} }; };
  const at = (mins) => () => Date.parse('2026-09-02T00:00:00Z') + mins * 60_000;

  resetHealState();
  assert.equal(healIfStale('/repo', HEAL_AT_COMMITS - 1, { now: at(0), spawnFn }), undefined,
    'a nearly-current index is left alone');
  assert.deepEqual(spawned, [], 'and costs no rebuild');

  const note = healIfStale('/repo', 42, { now: at(0), spawnFn });
  assert.match(String(note), /42 commits behind/, 'a lagging index says it is repairing itself');
  assert.equal(spawned.length, 1, 'exactly one rebuild is started');
  assert.ok(spawned[0].args.includes('--graph-only'),
    'and only the cheap engine — an auto-rebuild must never spend the expensive one');

  healIfStale('/repo', 99, { now: at(1), spawnFn });
  assert.equal(spawned.length, 1, 'a second question a minute later does not queue a second pass');
  healIfStale('/other', 99, { now: at(1), spawnFn });
  assert.equal(spawned.length, 1, 'nor does a different repo while one is still in flight');
}
