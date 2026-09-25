/**
 * The effectiveness report, run end to end against a transcript whose answer is
 * known. It had no test of its own, and it drifted three ways without anyone
 * seeing: it credited a lens call only when it replaced a search (reported 0,
 * transcripts held 4), it let a served pack prove its own prompt answerable
 * (read 81-100% while one pack landed in three hours), and it recognised only
 * the first wording of a nudge, so every later nudge scored as an answer.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'lens-kpi-home-'));
const repo = join(home, 'Code', 'fixture');
mkdirSync(repo, { recursive: true });
process.env.HOME = home;

// ── the graph engine, stubbed at the network edge ───────────────────────────
const KNOWN = ['claimSlice', 'writeLane'];          // symbols with callers
const IMPORTED = ['lane-mint.ts'];                  // a file something imports
globalThis.fetch = async (_url, init) => {
  const msg = JSON.parse(init?.body ?? '{}');
  const ok = (result) => ({ ok: true, status: 200, headers: { get: (h) => (h === 'mcp-session-id' ? 's' : null) },
    text: async () => JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) });
  if (msg.method === 'initialize' || msg.method === 'notifications/initialized') return ok({});
  if (msg.method === 'tools/list') return ok({ tools: [{ name: 'cypher' }, { name: 'list_repos' }] });
  const q = String(msg.params?.arguments?.query ?? '');
  const table = (rows) => ({ content: [{ type: 'text', text: JSON.stringify({ markdown: '| name |\n| --- |\n' + rows.map((r) => `| ${r} |`).join('\n') }) }] });
  if (msg.params?.name === 'list_repos') return ok({ content: [{ type: 'text', text: JSON.stringify(['fixture']) }] });
  if (/IMPORTS/.test(q)) return ok(table(IMPORTED));
  if (/CALLS/.test(q)) return ok(table(KNOWN));
  return ok(table([]));
};

// ── one session, every kind of moment, with a known right answer ────────────
const now = Date.now();
let n = 0;
const at = () => new Date(now - 60_000 + (n++) * 1_000).toISOString();
const rows = [];
const user = (text) => rows.push({ type: 'message', timestamp: at(), message: { role: 'user', content: text } });
const hook = (content) => rows.push({ type: 'custom_message', timestamp: at(), customType: 'code-lens-context', content });
const call = (name, args) => rows.push({ type: 'message', timestamp: at(), message: { role: 'assistant',
  content: [{ type: 'toolCall', id: `c${n}`, name, arguments: args }] } });

user('what calls claimSlice?');                                  // names known code …
hook('[code-lens — what the index already knows about this task]\n1. claimSlice');   // … and is answered
user('why is writeLane refusing grants?');                       // names known code …
hook('[code-lens] nothing strong matched this prompt automatically — …');           // … and only nudged
user('where are we on the proof perfection?');                   // names no code …
hook('[code-lens — what the index already knows about this task]\n1. something');   // … a pack it never asked for
user('look at `lane-mint` please');                              // a file something imports: answerable
hook('[code-lens — where the weight sits in fixture]\n  query — 9 callers');        // … but only the map arrived
call('lens_ask', { question: 'how does the lane grant work' });  // chosen instead of searching
call('lens_breaks', { symbol: 'claimSlice' });                   // chosen again
call('bash', { command: 'grep -rn "writeLane" src' });           // a code search it ran itself

const dir = join(home, '.pi', 'agent', 'sessions', `-${repo.replace(/\//g, '-')}--`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'session.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));

// ── and a delivery log, as the extension writes it when it decides ──────────
mkdirSync(join(home, '.code-lens', 'deliveries'), { recursive: true });
const d = (o) => JSON.stringify({ t: now - 30_000, ...o });
writeFileSync(join(home, '.code-lens', 'deliveries', 'fixture.jsonl'), [
  d({ channel: 'prompt', outcome: 'delivered', reason: 'pack', ms: 210 }),
  d({ channel: 'prompt', outcome: 'silent', reason: 'names no code', ms: 3 }),
  d({ channel: 'prompt', outcome: 'silent', reason: 'names no code', ms: 4 }),
  d({ channel: 'prompt', outcome: 'silent', reason: 'missed the deadline', ms: 401 }),
  d({ channel: 'search', outcome: 'delivered', reason: 'answered', ms: 90 }),
  d({ channel: 'search', outcome: 'silent', reason: 'answered minutes ago' }),
].join('\n') + '\n');

const { kpi } = await import('../dist/commands/kpi.js');
const out = [];
const log = console.log;
console.log = (...a) => out.push(a.join(' '));
try { await kpi({ cwd: repo, sinceHours: 1 }); } finally { console.log = log; }
const text = out.join('\n');
const row = (name) => text.split('\n').find((l) => l.trim().startsWith(name))?.trim().split(/\s+/);

// prompt: 3 name known code (claimSlice, writeLane, lane-mint); 1 answered.
assert.deepEqual(row('prompt').slice(1, 4), ['4', '3', '1'],
  `answerable prompts are the ones naming known code, and only a real pack counts:\n${text}`);
assert.match(text, /packs on prompts that named no known code: 1/, 'a pack nobody asked for is reported, not credited');
assert.match(text, /lens tools: 2 · grep\/rg\/read for code: 1/, 'every lens call the agent chose is counted');
assert.match(text, /prompt: nudged, not answered|prompt: named known code, got nothing/, 'misses are attributed');
assert.match(text, /recorded live \(delivery log, 6 decisions\)/, 'the live record is reported beside the reconstruction');
const promptLine = text.split('\n').find((l) => /^\s+prompt\s+1\s+3/.test(l));
assert.ok(promptLine, `prompt: 1 delivered, 3 silent, as written:\n${text}`);
assert.match(promptLine, /names no code ×2/, 'with the reasons for silence, most common first');

rmSync(home, { recursive: true, force: true });
console.log('ok — the effectiveness report scores the moments it claims to');
process.exit(0);
