/**
 * The hot server.
 *
 * Everything expensive is paid once, at boot: the graph engine's MCP session,
 * the semantic engine's warm daemon connection, and Node's own startup. A CLI
 * invocation then costs a local HTTP round trip instead of a process launch.
 *
 * Loopback only, by default. This exposes repository contents; binding it to a
 * routable interface would publish the source of every indexed repo.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ask, createEngines, type Engines } from '../core/ask.js';

const PORT = Number(process.env.LENS_PORT ?? 3939);
const HOST = process.env.LENS_HOST ?? '127.0.0.1';

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

const json = (res: ServerResponse, code: number, doc: unknown) => {
  const out = JSON.stringify(doc);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(out) });
  res.end(out);
};

export async function serve(): Promise<number> {
  const engines: Engines = createEngines();

  // Warm both engines before announcing readiness: a server that accepts
  // traffic before its first query has landed still makes somebody pay the
  // cold load — it just hides who.
  const warm = ask({ question: 'warmup' }, engines)
    .then((r) => console.log(`[lens] warm in ${r.ms} ms`))
    .catch((e) => console.log(`[lens] warm failed (non-fatal): ${e?.message ?? e}`));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        const [g, s] = await Promise.all([engines.graph.health(), engines.semantic.health()]);
        return json(res, 200, { ok: g.up && s.up, engines: { graph: g, semantic: s } });
      }
      if (req.method === 'POST' && url.pathname === '/ask') {
        const b = await body(req);
        if (!b.question) return json(res, 400, { error: 'question required' });
        return json(res, 200, await ask(b, engines));
      }
      if (req.method === 'POST' && url.pathname.startsWith('/tool/')) {
        const [, , engine, name] = url.pathname.split('/');
        const b = await body(req);
        const target = engine === 'graph' ? engines.graph
                     : engine === 'semantic' ? engines.semantic : null;
        if (!target || !name) return json(res, 404, { error: 'unknown engine or tool' });
        return json(res, 200, { result: await target.passthrough(name, b ?? {}) });
      }
      json(res, 404, { error: 'not found', routes: ['GET /health', 'POST /ask', 'POST /tool/:engine/:name'] });
    } catch (e) {
      json(res, 500, { error: String((e as Error)?.message ?? e) });
    }
  });

  await new Promise<void>((resolve) => server.listen(PORT, HOST, resolve));
  console.log(`[lens] serving on http://${HOST}:${PORT}  (health · ask · tool)`);
  await warm;
  return new Promise<number>(() => { /* runs until stopped */ });
}
