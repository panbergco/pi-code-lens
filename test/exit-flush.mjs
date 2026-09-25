/**
 * A large answer piped to a slow reader must arrive whole.
 *
 * The CLI exits explicitly, and process.exit() does not wait for stdout: a
 * 262,401-byte answer arrived as 262,144 bytes when the reader was slow to
 * start. This drives a child the same way, with the old exit and the new one,
 * so the test is shown able to catch the loss before it is trusted to prove
 * the fix.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SIZE = 300_000;
const dir = mkdtempSync(join(tmpdir(), 'lens-exit-'));
const exitMod = new URL('../dist/core/exit.js', import.meta.url).href;
const child = (flush) => {
  const f = join(dir, flush ? 'new.mjs' : 'old.mjs');
  writeFileSync(f, flush
    ? `import { exitAfterFlush } from '${exitMod}';\nprocess.stdout.write('x'.repeat(${SIZE}));\nexitAfterFlush(0);`
    : `process.stdout.write('x'.repeat(${SIZE}));\nprocess.exit(0);`);
  return f;
};
// A reader that does not start draining for 300 ms, as a slow program does.
const received = (script) => Number(execFileSync('bash',
  ['-c', `node '${script}' | (sleep 0.3; wc -c)`], { encoding: 'utf8' }).trim());

try {
  const old = [1, 2, 3].map(() => received(child(false)));
  assert.ok(old.some((n) => n < SIZE),
    `control: the old exit must lose output here, or this test cannot see the bug (got ${old})`);

  const fixed = [1, 2, 3].map(() => received(child(true)));
  assert.deepEqual(fixed, [SIZE, SIZE, SIZE], 'every byte arrives when the exit waits for the flush');

  // A reader that closes early must not hang the exit.
  const t0 = Date.now();
  const early = execFileSync('bash', ['-c', `node '${child(true)}' 2>'${dir}/err.txt' | head -c 10 >/dev/null; cat '${dir}/err.txt'`],
    { encoding: 'utf8' });
  assert.ok(Date.now() - t0 < 10_000, 'a reader that goes away early releases the exit');
  assert.ok(!/EPIPE|Unhandled/.test(early), `and prints no stack trace over it (got: ${early.slice(0, 120)})`);
  console.log(`ok — piped output arrives whole (old exit delivered ${old.join(', ')} of ${SIZE} bytes)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
