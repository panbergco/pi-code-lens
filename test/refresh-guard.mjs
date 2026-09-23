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
// The old rule deferred anything over 60s by a full hour. A large monorepo came
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
  const repoFlag = spawned[0].args.indexOf('--repo');
  assert.ok(repoFlag > 0 && spawned[0].args[repoFlag + 1] === 'repo',
    'and only the repository that was read — without --repo it walked all fifteen to heal one');

  healIfStale('/repo', 99, { now: at(1), spawnFn });
  assert.equal(spawned.length, 1, 'a second question a minute later does not queue a second pass');
  healIfStale('/other', 99, { now: at(1), spawnFn });
  assert.equal(spawned.length, 1, 'nor does a different repo while one is still in flight');
}


// ── layers come from the index's metadata, not from the shared server ───────
// The probe was two full-scan counts against a single-threaded server, re-run
// whenever an index was rewritten. One of them stalled the server ~20 s and an
// agent's own lens_breaks, issued in that window, waited 20.2 s for nothing.
// The metadata already records both layers; this must never touch the engine.
{
  const { layersFromMeta } = await import('../dist/commands/refresh.js');
  const dir = mkdtempSync(join(tmpdir(), 'lens-meta-'));
  mkdirSync(join(dir, '.gitnexus'), { recursive: true });
  const meta = (m) => writeFileSync(join(dir, '.gitnexus', 'meta.json'), JSON.stringify(m));

  meta({ indexedAt: 'a', pdg: { maxFunctionLines: 2000 }, stats: { embeddings: 0 } });
  assert.deepEqual(layersFromMeta(dir), { pdg: true, embeddings: false }, 'a pdg record means the control-flow layer exists');
  meta({ indexedAt: 'b', stats: { embeddings: 370 } });
  assert.deepEqual(layersFromMeta(dir), { pdg: false, embeddings: true }, 'and a vector count means embeddings exist');
  rmSync(join(dir, '.gitnexus', 'meta.json'));
  assert.equal(layersFromMeta(dir), undefined, 'no metadata is "unknown", not "no layers"');

  // Through detectLayers: fast, and without any engine at all.
  meta({ indexedAt: 'c', pdg: {}, stats: { embeddings: 0 } });
  const st = {};
  const t0 = Date.now();
  const layers = await detectLayers('repo', st, dir, 20_000);
  assert.ok(Date.now() - t0 < 500, `read from a file, not a 20 s server probe (${Date.now() - t0}ms)`);
  assert.equal(layers.pdg, true);
  assert.equal(st.wantPdg, true, 'and a layer seen once stays wanted');
  rmSync(dir, { recursive: true, force: true });
}

// ── a rebuild is judged per repository ──────────────────────────────────────
// Measured: while one repository was rebuilt, queries to another stayed at a
// 4 ms median. A machine-wide "is anything indexing" muted every repository
// for a pass on any one of them.
{
  const { graphRebuildingHere } = await import('../dist/commands/refresh.js');
  const mine = mkdtempSync(join(tmpdir(), 'lens-mine-'));
  const other = mkdtempSync(join(tmpdir(), 'lens-other-'));
  assert.equal(graphRebuildingHere(mine), false, 'nothing running, nothing rebuilding');

  // A decoy `gitnexus analyze` in the OTHER repository.
  // `cwd`, not `cd X && … &`: that form backgrounds the whole list in a
  // subshell, and the decoy dies with it the moment this shell exits.
  const pid = Number(execFileSync('bash',
    ['-c', `setsid nohup bash -c 'exec -a "/usr/bin/gitnexus analyze --index-only" sleep 5' >/dev/null 2>&1 & echo $!`],
    { encoding: 'utf8', cwd: other }).trim());
  decoys.push(pid);
  for (let i = 0; i < 40 && !graphRebuildingHere(other); i++) execFileSync('sleep', ['0.05']);
  try {
    assert.equal(graphRebuildingHere(other), true, 'a pass in a repository is seen there');
    assert.equal(graphRebuildingHere(mine), false, 'and not anywhere else');
  } finally { reapDecoys(); }

  // The engine's own lock counts too, but only while its owner is alive.
  mkdirSync(join(mine, '.gitnexus'), { recursive: true });
  writeFileSync(join(mine, '.gitnexus', 'analyze.lock'), JSON.stringify({ v: 1, pid: process.pid }));
  assert.equal(graphRebuildingHere(mine), true, 'a live lock owner means a rebuild');
  writeFileSync(join(mine, '.gitnexus', 'analyze.lock'), JSON.stringify({ v: 1, pid: 2 ** 22 + 7 }));
  assert.equal(graphRebuildingHere(mine), false, 'a lock left by a dead process means nothing');
  rmSync(mine, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true });
}
console.log('ok — layers read from metadata, and a rebuild only mutes its own repository');

// ── "already up to date" is decided here, by the engine's own rule ──────────
// A refresh launched the engine for every registered repository to hear
// "already up to date" — ~2 s each, fifteen repositories, most of a 2-4 minute
// cycle. The rule is copied from the engine, so it may only ever skip what the
// engine itself would have skipped: checked against the engine on 8 of 8.
{
  const { graphUpToDate } = await import('../dist/commands/refresh.js');
  const dir = mkdtempSync(join(tmpdir(), 'lens-uptodate-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  git('add', '.'); git('commit', '-qm', 'one');
  mkdirSync(join(dir, '.gitnexus'), { recursive: true });
  const meta = (m) => writeFileSync(join(dir, '.gitnexus', 'meta.json'), JSON.stringify(m));

  meta({ lastCommit: git('rev-parse', 'HEAD') });
  assert.equal(graphUpToDate(dir), true, 'indexed commit is HEAD and the tree is clean: nothing to launch');
  writeFileSync(join(dir, 'AGENTS.md'), 'stats the engine rewrote');
  assert.equal(graphUpToDate(dir), true, 'files the engine writes itself do not count as dirty');

  writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
  assert.equal(graphUpToDate(dir), false, 'an uncommitted edit still reaches the index');
  git('checkout', '-q', '--', 'a.ts');
  writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');
  assert.equal(graphUpToDate(dir), false, 'so does a new untracked file');
  rmSync(join(dir, 'b.ts'));

  git('commit', '-q', '--allow-empty', '-m', 'two');
  assert.equal(graphUpToDate(dir), false, 'a new commit needs the engine');
  meta({ lastCommit: git('rev-parse', 'HEAD'), embeddingCheckpoint: { batch: 3 } });
  assert.equal(graphUpToDate(dir), false, 'an unfinished embedding pass is never skipped');
  rmSync(join(dir, '.gitnexus', 'meta.json'));
  assert.equal(graphUpToDate(dir), false, 'and without metadata the engine decides, as it always did');
  rmSync(dir, { recursive: true, force: true });
}
console.log('ok — the engine is launched only when its own rule says there is work');

// The graph engine keeps its connection alive and exposes no way to close it;
// the refresh command exits the process instead. Do the same rather than hang.
//
// This exit sat in the MIDDLE of the file for weeks, and every block appended
// below it — the state-merge guard, proportional cadence, heal-on-read — never
// executed while the suite reported green. It must stay the last statement.
reapDecoys();
process.exit(0);
