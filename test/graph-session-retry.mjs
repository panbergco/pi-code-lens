// The failure this guards: gitnexus restarts, its session id dies, and a
// long-lived `lens serve` kept using the dead id forever — every structural
// answer degraded to "indexed: none" until someone restarted the service.
//
// Run: node test/graph-session-retry.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { GraphEngine } from '../dist/engines/graph.js';

let sessions = 0, rejected = 0;
/** Every phrasing this engine has used for "your session is gone". The second
 *  slipped past a pattern written for the first and made every query answer
 *  "no index" against a perfectly good index, mid-measurement. */
const DEAD_WORDINGS = [
  'Session not found. Re-initialize.',
  'First request must be initialize. No session ID provided.',
];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const msg = JSON.parse(body || '{}');
    if (msg.method === 'initialize') {
      res.setHeader('mcp-session-id', `s${++sessions}`);
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }));
    }
    if (msg.method === 'notifications/initialized') return res.end('{}');
    // First real call on the first session dies the way a restarted engine dies.
    // The wording varies, and each variant was found only after it broke
    // something: the recovery must key on the CONDITION, not on one sentence.
    // Each engine meets ONE dead session: its first. The retry opens a second
    // session, which must work — a recovery that keeps failing is a loop, not a
    // repair, so the fixture has to let the retry succeed.
    if (sessions % 2 === 1 && rejected < DEAD_WORDINGS.length) {
      return res.end(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        error: { message: DEAD_WORDINGS[rejected++] },
      }));
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'impact' }] } }));
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));

// One engine per wording: a long-lived process meets these one at a time, and
// each must recover on its own.
for (const wording of DEAD_WORDINGS) {
  const e = new GraphEngine(`http://127.0.0.1:${server.address().port}/mcp`);
  const tools = await e.capabilities();
  assert.deepEqual(tools, ['impact'], `a dead session must re-initialize and answer, not throw: ${wording}`);
}
assert.equal(sessions, DEAD_WORDINGS.length * 2, 'each dead session id is replaced, never reused');

server.close();
console.log('ok — graph engine recovers from an expired session');


// ── a command hands its session back ────────────────────────────────────────
// The engine holds a live server per session and caps at 1,000 with a 30-minute
// idle sweep. A client that never says goodbye leaks one per invocation: a few
// hundred queries in a loop exhausted the pool, and from then on every call
// answered "no index" against a healthy index — the failure looked like missing
// data and was actually bad manners.
{
  let deletes = 0;
  const srv = http.createServer((req, res) => {
    if (req.method === 'DELETE') { deletes++; res.statusCode = 200; return res.end('{}'); }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body || '{}');
      if (msg.method === 'initialize') {
        res.setHeader('mcp-session-id', 'only-one');
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }));
      }
      if (msg.method === 'notifications/initialized') return res.end('{}');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const e = new GraphEngine(`http://127.0.0.1:${srv.address().port}/mcp`);
  await e.capabilities();
  await GraphEngine.closeAll();
  assert.equal(deletes, 1, 'the session is handed back when the process is done with it');
  await GraphEngine.closeAll();
  assert.equal(deletes, 1, 'and never handed back twice');
  srv.close();
}

console.log('ok — sessions are returned, so a loop of queries cannot exhaust the engine');


// ── a repository list that failed to load is unknown, not empty ─────────────
// Cached as "up, no repositories", one failed listing during a busy moment made
// every answer for the next minute say the engine had no index — measured right
// after a restart, for a repository with 24 callers on record.
{
  let listCalls = 0;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body || '{}');
      if (msg.method === 'initialize') { res.setHeader('mcp-session-id', 'h'); return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })); }
      if (msg.method === 'notifications/initialized') return res.end('{}');
      if (msg.method === 'tools/list') return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'list_repos' }] } }));
      // The first listing fails the way a busy engine does; the second comes
      // back as prose the engine wrote instead of a list; later ones succeed.
      if (++listCalls === 1) return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: 'busy' } }));
      if (listCalls === 2) return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
        result: { isError: true, content: [{ type: 'text', text: 'registry is being rewritten, try again' }] } }));
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: JSON.stringify(['alpha', 'beta']) }] } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const e = new GraphEngine(`http://127.0.0.1:${srv.address().port}/mcp`);
  const first = await e.healthCached();
  assert.equal(first.up, true, 'the engine is up');
  assert.equal(first.partial, true, 'but its repository list is unknown, and says so');
  const prose = await e.healthCached();
  assert.equal(prose.partial, true, 'a reply that is not a list is unknown too, never an empty list');
  const third = await e.healthCached();
  assert.deepEqual(third.repos, ['alpha', 'beta'], 'so the next question asks again instead of reusing "none"');
  await GraphEngine.closeAll();
  srv.close();
}
console.log('ok — a failed repository listing is never cached as "no index"');

// ── an expiring health check is renewed behind the answer, not in front of it ─
// list_repos measured ~3 s on every call. With a plain expiring cache, the first
// question each minute paid those 3 s — inside the prompt hook, a person's wait
// and a missed 400 ms wall, for a list that had not changed.
{
  let lists = 0;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const msg = JSON.parse(body || '{}');
      if (msg.method === 'initialize') { res.setHeader('mcp-session-id', 'r'); return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })); }
      if (msg.method === 'notifications/initialized') return res.end('{}');
      if (msg.method === 'tools/list') return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'list_repos' }] } }));
      lists++;
      await new Promise((r) => setTimeout(r, 400));                  // a slow listing
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: JSON.stringify([`repo${lists}`]) }] } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const e = new GraphEngine(`http://127.0.0.1:${srv.address().port}/mcp`);
  const cold = await e.healthCached();
  assert.deepEqual(cold.repos, ['repo1'], 'a cold start has nothing to serve, so it waits');

  const t0 = Date.now();
  const stale = await e.healthCached(0);                              // aged out
  assert.ok(Date.now() - t0 < 150, `an aged answer is served at once (${Date.now() - t0}ms), not after a 400 ms listing`);
  assert.deepEqual(stale.repos, ['repo1'], 'the last good answer is what gets served');
  await e.healthCached(0);                                            // while one renewal is in flight
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(lists, 2, 'and exactly one renewal ran behind it, however often it was asked');
  assert.deepEqual((await e.healthCached()).repos, ['repo2'], 'which replaced the served answer when it landed');
  await GraphEngine.closeAll();
  srv.close();
}
console.log('ok — an aging health check is renewed behind the answer, never in front of it');
