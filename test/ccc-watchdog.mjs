/**
 * A semantic pass that stops making progress is stopped, and the daemon holding
 * the stuck job is restarted — with the GPU visible.
 *
 * Measured twice in one day: `ccc index` sat on its last 8 of 1,160 files with
 * the daemon idle (1 h 26 min, then 37+ min) while holding the machine-wide
 * refresh lock. The job lived inside the daemon, so killing the client did not
 * clear it. A fake `ccc` on PATH plays each role here.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'lens-ccc-'));
writeFileSync(join(dir, 'ccc'), `#!/bin/bash
D="${dir}"
case "$1" in
  index)  [ -f "$D/stall" ] && exec sleep 30
          [ -f "$D/slow" ] && sleep 1.5
          echo "3 added"; exit 0 ;;
  status) if [ -f "$D/slow" ]; then n=$(( $(cat "$D/n" 2>/dev/null || echo 0) + 1 )); echo $n > "$D/n"
          else n=4; fi
          echo "Indexing in progress: 5 files listed | 0 added, 0 deleted, 0 reprocessed, $n unchanged, error: 0" ;;
  daemon) touch "$D/restarted"; env | grep -c "^CUDA_VISIBLE_DEVICES=" > "$D/mask"; exit 0 ;;
esac
`);
chmodSync(join(dir, 'ccc'), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
process.env.CUDA_VISIBLE_DEVICES = '';
// Never this machine's real daemon: the stall path signals whatever pid the home's daemon.pid names.
const home = mkdtempSync(join(tmpdir(), 'lens-ccc-home-'));
process.env.HOME = home;     // the empty mask that blinds the daemon, as leaked here before
const { cccIndexWatched } = await import('../dist/commands/refresh.js');

try {
  const ok = await cccIndexWatched(dir, 300, 100);
  assert.match(ok.stdout, /3 added/, 'a pass that finishes is untouched');

  writeFileSync(join(dir, 'slow'), '');
  const moving = await cccIndexWatched(dir, 300, 100);
  assert.match(moving.stdout, /3 added/, 'a slow pass whose progress moves is never stopped');
  rmSync(join(dir, 'slow'));

  writeFileSync(join(dir, 'stall'), '');
  const t0 = Date.now();
  await assert.rejects(cccIndexWatched(dir, 300, 100),
    /stalled: no progress .*4 unchanged.* ccc daemon restarted; no stall evidence captured/, 'a pass stuck on the same progress is stopped and says why');
  assert.ok(Date.now() - t0 < 5_000, 'within the stall window, not the 4-hour timeout');
  assert.ok(existsSync(join(dir, 'restarted')), 'and the daemon holding the stuck job is restarted');
  assert.equal(readFileSync(join(dir, 'mask'), 'utf8').trim(), '0',
    'without the empty GPU mask the caller carried — a restart with it leaves the daemon blind to the GPU');
  // With a daemon that can record where it is stuck, the evidence is taken
  // BEFORE the restart erases it, and the failure names the file.
  const fake = spawn(process.execPath, ['-e', `
    const fs = require('fs');
    process.on('SIGUSR1', () => { fs.mkdirSync(process.argv[1] + '/.code-lens/stalls', { recursive: true });
      fs.writeFileSync(process.argv[1] + '/.code-lens/stalls/ccc-' + process.pid + '-now.txt', '== threads\\n'); });
    setInterval(() => {}, 1000);`, home], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 300));
  mkdirSync(join(home, '.cocoindex_code'), { recursive: true });
  writeFileSync(join(home, '.cocoindex_code', 'daemon.pid'), String(fake.pid));
  try {
    await assert.rejects(cccIndexWatched(dir, 300, 100),
      new RegExp(`evidence: .*stalls/ccc-${fake.pid}-now\\.txt`), 'the stall names the evidence the daemon wrote');
  } finally { fake.kill(); }
  console.log('ok — a stalled semantic pass is stopped and its daemon restarted, GPU intact');
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
process.exit(0);
