/**
 * MCP surface — stdio JSON-RPC, no SDK dependency.
 *
 * Agents get FOUR tools, not twenty-six. The routed tools are the point: an
 * agent asked to choose between a similarity engine and a graph engine chooses
 * badly, so `lens_ask` takes the question and decides. The two passthrough
 * tools exist so nothing is unreachable — parity is not sacrificed for
 * ergonomics.
 */
import { createInterface } from 'node:readline';
import { ask, createEngines } from '../core/ask.js';
import { render } from '../core/fuse.js';

const TOOLS = [
  {
    name: 'lens_ask',
    description:
      'Find the code that matters for a task, ranked by consequence. Routes the question, ' +
      'searches semantically, expands through the call graph, and returns file:line spots with ' +
      'why each matters and what breaks. USE THIS INSTEAD OF grep for "where is X", "why does Y ' +
      'fail", "what should I change".',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, in plain words.' },
        repo: { type: 'string', description: 'Repository name. Defaults to the current one.' },
        cwd: { type: 'string', description: 'Directory the question is asked from; needed when the server runs elsewhere.' },
        budget: { type: 'number', description: 'Token ceiling for the answer (default 600).' },
      },
      required: ['question'],
    },
  },
  {
    name: 'lens_breaks',
    description:
      'Blast radius for a symbol: callers, execution flows and risk. RUN THIS BEFORE EDITING ' +
      'any function, class or method.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'lens_graph',
    description:
      'Passthrough to any knowledge-graph tool (impact, context, trace, detect_changes, cypher, ' +
      'route_map, shape_check, api_impact, pdg_query, explain, rename, check, …).',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string' },
        args: { type: 'object' },
      },
      required: ['tool'],
    },
  },
  {
    name: 'lens_semantic',
    description:
      'Passthrough to the semantic engine (search, index, status, doctor, …). Its model is the ' +
      'code-specialised one; use it for meaning-based recall over large corpora.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        args: { type: 'object' },
      },
      required: ['command'],
    },
  },
];

const text = (s: string) => ({ content: [{ type: 'text', text: s }] });

export async function mcp(): Promise<number> {
  const engines = createEngines();
  const rl = createInterface({ input: process.stdin });
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');

  for await (const line of rl) {
    const raw = line.trim();
    if (!raw) continue;
    let req: any;
    try { req = JSON.parse(raw); } catch { continue; }
    const { id, method, params } = req;

    try {
      if (method === 'initialize') {
        send({ jsonrpc: '2.0', id, result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'code-lens', version: '0.1.0' },
        }});
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      } else if (method === 'tools/call') {
        const name = params?.name;
        const a = params?.arguments ?? {};
        let result;

        if (name === 'lens_ask') {
          const r = await ask({ question: a.question, repo: a.repo, cwd: a.cwd ?? process.cwd() }, engines);
          const body = r.spots.length ? render(r.spots, a.budget ?? 600) : 'no spots found';
          const notes = r.notes.length ? `\n\n${r.notes.map((n) => `! ${n}`).join('\n')}` : '';
          result = text(`intent: ${r.plan.intent} (${r.ms} ms)\n\n${body}${notes}`);
        } else if (name === 'lens_breaks') {
          const r = await ask({ question: a.symbol, repo: a.repo, cwd: a.cwd ?? process.cwd() }, engines);
          result = text(r.spots.length ? render(r.spots, 600) : 'no blast radius found');
        } else if (name === 'lens_graph') {
          const out = await engines.graph.passthrough(a.tool, a.args ?? {});
          result = text(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
        } else if (name === 'lens_semantic') {
          const out = await engines.semantic.passthrough(a.command, a.args ?? {});
          result = text(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
        } else {
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool: ${name}` } });
          continue;
        }
        send({ jsonrpc: '2.0', id, result });
      } else if (id !== undefined) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } });
      }
    } catch (e) {
      if (id !== undefined) {
        send({ jsonrpc: '2.0', id, error: { code: -32603, message: String((e as Error)?.message ?? e) } });
      }
    }
  }
  return 0;
}
