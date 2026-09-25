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
// REVERSED, deliberately. This used to assert that an empty result asks no
// question. Measured on a large monorepo: 2,933 searches in 24 hours returned
// empty or non-zero — 18% of every code search — and they are the ones where
// the agent learned nothing and rewords the pattern rather than asking the
// index. An empty result is the loudest question a search can ask.
assert.deepEqual(subjectsForSearch('bash', { command: 'grep -rn cmdMaintenance src' }, 'x', memory()),
  ['cmdMaintenance'],
  'a search that found nothing is exactly when the index should speak');
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


// ── a search that found NOTHING is the best moment to speak ─────────────────
// Errors and short output used to be skipped outright. Measured on
// a large monorepo: 2,933 searches in 24 hours came back empty or non-zero — 18%
// of every code search — and those are exactly the ones where the agent learned
// nothing and is about to reword the pattern and try again.
{
  const { foundNothing, subjectsForSearch } = await import('../dist/core/augment.js');
  const fresh = () => ({ answered: new Set(), unanswerable: new Set() });

  assert.equal(foundNothing('', true), true, 'grep exiting 1 with no output found nothing');
  assert.equal(foundNothing('  \n ', false), true, 'blank output found nothing');
  assert.equal(foundNothing('bash: rg: command not found', true), false,
    'a missing binary is a fact about the command, not about the code');
  assert.equal(foundNothing('grep: packages/nope.ts: No such file or directory', true), false,
    'a bad path is the shell failing, and the index has nothing to add');
  assert.equal(foundNothing('src/lane.ts:88:export function writeLane() {\nsrc/b.ts:2: writeLane()'), false,
    'a search that found something did not find nothing');

  assert.deepEqual(
    subjectsForSearch('bash', { command: 'grep -rn "claimSlice" packages/core/src' }, '', fresh()),
    ['claimSlice'], 'an empty result still asks its question');
  assert.deepEqual(
    subjectsForSearch('bash', { command: 'grep -rn "claimSlice" packages' }, 'bash: grep: command not found', fresh()),
    [], 'a broken shell still gets silence');
}


// ── a pipe is not a search ──────────────────────────────────────────────────
// Measured on a large monorepo: agents pipe test runs and database queries through
// grep constantly, and every one was read as a question about whatever word
// followed — `vitest run … | grep -E "verdict|FAIL"` was answered with the
// callers of `verdict`. Context spent on something nobody asked, and an
// effectiveness denominator inflated by hundreds of "searches" an hour that were
// people watching output scroll past.
//
// The distinction is what feeds the pipe: a LISTING is still the codebase.
assert.equal(searchSubject('bash', { command: 'node main.js suite npx vitest run x.test.ts 2>&1 | grep -E "verdict|FAIL"' }),
  null, 'filtering a test run is not a question about code');
assert.equal(searchSubject('bash', { command: 'mytool query "select * from findings" | grep -c verdict' }),
  null, 'counting rows in query output is not a question about code');
assert.equal(searchSubject('bash', { command: 'ls packages | grep premiseVerdicts' }),
  'premiseVerdicts', 'but filtering a file listing still asks where something lives');
assert.equal(searchSubject('bash', { command: 'git ls-files | grep claimSlice' }),
  'claimSlice', 'and so does filtering the tracked files');

// Sequencing is not piping: everything before `;` or `&&` merely ran first.
assert.equal(searchSubject('bash', { command: 'date; cd /repo; grep -rn "archiveSprint" src/sprint.ts' }),
  'archiveSprint', 'a search after a sequence separator is still a search');
assert.equal(searchSubject('bash', { command: 'cd /repo && rg -n "parseRoadmap" packages/core | head -3' }),
  'parseRoadmap', 'and piping its RESULTS into head changes nothing');


// ── a prompt is asked about only what it names as code ──────────────────────
// Six real prompts, replayed: asked whole, every one routed to the 430-550 ms
// prose path and missed the prompt hook's 400 ms wall. A named symbol answers
// in ~212 ms. Prose is what the agent's own lens_ask is for.
{
  const { promptSubjects } = await import('../dist/core/augment.js');
  assert.deepEqual(promptSubjects('who needs to fix it? Queries against the database that take longer than 0.5 seconds'), [],
    'prose names no code');
  assert.deepEqual(promptSubjects('how long did that sprint take to close and which flow and stages'), [],
    'and an English word that is also a symbol is not enough');
  assert.deepEqual(promptSubjects('what calls reconcileCommit?'), ['reconcileCommit'], 'camelCase is code');
  assert.deepEqual(promptSubjects('where is sprint_n set?'), ['sprint_n'], 'so is snake_case');
  assert.deepEqual(promptSubjects('look at packages/core/src/lane-mint.ts'), ['lane-mint'], 'and a source path names its file');
  assert.deepEqual(promptSubjects('explain `tick` in detail'), ['tick'], 'backticks mark code even when the word is plain');
  assert.deepEqual(promptSubjects('look at `lane-mint` please'), ['lane-mint'], 'including a module name with a hyphen');
  assert.deepEqual(promptSubjects('fix fooBar, then barBaz, then bazQux'), ['fooBar', 'barBaz'], 'at most two, in order');
  assert.deepEqual(promptSubjects('fooBar and FOOBAR and fooBar again'), ['fooBar'], 'each once');
}
console.log('ok — a prompt is asked about only the code it names');


// ── an automatic answer carries the index's own warnings ────────────────────
// They used to be read only to decide whether to stay silent, so a stale answer
// arrived looking exactly like a fresh one. Commit lag below the rebuild point
// is left out on purpose: a busy repository is nearly always a commit behind,
// and a warning on every answer is one nobody reads.
{
  const { freshnessCaveat, CAVEAT_AT_COMMITS } = await import('../dist/core/augment.js');
  assert.equal(freshnessCaveat([]), '', 'no notes, no line');
  assert.equal(freshnessCaveat(['structure is 1 commit behind HEAD (indexed abc)']), '',
    'a commit or two behind is normal, and not worth a line');
  assert.match(freshnessCaveat([`structure is ${CAVEAT_AT_COMMITS} commits behind HEAD (indexed abc)`]),
    /^\n! structure is 5 commits behind/, 'from the rebuild point, lag is stated');
  assert.match(freshnessCaveat(['structure is being rebuilt right now — callers may be missing']),
    /being rebuilt/, 'a rebuild in flight is always stated');
  assert.match(freshnessCaveat(['structure is 2 commits behind HEAD (indexed abc) · 3 files edited since indexing (a.ts, b.ts, c.ts)']),
    /edited since indexing \(a\.ts/, 'and so are files edited since, which is where an answer is most likely wrong');
  const many = freshnessCaveat(['structure is being rebuilt right now', 'x edited since indexing', 'structure is 9 commits behind HEAD']);
  assert.equal(many.trim().split('\n').length, 2, 'at most two lines');
}

// ── counts are what was found, never a total ────────────────────────────────
{
  const { fuse, DEFAULT_WEIGHTS } = await import('../dist/core/fuse.js');
  const spots = fuse([{ file: 'a.ts', startLine: 1, symbol: 'f', source: 'graph', relevance: 1 }],
    new Map([['a.ts:1', { callers: ['x', 'y', 'z'], callees: [], flows: [] }]]), DEFAULT_WEIGHTS);
  assert.ok(spots[0].signals.some((s) => s === '3 callers found'),
    `a static graph reports callers it found, not all there are (got ${spots[0].signals})`);
}
console.log('ok — automatic answers carry their caveats, and counts say "found"');
