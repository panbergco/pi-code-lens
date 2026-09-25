/**
 * The delivery log: written when a decision is made, read back by `lens kpi`.
 * It must never fail an answer, must stay small, must be switchable off, and
 * must survive the torn last line a crash leaves behind.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, writeFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordDelivery, readDeliveries, deliveryLogPath, MAX_LOG_BYTES } from '../dist/core/deliveries.js';

const home = mkdtempSync(join(tmpdir(), 'lens-deliv-'));
const cwd = '/work/some-repo';
try {
  recordDelivery(cwd, { channel: 'search', outcome: 'delivered', reason: 'answered', subjects: ['claimSlice'], ms: 12, bytes: 300 }, home);
  recordDelivery(cwd, { channel: 'prompt', outcome: 'silent', reason: 'names no code' }, home);
  const log = readDeliveries(cwd, 0, home);
  assert.equal(log.length, 2, 'every decision is one line');
  assert.equal(log[0].channel, 'search'); assert.equal(log[1].reason, 'names no code');
  assert.ok(deliveryLogPath(cwd, home).endsWith('/deliveries/some-repo.jsonl'), 'one file per repository');
  assert.equal(readDeliveries('/work/other-repo', 0, home).length, 0, 'and repositories never mix');

  assert.equal(readDeliveries(cwd, Date.now() + 60_000, home).length, 0, 'the window is honoured');

  appendFileSync(deliveryLogPath(cwd, home), '{"t": 1, "chan');       // a crash mid-write
  assert.equal(readDeliveries(cwd, 0, home).length, 2, 'a torn last line is skipped, not fatal');

  process.env.LENS_DELIVERY_LOG = '0';
  recordDelivery(cwd, { channel: 'edit', outcome: 'delivered', reason: 'dependents' }, home);
  delete process.env.LENS_DELIVERY_LOG;
  assert.equal(readDeliveries(cwd, 0, home).length, 2, 'LENS_DELIVERY_LOG=0 turns it off');

  writeFileSync(deliveryLogPath(cwd, home), 'x'.repeat(MAX_LOG_BYTES + 1));
  recordDelivery(cwd, { channel: 'map', outcome: 'delivered', reason: 'first turn' }, home);
  assert.ok(existsSync(`${deliveryLogPath(cwd, home)}.1`), 'past the cap, the old log is rotated aside');
  assert.ok(statSync(deliveryLogPath(cwd, home)).size < 1000, 'and a fresh one begins');

  // An unwritable or strange home must neither throw nor hang the answer being
  // delivered. /proc is the nasty one: a recursive mkdir spun forever there.
  for (const bad of ['/proc/1/nope', '/etc/passwd/nope', '/nonexistent/deep/home']) {
    const t0 = Date.now();
    assert.doesNotThrow(() => recordDelivery(cwd, { channel: 'search', outcome: 'silent', reason: 'x' }, bad));
    assert.ok(Date.now() - t0 < 1_000, `and returns at once for ${bad}`);
  }
  console.log('ok — the delivery log records, rotates, switches off, and never fails an answer');
} finally {
  rmSync(home, { recursive: true, force: true });
}
