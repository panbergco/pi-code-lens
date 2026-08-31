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
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init?.body ?? '{}');
  calls.push(body.question);
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  const spots = answer ? [answer] : [];
  return { ok: true, json: async () => ({ spots, ms: 12, notes: [], plan: { intent: 'breaks' } }) };
};

const structural = { file: 'src/lane.ts', line: 88, symbol: 'writeLane', score: 1, signals: ['semantic 1.00', '3 callers'], breaks: ['flow: deliver'], source: 'graph' };
const textualOnly = { file: 'src/lane.ts', line: 12, symbol: 'writeLane', score: 1, signals: ['semantic 0.90'], breaks: [], source: 'semantic' };

// ── a fake pi that records what the extension registers ─────────────────────
const handlers = {};
let notified = '';
const pi = {
  registerTool: () => {},
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
const reset = () => { calls = []; answer = structural; delayMs = 0; };

// ── the search comes back carrying what the index knows ─────────────────────
reset();
let out = await run();
assert.ok(textOf(out).includes('what the index knows about "writeLane"'), 'the answer is appended');
assert.ok(textOf(out).includes('3 callers'), 'and it carries the structure');
assert.ok(textOf(out).startsWith(grepOutput), 'the search output itself is never replaced');

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
assert.equal(await run({ isError: true, input: { command: 'grep -rn missingSymbol src' } }), undefined,
  'a failed search is not a question');
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
