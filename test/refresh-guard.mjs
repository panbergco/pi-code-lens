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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectLayers, indexRunning, loadEngineEnv } from '../dist/commands/refresh.js';

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
  if (!quiet) continue;
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
