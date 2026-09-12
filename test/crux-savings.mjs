/**
 * A pointer is not an answer, and a claim of value must be measurable.
 *
 * Both rules come from Graft (trailhq/Graft, MIT): carry the lines that do the
 * work rather than an address, and omit a savings estimate rather than fake one.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crux, CRUX_LINES } from '../dist/core/crux.js';
import { savingsLine, toTokens, baselineChars, MAX_FILE_CHARS } from '../dist/core/savings.js';

const dir = mkdtempSync(join(tmpdir(), 'lens-crux-'));
try {
  mkdirSync(join(dir, 'src'), { recursive: true });
  const file = 'src/lane.ts';
  writeFileSync(join(dir, file), [
    'import { store } from "./store";',            // 1
    '',                                             // 2
    '// the guard that actually matters',           // 3
    'export function writeLane(id: string) {',      // 4
    '  if (!id) return refuse("no lane named");',   // 5
    '  const held = store.get(id);',                // 6
    '  if (held) return refuse("already held");',   // 7
    '',                                             // 8
    '  return grant(id);',                          // 9
    '}',                                            // 10
  ].join('\n'));

  // ── the lines, not the address ────────────────────────────────────────────
  const lifted = crux(file, 4, dir);
  assert.match(lifted, /export function writeLane/, 'the crux starts at the line it was given');
  assert.match(lifted, /already held/, 'and carries the guards below it');
  assert.ok(!/^\s*\/\//m.test(lifted), 'comment-only lines are not what the budget is for');
  assert.ok(lifted.split('\n').length <= CRUX_LINES, 'and it stays small enough to ride in a turn');
  assert.ok(!/^\s+import/.test(lifted), 'it stops at the blank line, not at the end of the file');

  // Silence beats a misleading excerpt.
  assert.equal(crux(file, 9999, dir), undefined, 'a line past the end of a moved file says nothing');
  assert.equal(crux('src/gone.ts', 4, dir), undefined, 'an unreadable file says nothing');
  assert.equal(crux(file, undefined, dir), undefined, 'a spot with no line says nothing');

  writeFileSync(join(dir, 'src/min.js'), `const x=${'a'.repeat(400)};`);
  assert.equal(crux('src/min.js', 1, dir), undefined, 'a generated or minified line is never lifted');

  // ── a saving is claimed only when it is real ──────────────────────────────
  const base = baselineChars([file], dir);
  assert.equal(base.files, 1, 'the baseline is the files the answer points at');
  assert.ok(base.chars > 0);

  const small = savingsLine('3 callers', [file], dir);
  assert.match(small, /tokens saved/, 'a block far smaller than the file it replaces says what it saved');
  assert.match(small, new RegExp(`${toTokens(base.chars)}`.slice(0, 2)), 'against the real file size');

  assert.equal(savingsLine('x'.repeat(100_000), [file], dir), undefined,
    'a block bigger than the source saved nothing, and says nothing');
  // Nobody reads a 207KB file to learn who calls one function. Uncapped, a
  // two-line answer about one such file claimed "51,819 tokens saved (100%)" —
  // arithmetic nobody believes, which discredits the honest numbers beside it.
  writeFileSync(join(dir, 'src/huge.ts'), 'x'.repeat(500_000));
  const capped = savingsLine('3 callers', ['src/huge.ts'], dir);
  assert.ok(toTokens(MAX_FILE_CHARS) >= Number(/~([\d,]+) tokens saved/.exec(capped)[1].replace(/,/g, '')),
    'one enormous file cannot inflate the claim beyond a plausible read');

  assert.equal(savingsLine('3 callers', ['src/gone.ts'], dir), undefined,
    'an unmeasurable baseline is omitted, never invented');
  assert.equal(savingsLine('3 callers', [], dir), undefined, 'no files, no claim');

  console.log('ok — answers carry their crux, and only claim savings they can measure');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
