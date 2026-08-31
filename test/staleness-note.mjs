/**
 * The staleness note is the only thing standing between a reader and an answer
 * about code that no longer exists, so it gets a real git repository rather
 * than a mocked one: the failure mode being guarded is a wrong commit count.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { staleness } from '../dist/core/ask.js';

const dir = mkdtempSync(join(new URL('../.scratch/', import.meta.url).pathname, 'staleness-'));
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const meta = (commit) => {
  mkdirSync(join(dir, '.gitnexus'), { recursive: true });
  writeFileSync(join(dir, '.gitnexus', 'meta.json'), JSON.stringify({ lastCommit: commit }));
};

try {
  assert.equal(staleness(dir), undefined, 'a repo with no graph index says nothing');

  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(dir, 'a.txt'), 'one');
  git('add', '-A'); git('commit', '-qm', 'first');
  const first = git('rev-parse', 'HEAD');

  meta(first);
  assert.equal(staleness(dir), undefined, 'index at HEAD must not warn');

  writeFileSync(join(dir, 'a.txt'), 'two');
  git('commit', '-qam', 'second');
  const behind = staleness(dir);
  assert.match(behind, /structure is 1 commit behind HEAD/, behind);
  assert.match(behind, new RegExp(first.slice(0, 9)), 'names the commit actually indexed');

  // A squash or force-push can strip the indexed commit out of history; counting
  // then fails, and silently reporting "0 behind" would be the lie that matters.
  meta('0'.repeat(40));
  assert.match(staleness(dir), /no longer in this branch's history/);

  console.log('ok — a stale, or orphaned, structural index says so on the answer');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
