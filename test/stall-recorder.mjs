/**
 * The stall recorder is installed into every ccc environment, kept current, and
 * restored after an upgrade replaces it; never into anything else.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureStallRecorder, cccSitePackages, RECORDER_SOURCE } from '../dist/core/stall-recorder.js';

const home = mkdtempSync(join(tmpdir(), 'lens-recorder-'));
const tools = join(home, '.local', 'share', 'uv', 'tools');
const sp = (env) => join(tools, env, 'lib', 'python3.14', 'site-packages');
try {
  for (const env of ['cocoindex-code', 'cocoindex-code-rocm', 'some-other-tool']) mkdirSync(sp(env), { recursive: true });
  assert.deepEqual(cccSitePackages(home).map((p) => p.split('/tools/')[1].split('/')[0]).sort(),
    ['cocoindex-code', 'cocoindex-code-rocm'], 'only ccc environments are touched');
  assert.equal(ensureStallRecorder(home).length, 2, 'installed into both');
  assert.equal(readFileSync(join(sp('cocoindex-code'), 'code_lens_stall_dump.py'), 'utf8'), RECORDER_SOURCE);
  assert.equal(readFileSync(join(sp('cocoindex-code'), 'code_lens_stall_dump.pth'), 'utf8').trim(), 'import code_lens_stall_dump');
  assert.ok(!existsSync(join(sp('some-other-tool'), 'code_lens_stall_dump.py')), 'and nowhere else');
  assert.deepEqual(ensureStallRecorder(home), [], 'a second run changes nothing');
  rmSync(join(sp('cocoindex-code'), 'code_lens_stall_dump.pth'));
  writeFileSync(join(sp('cocoindex-code-rocm'), 'code_lens_stall_dump.py'), '# old');
  assert.equal(ensureStallRecorder(home).length, 2, 'a removed or outdated copy is restored');
  assert.ok(RECORDER_SOURCE.includes('"run-daemon" in a'), 'and it activates only inside the daemon');
  console.log('ok — the stall recorder is installed into ccc environments only, and kept current');
} finally {
  rmSync(home, { recursive: true, force: true });
}
