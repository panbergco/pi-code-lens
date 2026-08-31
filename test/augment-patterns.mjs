/**
 * The enrichment is only as good as its reading of the search. A wrong subject
 * spends context on an irrelevant answer, which is how an appended block earns
 * being ignored — so the extraction rules get a real test.
 */
import assert from 'node:assert/strict';
import { isUsefulSubject, literalFromRegex, searchSubject, subjectsFromOutput, tokenizeCommand } from '../dist/core/augment.js';

// A regex is not a query: keep the longest literal run.
assert.equal(literalFromRegex('handle(Inbox|Mail)Delivery'), 'Delivery');
assert.equal(literalFromRegex('^\\s*$'), null);

// Quotes hold a pattern together; a pipe ends one command and starts another.
assert.deepEqual(tokenizeCommand(`grep -n "two words" x.ts | head -3`),
  ['grep', '-n', 'two words', 'x.ts', '|', 'head', '-3']);

// The pattern belongs to grep, never to whatever ran before the pipe.
assert.equal(searchSubject('bash', { command: 'ls packages | grep premiseVerdicts' }), 'premiseVerdicts');
assert.equal(searchSubject('bash', { command: 'cd /repo && rg -nE "consumeInbox|pendingInbox" src' }), 'consumeInbox');
assert.equal(searchSubject('bash', { command: "sed -n '1,30p' packages/core/src/tick.ts" }), 'tick');
assert.equal(searchSubject('bash', { command: 'find . -name "write-lane.ts"' }), 'write-lane');
assert.equal(searchSubject('grep', { pattern: 'cmdMaintenance' }), 'cmdMaintenance');
assert.equal(searchSubject('read', { path: 'packages/core/src/store.ts' }), 'store');

// Silence is the correct answer for anything that is not a code question.
assert.equal(searchSubject('bash', { command: 'tail -50 /var/log/syslog' }), null);
assert.equal(searchSubject('bash', { command: 'ls -la' }), null);
assert.equal(searchSubject('read', { path: 'notes.txt' }), null);
assert.equal(searchSubject('grep', { pattern: 'ab' }), null);

// Measured waste: 33 of 37 live enrichments were about words like these, so they
// must never reach a lookup at all.
for (const junk of ['function', 'scopes', 'project', 'SKILL', 'index', 'status', 'test', 'working', 'fail'])
  assert.equal(isUsefulSubject(junk), false, `"${junk}" should never be looked up`);
for (const real of ['premiseVerdicts', 'write-lane', 'cmdMaintenance', 'consumeInbox', 'cutover'])
  assert.equal(isUsefulSubject(real), true, `"${real}" is a real subject`);
// Short, ordinary-looking words are the MOST valuable subjects in a real
// codebase, and the old shape rule refused them: measured, `sprint` was searched
// 47 times and has 13 callers, `tick` 18 times with 15, `store` 10 times with 62.
for (const real of ['sprint', 'tick', 'lanes', 'store', 'witness', 'declared'])
  assert.equal(isUsefulSubject(real), true, `"${real}" is a name the index can answer`);
assert.equal(searchSubject('grep', { pattern: 'function' }), null);
assert.equal(searchSubject('read', { path: 'packages/core/src/index.ts' }), null);

// Where the search landed is the other half of the question.
assert.deepEqual(
  subjectsFromOutput('packages/core/src/write-lane.ts:886:  const owner =\nREADME.md:3:x\nsrc/store.ts:12:  y'),
  ['write-lane', 'store'],
);

console.log('ok — a search is read for its subject, and stays silent when there is not one');

// ── The decision itself: when is a search worth answering at all? ─────────────
// (the behaviour pi-gitnexus covers with ten hook tests)
const { subjectsForSearch } = await import('../dist/core/augment.js');
const memory = () => ({ answered: new Set(), unanswerable: new Set() });
const grepOut = 'packages/core/src/write-lane.ts:886:  const owner = lanes.find(x)\nsrc/store.ts:12:  const y = 1';

assert.deepEqual(subjectsForSearch('edit', { path: 'a.ts' }, grepOut, memory()), [],
  'only search-shaped tools are answered');
assert.deepEqual(subjectsForSearch('bash', { command: 'grep -rn cmdMaintenance src' }, 'x', memory()), [],
  'a search that found nothing asks nothing');
assert.deepEqual(subjectsForSearch('bash', { command: 'lens ask "where is x"' }, grepOut, memory()), [],
  'the lens must never answer itself');

const first = subjectsForSearch('bash', { command: 'grep -rn cmdMaintenance src' }, grepOut, memory());
assert.deepEqual(first, ['cmdMaintenance', 'write-lane', 'store'], 'pattern first, then where it landed');

const known = memory(); known.answered.add('cmdmaintenance'); known.unanswerable.add('store');
assert.deepEqual(subjectsForSearch('bash', { command: 'grep -rn cmdMaintenance src' }, grepOut, known),
  ['write-lane'], 'a subject is answered once, and a dead end is not retried');

assert.equal(subjectsForSearch('bash', { command: 'grep -rn cmdMaintenance src' }, grepOut, memory(), 1).length, 1,
  'the cap is honoured');
assert.deepEqual(subjectsForSearch('read', { path: 'packages/core/src/tick.ts' }, grepOut, memory()), ['tick'],
  'reading a file asks about that file, not about where a search landed');

console.log('ok — a search is answered only when there is a real subject and something new to say');
