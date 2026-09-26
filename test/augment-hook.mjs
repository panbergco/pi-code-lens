/**
 * The wiring, not the logic.
 *
 * The rules that decide WHAT to ask are tested next door. This drives the real
 * registered `tool_result` handler through a fake pi, because everything
 * between the decision and the model — appending the block, honouring the
 * toggle, remembering across calls, never answering itself, never blocking a
 * search when the engines hang — is only ever exercised in a live session, and
 * a live session is not a test.
 *
 * The engine call is stubbed at the network edge (the hot server), so nothing
 * here needs an index, a daemon, or a repository.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// This suite must not depend on whether the machine happens to be reindexing:
// the prompt hook correctly stays silent during a real pass, and a test that
// does not say so goes red to prove the feature works.
process.env.LENS_TEST_NO_PASS = '1';

// ── a repository that looks indexed, so freshness() does not veto ────────────
const repo = mkdtempSync(join(tmpdir(), 'lens-hook-'));
mkdirSync(join(repo, '.gitnexus'), { recursive: true });
writeFileSync(join(repo, '.gitnexus', 'meta.json'),
  JSON.stringify({ lastCommit: 'a'.repeat(40), indexedAt: new Date().toISOString() }));

// ── settings isolated from the real machine ─────────────────────────────────
process.env.HOME = repo;
mkdirSync(join(repo, '.code-lens'), { recursive: true });
// A deadline short enough that a hung engine is visible inside a test run.
writeFileSync(join(repo, '.code-lens', 'settings.json'), JSON.stringify({ timeoutMs: 1_000, repeatAfterMinutes: 0 }));

// ── stub the engines at the network edge ────────────────────────────────────
let answer = null;          // what the lens "finds"
let calls = [];             // questions actually asked
let delayMs = 0;            // how slow the engines are
let stubNotes = [];         // what the pipeline says about its own freshness
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init?.body ?? '{}');
  calls.push(body.question);
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  const spots = answer ? [answer] : [];
  return { ok: true, json: async () => ({ spots, ms: 12, notes: stubNotes, plan: { intent: 'breaks' } }) };
};

const structural = { file: 'src/lane.ts', line: 88, symbol: 'writeLane', score: 1, signals: ['semantic 1.00', '3 callers'], breaks: ['flow: deliver'], source: 'graph' };
const textualOnly = { file: 'src/lane.ts', line: 12, symbol: 'writeLane', score: 1, signals: ['semantic 0.90'], breaks: [], source: 'semantic' };

// ── a fake pi that records what the extension registers ─────────────────────
const handlers = {};
let notified = '';
const pi = {
  registerTool: () => {},
  getActiveTools: () => ['read', 'bash', 'lens_ask', 'lens_breaks', 'lens_graph', 'lens_semantic'],
  registerCommand: (_name, spec) => { handlers.command = spec.handler; },
  on: (name, fn) => { handlers[name] = fn; },
};
const { default: extension } = await import('../.test-dist/extensions/index.js');
extension(pi);

const ctx = { cwd: repo, ui: { notify: (m) => { notified = String(m); } } };
const grepOutput = 'src/lane.ts:88:export function writeLane(x) {\nsrc/store.ts:12:  const y = 1';
const result = (over = {}) => ({
  toolName: 'bash',
  input: { command: 'grep -rn writeLane src' },
  content: [{ type: 'text', text: grepOutput }],
  isError: false,
  ...over,
});
const run = (over) => handlers.tool_result(result(over), ctx);
const textOf = (r) => (r?.content ?? []).map((c) => c.text ?? '').join('');
const reset = () => { calls = []; answer = structural; delayMs = 0; stubNotes = []; };

// ── the search comes back carrying what the index knows ─────────────────────
reset();
let out = await run();
assert.ok(textOf(out).includes('what the index knows about "writeLane"'), 'the answer is appended');
assert.ok(textOf(out).includes('3 callers'), 'and it carries the structure');
assert.ok(textOf(out).startsWith(grepOutput), 'the search output itself is never replaced');

// ── the index's own warning travels with the answer ────────────────────────
// Read only to decide on silence before, so a stale answer looked like a fresh one.
reset();
stubNotes = ['structure is being rebuilt right now — callers may be missing; ask again in a moment'];
out = await run({ input: { command: 'grep -rn staleSubject src' } });
assert.match(textOf(out), /! structure is being rebuilt right now/, 'a rebuild in flight is stated on the answer itself');
reset();
stubNotes = ['structure is 1 commit behind HEAD (indexed abc)'];
out = await run({ input: { command: 'grep -rn freshSubject src' } });
assert.ok(textOf(out).includes('freshSubject') && !/behind HEAD/.test(textOf(out)), 'but routine one-commit lag adds no noise');

// ── a subject is answered once, until the answer has left the reader ───────
// repeatAfterMinutes is 0 here, so the memory expires immediately and the same
// search is answered again. Sessions run for days; never repeating is wrong.
reset();
out = await run();
assert.ok(textOf(out).includes('writeLane'), 'after the repeat window, it answers again');

// ── a bare risk label is a verdict, not knowledge the search lacked ─────────
reset();
answer = { ...structural, signals: ['semantic 0.30', 'risk LOW'], breaks: [] };
assert.equal(await run({ input: { command: 'grep -rn riskOnly src' } }), undefined,
  'risk alone is not structure worth spending context on');

// ── an answer with no structure is not worth the context ───────────────────
reset();
answer = textualOnly;
out = await run({ input: { command: 'grep -rn consumeInbox src' } });
assert.equal(out, undefined, 'a purely textual answer stays silent');
answer = structural;
out = await run({ input: { command: 'grep -rn consumeInbox src' } });
assert.equal(out, undefined, 'and the dead end is not retried, even once it would answer');

// ── the toggle, and its persistence ────────────────────────────────────────
reset();
await handlers.command('augment off', ctx);
assert.ok(/OFF/.test(notified) && /remembered/.test(notified), 'the decision is saved, and says where');
assert.equal(await run({ input: { command: 'grep -rn parseHeader src' } }), undefined, 'off means silent');
assert.deepEqual(calls, [], 'and costs nothing');
await handlers.command('augment on', ctx);
assert.ok((await run({ input: { command: 'grep -rn parseHeader src' } })) !== undefined, 'on resumes');

// ── the lens never answers itself ──────────────────────────────────────────
reset();
assert.equal(await run({ input: { command: 'lens ask "where is writeLane"' } }), undefined);
assert.equal(await run({ toolName: 'edit', input: { path: 'a.ts' } }), undefined, 'and does not touch edits');
// REVERSED, deliberately: a search that found nothing is the loudest question a
// search can ask, and skipping those cost 2,933 openings in 24 hours on one repo.
// The block says so in its own words, so the agent stops rewording the pattern.
{
  const empty = await run({ isError: true, content: [{ type: 'text', text: '' }],
                            input: { command: 'grep -rn writeLane src' } });
  assert.match(textOf(empty), /that search found nothing; the index has "writeLane"/,
    'an empty search is answered, and told it was empty');

  // A broken shell is still silence: that is a fact about the command.
  reset();
  assert.equal(await run({ isError: true, content: [{ type: 'text', text: 'bash: rg: command not found' }],
                          input: { command: 'rg -n parseHeader src' } }), undefined,
    'a command that never ran asks the index nothing');
}
assert.deepEqual(calls, [], 'none of those reached an engine');

// ── an unindexed directory is not interrogated ─────────────────────────────
reset();
const bare = mkdtempSync(join(tmpdir(), 'lens-bare-'));
assert.equal(await handlers.tool_result(result(), { ...ctx, cwd: bare }), undefined);
assert.deepEqual(calls, [], 'nothing to answer with means nothing is asked');
rmSync(bare, { recursive: true, force: true });

// ── a hanging engine must never hold up someone else's search ──────────────
reset();
await handlers.command('augment on', ctx);
delayMs = 3_000;
const started = Date.now();
out = await handlers.tool_result(
  result({ input: { command: 'grep -rn slowSubject src' } }),
  { ...ctx },
);
const waited = Date.now() - started;
assert.ok(waited < 2_500, `a search waited ${waited}ms on a hung engine`);
assert.equal(out, undefined, 'and got its result unchanged');

rmSync(repo, { recursive: true, force: true });
console.log('ok — the hook appends, remembers, obeys its toggle, and never holds up a search');


// ── the prompt is answered BEFORE the agent acts ────────────────────────────
// The measured failure of the old design: it only spoke after a search, which
// requires the agent to take the slow path first. Over 26 days the agents chose
// a lens tool 66 times in 77,029 calls, so "after a search" is a channel that
// mostly never opens. This drives the real before_agent_start handler.
{
  // The suite tore its fixture down above; this block needs an indexed repo again.
  mkdirSync(join(repo, '.gitnexus'), { recursive: true });
  writeFileSync(join(repo, '.gitnexus', 'meta.json'),
    JSON.stringify({ lastCommit: 'a'.repeat(40), indexedAt: new Date().toISOString() }));
  const start = (prompt) => handlers.before_agent_start({ prompt, systemPrompt: 'You are a coding assistant.' }, ctx);
  const packOf = (r) => String(r?.message?.content ?? '');

  // The hook asks only about what the prompt names as CODE: the whole prompt as
  // a question routes prose to a 430-550 ms path, and the wall is 400 ms.
  reset();
  let r = await start('where does the lane grant get refused?');
  assert.ok(!packOf(r).includes('already knows'), 'a prompt that names no code gets no pack');
  // (The session's first turn still carries the repo map, whose graph calls go
  // through the same stubbed network with no question — hence the filter.)
  assert.deepEqual(calls.filter(Boolean), [], 'and asks the engines no question');

  reset();
  r = await start('where does writeLane refuse a grant?');
  assert.deepEqual(calls.filter(Boolean), ['writeLane'], 'the engine is asked about the named symbol, not the sentence');
  assert.ok(packOf(r).includes('what the index already knows'), 'the prompt itself is answered up front');
  assert.ok(packOf(r).includes('writeLane'), 'and the pack names the spot');
  assert.ok(/do not grep for what is listed/.test(packOf(r)), 'with the one instruction that replaces the search');

  // Novelty: the same spot is not spent twice on the same session.
  reset();
  r = await start('and where does writeLane refuse, again?');
  assert.equal(r?.message, undefined, 'a spot already shown is not re-injected');

  // Conversational turns cost nothing at all.
  reset();
  r = await start('yes go on');
  assert.equal(r?.message, undefined, 'a short prompt is never probed');
  assert.deepEqual(calls, [], 'and never reaches the engines');

  // Nothing strong: say the useful thing, but only twice per session.
  reset();
  answer = null;
  const a = await start('please refactor billingSubsystem now');
  const b = await start('now do the same for reportingSubsystem too');
  const c = await start('and then notificationSubsystem as well');
  // The nudge must carry the CALL, not just the news: a bare "no match" is an
  // apology, and Graft rewrote the same line after tracing a session where it
  // left the agent to grep 38 times.
  assert.ok(/nothing strong matched/.test(packOf(a)), 'a weak match says so, once');
  assert.match(packOf(a), /lens_ask \{ question: "please refactor billingSubsystem/, 'and names the exact call to make');
  assert.ok(/nothing strong matched/.test(packOf(b)), 'and twice');
  assert.equal(c?.message, undefined, 'but never becomes wallpaper');

  // The directive still rides along, with its call discipline.
  assert.ok(/Pick the ONE lens tool/.test(String(a?.systemPrompt ?? '')),
    'the always-on directive carries call discipline');
}

console.log('ok — the prompt is answered before the agent acts, once per spot, twice at most when weak');

rmSync(repo, { recursive: true, force: true });


// ── changing a symbol brings its dependents with it ─────────────────────────
// The weakest surface measured: only 10% of edits to an indexed symbol had its
// blast radius pulled first, because nothing ever offered one. pi's tool_call
// hook can only BLOCK a tool, and blocking an edit to teach someone about
// callers is a worse trade than speaking straight after the write.
{
  mkdirSync(join(repo, '.gitnexus'), { recursive: true });
  writeFileSync(join(repo, '.gitnexus', 'meta.json'),
    JSON.stringify({ lastCommit: 'a'.repeat(40), indexedAt: new Date().toISOString() }));
  reset();
  const edit = (path, over = {}) => handlers.tool_result({
    toolName: 'edit', input: { path }, content: [{ type: 'text', text: 'ok' }], isError: false, ...over,
  }, ctx);

  // The file is named for the symbol it holds, and the index places it there.
  answer = { ...structural, file: 'packages/core/src/writeLane.ts' };
  const out = await edit('/repo/packages/core/src/writeLane.ts');
  assert.match(textOf(out), /you just changed "writeLane"; this depends on it/,
    'an edited symbol is met with who depends on it');
  assert.match(textOf(out), /3 callers/, 'and the dependents are real structure');

  // Repetition is governed by the same repeat window as every other answer, and
  // this fixture sets it to 0 so the memory expires instantly — so here the
  // second save speaks again, and that is the configured behaviour, not a leak.
  // At the shipped default (30 min) an edit loop stays quiet after the first.
  assert.notEqual(await edit('/repo/packages/core/src/writeLane.ts'), undefined,
    'with no repeat window, a later save is answered again');

  // #12: the edited FILE is the subject. A same-named symbol in another file is
  // different code — live, editing src/core/augment.ts was answered with a
  // variable called \`augment\` in extensions/index.ts, callers and all.
  reset();
  answer = { ...structural, symbol: 'augment', file: 'extensions/index.ts', line: 310 };
  const wrong = await edit('/repo/src/core/augment.ts');
  assert.ok(!/extensions\/index\.ts:310|index\.ts/.test(textOf(wrong)),
    `a same-named symbol elsewhere never answers for the edited file (got: ${textOf(wrong).slice(0, 160)})`);

  assert.equal(await edit('/repo/docs/notes.md'), undefined, 'a non-code file has no blast radius');
  assert.equal(await edit('/repo/packages/core/src/store.ts', { isError: true }), undefined,
    'a failed edit changed nothing, so it breaks nothing');
}

console.log('ok — an edited symbol arrives with its dependents, once');


// ── the prompt hook may never spend a PERSON's time ─────────────────────────
// This hook runs between the human pressing enter and the turn starting, so its
// budget is somebody's attention, not an agent's turn. Measured by the operator
// before this bound existed: 4,764 ms per submit and 51,898 ms on the first,
// against 128 ms for the same session without this extension — and during a
// 7,129 ms stall the process used 240 ms of CPU and slept through 103 of 107
// samples. It was waiting on a reindexing engine, in front of a watching human.
{
  mkdirSync(join(repo, '.gitnexus'), { recursive: true });
  mkdirSync(join(repo, '.code-lens'), { recursive: true });
  writeFileSync(join(repo, '.gitnexus', 'meta.json'),
    JSON.stringify({ lastCommit: 'a'.repeat(40), indexedAt: new Date().toISOString() }));
  writeFileSync(join(repo, '.code-lens', 'settings.json'),
    JSON.stringify({ timeoutMs: 30_000, hookBudgetMs: 300, repeatAfterMinutes: 0 }));
  const { default: ext } = await import(`../.test-dist/extensions/index.js?budget=${Date.now()}`);
  const h = {};
  ext({ registerTool: () => {}, registerCommand: () => {},
        getActiveTools: () => ['lens_ask'], on: (n, fn) => { h[n] = fn; } });

  reset();
  delayMs = 10_000;                       // an engine that will not answer today
  const t0 = Date.now();
  const r = await h.before_agent_start({ prompt: 'where does a lane grant get refused?',
                                         systemPrompt: 'You are a coding assistant.' }, ctx);
  const waited = Date.now() - t0;
  assert.ok(waited < 2_000, `the turn must start without us, not after the engine (waited ${waited}ms)`);
  assert.equal(r?.message, undefined, 'and no pack is invented from an answer that never came');
}

console.log('ok — a slow index delays the turn by a deadline, never by an engine');


// ── starting or reloading a session does not rebuild a repo a commit behind ─
// session_start fires on every start AND every /reload, and it used to launch a
// FULL refresh whenever the index was even one commit behind — which a busy
// repository always is. Watched in the act: one session start, one 60-second
// rebuild of the repository every other agent was querying. It now goes through
// the same gate as a stale read: several commits behind, graph only, one at a time.
{
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'lens-start-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('commit', '-q', '--allow-empty', '-m', 'indexed');
  mkdirSync(join(dir, '.gitnexus'), { recursive: true });
  writeFileSync(join(dir, '.gitnexus', 'meta.json'),
    JSON.stringify({ lastCommit: git('rev-parse', 'HEAD'), indexedAt: new Date().toISOString() }));
  const statuses = [];
  const startCtx = { cwd: dir, mode: 'tui', ui: { notify() {}, setStatus: (_k, v) => statuses.push(String(v)) } };

  git('commit', '-q', '--allow-empty', '-m', 'one more');           // one commit behind
  await handlers.session_start({ reason: 'reload' }, startCtx);
  await new Promise((r) => setTimeout(r, 2_600));
  assert.ok(!statuses.some((v) => /reindex/.test(v)), `one commit behind starts no rebuild (saw: ${statuses.join(' | ')})`);

  for (let i = 0; i < 5; i++) git('commit', '-q', '--allow-empty', '-m', `c${i}`);   // six behind
  await handlers.session_start({ reason: 'startup' }, startCtx);
  await new Promise((r) => setTimeout(r, 2_600));
  assert.ok(statuses.some((v) => /reindex/.test(v)), 'several commits behind still heals');
  rmSync(dir, { recursive: true, force: true });
}
console.log('ok — a session start or reload no longer rebuilds a repository one commit behind');


// ── every decision is written down when it is made ──────────────────────────
// The effectiveness report used to rebuild this from transcripts afterwards,
// and broke each time the delivery format moved. The log is the record now.
{
  const { readDeliveries } = await import('../dist/core/deliveries.js');
  // The suite tore its fixture down earlier, taking any earlier log with it, so
  // make the decisions here: one of each kind, then read what was written.
  mkdirSync(join(repo, '.gitnexus'), { recursive: true });
  writeFileSync(join(repo, '.gitnexus', 'meta.json'),
    JSON.stringify({ lastCommit: 'a'.repeat(40), indexedAt: new Date().toISOString() }));
  const since = Date.now();
  reset(); await run({ input: { command: 'grep -rn loggedSymbol src' } });                 // answered
  reset(); answer = textualOnly; await run({ input: { command: 'grep -rn quietSymbol src' } });   // silent
  reset(); await handlers.before_agent_start({ prompt: 'where does the lane grant get refused?', systemPrompt: 'x' }, ctx);
  reset(); answer = { ...structural, symbol: 'packedSymbol', file: 'src/packed.ts', line: 7 };   // a spot not shown before
  await handlers.before_agent_start({ prompt: 'what calls packedSymbol now?', systemPrompt: 'x' }, ctx);
  reset(); answer = { ...structural, file: 'src/editedThing.ts' };
  await handlers.tool_result({ toolName: 'edit', input: { path: '/r/src/editedThing.ts' },
    content: [{ type: 'text', text: 'ok' }], isError: false }, ctx);
  const logged = readDeliveries(repo, since, repo);        // HOME is the fixture repo in this suite
  const has = (channel, outcome, reason) => logged.some((d) =>
    d.channel === channel && d.outcome === outcome && (reason === undefined || d.reason === reason));
  assert.ok(has('search', 'delivered', 'answered'), 'an answered search is logged as delivered');
  assert.ok(has('search', 'silent'), 'and a silent one with its reason');
  assert.ok(has('prompt', 'silent', 'names no code'), 'a prompt that names no code is logged, by that reason');
  assert.ok(has('prompt', 'delivered', 'pack'), 'a pack that reached the agent is logged as delivered');
  // (A spot already shown this session is held back, and logged as exactly that — which is how this test first failed.)
  assert.ok(has('edit', 'delivered', 'dependents'), 'so is a blast radius');
  const raw = JSON.stringify(logged);
  assert.ok(!/lane grant|refactor billingSubsystem now|where does/.test(raw),
    'prompt text never reaches the log — only the code names asked about');
  assert.ok(!logged.some((d) => d.channel === 'prompt' && d.reason === 'too short'),
    'and conversational turns are not opportunities, so they are not logged');
}
console.log('ok — every automatic-answer decision is logged when it is made, without prompt text');
