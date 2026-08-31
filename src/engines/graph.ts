/**
 * Graph engine adapter — GitNexus over MCP/HTTP.
 *
 * Talks to the always-on server rather than spawning the CLI: measured on this
 * machine, a cold process answers in ~2,550 ms and the warm server in ~190 ms.
 * Spawning per call would throw away the entire reason the service exists.
 */
import type { Candidate, Engine, Health, Neighbourhood, Query } from './types.js';

const DEFAULT_URL = process.env.LENS_GRAPH_URL ?? 'http://127.0.0.1:3737/mcp';

interface RpcResult { result?: any; error?: { message?: string } }

export class GraphEngine implements Engine {
  readonly id = 'graph' as const;
  private session: string | null = null;
  constructor(private url: string = DEFAULT_URL) {}

  /** MCP Streamable HTTP returns either JSON or an SSE frame; accept both. */
  private static parse(body: string): RpcResult {
    for (const raw of body.split('\n')) {
      const line = raw.startsWith('data: ') ? raw.slice(6).trim() : raw.trim();
      if (!line.startsWith('{')) continue;
      try { return JSON.parse(line) as RpcResult; } catch { /* next frame */ }
    }
    return {};
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.session) h['Mcp-Session-Id'] = this.session;
    return h;
  }

  private async connect(): Promise<void> {
    if (this.session) return;
    const res = await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2024-11-05', capabilities: {},
          clientInfo: { name: 'code-lens', version: '0.1.0' },
        },
      }),
    });
    this.session = res.headers.get('mcp-session-id');
    await fetch(this.url, {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }).catch(() => undefined);
  }

  private async rpc(method: string, params: unknown, timeoutMs = 120_000,
                    retry = true): Promise<any> {
    await this.connect();
    const ctl = AbortSignal.timeout(timeoutMs);
    const res = await fetch(this.url, {
      method: 'POST', headers: this.headers(), signal: ctl,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }),
    });
    const doc = GraphEngine.parse(await res.text());
    // gitnexus restarts, and its sessions expire. A long-lived `lens serve` then
    // holds a dead id and EVERY structural answer degrades silently — health
    // reports "indexed: none", sending the user to re-index an index that was
    // never missing. Re-initialize once instead.
    const dead = res.status === 404
      || /session not found|re-?initialize/i.test(doc.error?.message ?? '');
    if (dead && retry) {
      this.session = null;
      this.cachedHealth = null;
      return this.rpc(method, params, timeoutMs, false);
    }
    if (doc.error) throw new Error(doc.error.message ?? 'graph engine error');
    return doc.result;
  }

  /**
   * Tool results arrive as MCP content blocks whose text is JSON followed by a
   * human-facing markdown hint ("**Next:** use context(...)"). Strict parsing
   * therefore fails on every call, silently degrading every structural answer
   * to a string — so extract the leading balanced value instead of trusting
   * the whole block to be JSON.
   */
  private static unwrap(result: any): any {
    const block = result?.content?.[0];
    if (!block) return result;
    if (block.type !== 'text') return block;
    const text: string = block.text ?? '';
    try { return JSON.parse(text); } catch { /* mixed content — fall through */ }
    const parsed = extractLeadingJson(text);
    return parsed === undefined ? text : parsed;
  }

  /**
   * Health with a short TTL, for the hot path.
   *
   * Resolving the repo from the working directory needs the registry, and doing
   * that on every question cost ~400 ms — a 5x regression on the symbol lane,
   * which had been sub-100 ms. The registry changes only when a repo is indexed,
   * so a brief cache is free; the TTL keeps a newly-indexed repo visible within
   * a minute. Diagnostics call `health()` directly and always see live state.
   */
  private cachedHealth: { at: number; value: Health } | null = null;

  /**
   * Resolve the `repo` argument the graph engine wants from a working directory.
   *
   * The engine holds many indexes, so with more than one registered every
   * unqualified call fails with "Multiple repositories indexed". The directory
   * already names the project; fill it in only when the engine really has an
   * index by that name, because an invented name is worse than none — the
   * engine's own error at least lists the real ones.
   */
  async repoArg(cwd: string, explicit?: string): Promise<Record<string, string>> {
    if (explicit) return { repo: explicit };
    const guess = cwd.split('/').filter(Boolean).pop() ?? '';
    if (!guess) return {};
    try {
      const gh = await this.healthCached();
      if (gh.repos.some((r) => r === guess || r.endsWith(`/${guess}`))) return { repo: guess };
    } catch { /* engine down — let the call fail with its own message */ }
    return {};
  }

  async healthCached(maxAgeMs = 60_000): Promise<Health> {
    if (this.cachedHealth && Date.now() - this.cachedHealth.at < maxAgeMs) {
      return this.cachedHealth.value;
    }
    const value = await this.health();
    // Only cache a GOOD answer: caching "engine down" would keep reporting an
    // outage for a minute after it recovered.
    if (value.up) this.cachedHealth = { at: Date.now(), value };
    return value;
  }

  async health(): Promise<Health> {
    try {
      const tools = await this.capabilities();
      let repos: string[] = [];
      try {
        const r = GraphEngine.unwrap(await this.rpc('tools/call',
          { name: 'list_repos', arguments: {} }, 20_000));
        const list = Array.isArray(r) ? r : (r?.repos ?? r?.repositories ?? []);
        repos = list.map((x: any) => (typeof x === 'string' ? x : x?.name ?? x?.label)).filter(Boolean);
      } catch { /* tool list already proves liveness */ }
      return { id: this.id, up: true, repos, detail: `${tools.length} tools` };
    } catch (e) {
      return {
        id: this.id, up: false, repos: [],
        detail: `unreachable at ${this.url}: ${(e as Error).message}`,
      };
    }
  }

  async capabilities(): Promise<string[]> {
    const r = await this.rpc('tools/list', {}, 20_000);
    return (r?.tools ?? []).map((t: any) => t.name);
  }

  async passthrough(name: string, args: Record<string, unknown>): Promise<unknown> {
    return GraphEngine.unwrap(await this.rpc('tools/call', { name, arguments: args }));
  }

  /**
   * The graph can also seed. Its search is HYBRID — BM25 keyword retrieval fused
   * with vector similarity — so it works with or without embeddings; without
   * them it is BM25-only, which is strong on identifiers and exact terms and
   * weak on paraphrase. That is a different shape of recall, not merely a worse
   * one, and it is why a repo with zero embeddings still answers.
   *
   * Results arrive in THREE arrays and the earlier version read only
   * `processes`. On an embedding-free index that array is empty while the real
   * hits sit in `definitions`, so the fallback silently returned nothing and
   * looked like "the graph found no match" — the opposite of the truth.
   */
  async seed(q: Query): Promise<Candidate[]> {
    const r: any = await this.passthrough('query', {
      search_query: q.text, ...(q.repo ? { repo: q.repo } : {}),
    });
    const out: Candidate[] = [];

    // Symbol-level hits: usable by the location join, so they carry real weight.
    for (const d of [...(r?.definitions ?? []), ...(r?.process_symbols ?? [])]) {
      if (!d?.filePath && !d?.file) continue;
      out.push({
        file: d.filePath ?? d.file,
        startLine: typeof d.startLine === 'number' ? d.startLine : undefined,
        endLine: typeof d.endLine === 'number' ? d.endLine : undefined,
        symbol: d.name,
        relevance: typeof d.score === 'number' ? d.score : 0.5,
        preview: d.module ?? d.id,
        source: this.id,
      });
    }
    // Flow-level hits: coarser, and only worth showing when nothing sharper exists.
    if (!out.length) {
      for (const p of r?.processes ?? []) {
        out.push({
          file: p.file ?? p.id ?? 'unknown', symbol: p.summary ?? p.id,
          relevance: typeof p.priority === 'number' ? p.priority : undefined,
          preview: p.summary, source: this.id,
        });
      }
    }
    return dedupe(out);
  }

  /**
   * Join semantic hits to graph symbols BY LOCATION, in one query.
   *
   * This is the correct join and the earlier one was wrong. A semantic engine
   * returns chunks, so guessing a symbol name from chunk text yields local
   * variables ("decision", "step", "results") that the graph has never heard
   * of — twelve lookups, twelve misses, nine seconds. A chunk knows its file
   * and line, and the graph knows which function spans that line, so ask it
   * that instead: file:163 resolves to runWorkflow(58-233) with its callers.
   */
  async expandByLocation(cands: Candidate[], repo?: string): Promise<Map<string, Neighbourhood>> {
    const out = new Map<string, Neighbourhood>();
    const located = cands.filter((c) => c.file && c.startLine);
    if (!located.length) return out;

    const clauses = located.map((c) =>
      `(f.filePath='${esc(c.file)}' AND f.startLine <= ${c.startLine} AND f.endLine >= ${c.startLine})`);
    const query =
      `MATCH (f:Function) WHERE ${clauses.join(' OR ')} ` +
      `OPTIONAL MATCH (c)-[r:CodeRelation]->(f) WHERE r.type='CALLS' ` +
      `RETURN f.filePath AS file, f.startLine AS s, f.endLine AS e, f.name AS name, count(c) AS callers`;

    let rows: any[] = [];
    try {
      const res: any = await this.passthrough('cypher',
        { query, ...(repo ? { repo } : {}) });
      rows = parseMarkdownTable(res?.markdown ?? '');
    } catch { return out; }

    // Map each candidate to the function whose line range contains it.
    for (const c of located) {
      const hit = rows.find((r) =>
        r.file === c.file && Number(r.s) <= c.startLine! && Number(r.e) >= c.startLine!);
      if (!hit) continue;
      const callers = Number(hit.callers) || 0;
      out.set(locKey(c), {
        callers: callers ? [`${callers} caller${callers === 1 ? '' : 's'}`] : [],
        callees: [], flows: [],
        risk: callers >= 10 ? 'HIGH' : callers >= 3 ? 'MEDIUM' : 'LOW',
      });
      c.symbol = hit.name ?? c.symbol;
    }
    return out;
  }

  /**
   * Name-based expansion, for anchors the caller already knows are symbols.
   * Each lookup is time-boxed — the whole point of this tool is a fast answer,
   * so one slow symbol must not hold the entire response hostage.
   */
  async expand(cands: Candidate[], repo?: string): Promise<Map<string, Neighbourhood>> {
    const out = new Map<string, Neighbourhood>();
    await Promise.all(cands.map(async (c) => {
      const key = c.symbol ?? c.file;
      if (!key || out.has(key)) return;
      try {
        const hood = await this.contextFor({ name: key }, repo);
        if (hood) out.set(key, hood);
      } catch { /* a symbol the graph does not know is not an error */ }
    }));
    return out;
  }

  /**
   * One symbol's neighbourhood — following a disambiguation when the name is
   * not unique.
   *
   * A name that matches many nodes does not come back with callers; it comes
   * back with a LIST of candidates. This used to be read as "no structure", so
   * the most valuable names in a codebase answered with silence: measured in one
   * repository, `sprint` (19 candidates, searched 47 times), `tick` (20
   * candidates, 18 times), `store`, `witness`, `lanes` — all common, all
   * refused, while unique names like `enqueueInbox` answered with 17 callers.
   */
  private async contextFor(
    arg: { name: string } | { uid: string }, repo?: string, depth = 0,
  ): Promise<Neighbourhood | undefined> {
    const ctx: any = GraphEngine.unwrap(await this.rpc('tools/call',
      { name: 'context', arguments: { ...arg, ...(repo ? { repo } : {}) } }, 8_000));

    const candidates: any[] = Array.isArray(ctx?.candidates) ? ctx.candidates : [];
    if (candidates.length && depth === 0) {
      const best = GraphEngine.pickCandidate(candidates);
      if (best?.uid) {
        const hood = await this.contextFor({ uid: best.uid }, repo, 1);
        if (hood && (hood.callers.length || hood.flows.length)) return hood;
      }
      // The disambiguation list is capped and ranked by the engine's own score,
      // so for a common name it can be filled entirely with things that cannot
      // have callers: `tick` returned 20 constants from generated proof
      // directories while the real definitions never appeared. Ask the graph
      // which node of that name is actually CALLED, rather than accepting a
      // truncated list as the whole truth.
      const called = await this.mostCalled(String((arg as { name?: string }).name ?? ''), repo);
      if (called) return await this.contextFor({ uid: called }, repo, 1);
    }

    const hood: Neighbourhood = {
      callers: names(ctx?.callers ?? ctx?.incoming),
      callees: names(ctx?.callees ?? ctx?.outgoing),
      flows: names(ctx?.processes ?? ctx?.flows),
      risk: ctx?.risk ?? ctx?.risk_level,
    };
    return hood;
  }

  /**
   * Which of several same-named nodes did the question mean?
   *
   * Prefer something that can HAVE callers (a function or method over a property
   * or a literal), and prefer the shipped code over a test that merely names the
   * same thing — answering "defined in a test file" for a production symbol is
   * worse than saying nothing. The engine's own score breaks remaining ties.
   */
  /**
   * The node of this name with the most callers, asked of the graph directly.
   * Best-effort: a schema that does not answer this shape is not an error, it
   * just means the candidate list was all we had.
   */
  private async mostCalled(name: string, repo?: string): Promise<string | undefined> {
    if (!name) return undefined;
    const safe = name.replace(/['\\]/g, '');
    if (safe !== name) return undefined;   // never build a query from a quoted name
    try {
      const r: any = GraphEngine.unwrap(await this.rpc('tools/call', {
        name: 'cypher',
        arguments: {
          query: `MATCH (c)-[r:CodeRelation]->(n) WHERE n.name = '${safe}' AND r.type = 'CALLS' ` +
                 'RETURN n.id AS uid, count(c) AS callers ORDER BY callers DESC LIMIT 1',
          ...(repo ? { repo } : {}),
        },
      }, 8_000));
      const row = /\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|\s*$/m.exec(String(r?.markdown ?? ''));
      return row && Number(row[2]) > 0 ? row[1] : undefined;
    } catch { return undefined; }
  }

  static pickCandidate(candidates: any[]): any | undefined {
    const callable = new Set(['Function', 'Method', 'Class', 'Constructor', 'Interface']);
    const rank = (c: any) => {
      const path = String(c?.filePath ?? '');
      const isTest = /(^|\/)(test|tests|__tests__|spec)\//.test(path) || /\.(test|spec)\.\w+$/.test(path);
      const isProof = /(^|\/)(proof|fixtures?|examples?)\//.test(path);
      return (callable.has(String(c?.kind)) ? 4 : 0)
           + (isTest || isProof ? 0 : 2)
           + Number(c?.score ?? 0);
    };
    return [...candidates].sort((a, b) => rank(b) - rank(a))[0];
  }
}

/** Scan the first balanced {...} or [...], honouring strings and escapes. */
function extractLeadingJson(text: string): unknown | undefined {
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  const open = text[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return undefined; }
    }
  }
  return undefined;
}

/** Stable identity for a semantic hit: where it is, not what we guessed it is. */
export const locKey = (c: Candidate): string => `${c.file}:${c.startLine ?? 0}`;

/** The three result arrays overlap; keep the first (highest-ranked) of each spot. */
function dedupe(cands: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return cands.filter((c) => {
    const k = `${c.file}:${c.symbol ?? c.startLine ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

const esc = (s: string) => s.replace(/'/g, "\\'");

/** The graph's cypher tool returns a markdown table; read it back into rows. */
function parseMarkdownTable(md: string): any[] {
  const lines = md.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
  if (lines.length < 3) return [];
  const cells = (l: string) => l.slice(1, -1).split('|').map((c) => c.trim());
  const head = cells(lines[0]!);
  return lines.slice(2).map((l) => {
    const vals = cells(l);
    return Object.fromEntries(head.map((h, i) => [h, vals[i]]));
  });
}

function names(v: any): string[] {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : Object.values(v).flat();
  return arr.map((x: any) => (typeof x === 'string' ? x : x?.name ?? x?.symbol ?? x?.id))
            .filter(Boolean).slice(0, 24);
}
