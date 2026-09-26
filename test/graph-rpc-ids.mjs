/**
 * Overlapping questions on one graph session must each get their own answer.
 *
 * The MCP server routes a reply to the request that carries its id, keyed per
 * session. Every request used to go out as `id: 2`, so two in flight at once
 * collided: measured against the live engine, a question about reconcileCommit
 * was answered with claimSlice's neighbourhood and the claimSlice question got
 * no reply at all — 5 of 5 overlapping pairs, 0 of 5 with distinct ids. The hot
 * server shares one session across every agent, so this crossed answers between
 * agents. The stub below routes replies the same way the SDK's transport does.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { GraphEngine } from '../dist/engines/graph.js';

const waiting = new Map();        // session-scoped id → the response to write to
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const msg = JSON.parse(body || '{}');
    const reply = (result) => res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
    res.setHeader('mcp-session-id', 's1');
    res.setHeader('content-type', 'text/event-stream');
    if (msg.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'stub' } });
    if (!('id' in msg)) { res.statusCode = 202; return res.end(); }
    if (msg.method === 'tools/list') return reply({ tools: [] });
    // Like the SDK: remember which response stream this id belongs to — a
    // second request with the same id overwrites the first one's entry.
    waiting.set(msg.id, res);
    const name = msg.params?.arguments?.name ?? msg.params?.name;
    setTimeout(() => {
      const target = waiting.get(msg.id);
      if (!target) return;                       // already answered through the overwrite
      waiting.delete(msg.id);
      target.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ asked: name }) }] } })}\n\n`);
    }, name === 'first' ? 150 : 50);            // the first-asked finishes last
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/mcp`;

const e = new GraphEngine(url);
const ask = (name) => e.passthrough(name, {}).then((r) => r?.asked ?? JSON.stringify(r),
  (err) => `failed: ${String(err?.message ?? err).slice(0, 40)}`);
const [a, b] = await Promise.all([
  Promise.race([ask('first'), new Promise((r) => setTimeout(() => r('NO REPLY'), 2_000))]),
  Promise.race([ask('second'), new Promise((r) => setTimeout(() => r('NO REPLY'), 2_000))]),
]);
server.close();
assert.equal(a, 'first', 'the first question gets its own answer (with a shared id it got none)');
assert.equal(b, 'second', "and the second is never handed the first one's answer");
console.log('ok — overlapping questions on one session each get their own answer');
process.exit(0);
