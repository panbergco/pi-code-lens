// The failure this guards: gitnexus restarts, its session id dies, and a
// long-lived `lens serve` kept using the dead id forever — every structural
// answer degraded to "indexed: none" until someone restarted the service.
//
// Run: node test/graph-session-retry.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { GraphEngine } from '../dist/engines/graph.js';

let sessions = 0, rejectedOnce = false;

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
    if (!rejectedOnce) {
      rejectedOnce = true;
      return res.end(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        error: { message: 'Session not found. Re-initialize.' },
      }));
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'impact' }] } }));
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const engine = new GraphEngine(`http://127.0.0.1:${server.address().port}/mcp`);

const tools = await engine.capabilities();
assert.deepEqual(tools, ['impact'], 'a dead session must re-initialize and answer, not throw');
assert.equal(sessions, 2, 'the dead session id must be replaced, not reused');

server.close();
console.log('ok — graph engine recovers from an expired session');
