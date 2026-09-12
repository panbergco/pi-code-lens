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
