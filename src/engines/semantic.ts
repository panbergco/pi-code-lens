/**
 * Semantic engine adapter — cocoindex-code (`ccc`) over its JSON CLI.
 *
 * This engine owns the STRONG code model (768-dim, 8,192-token window,
 * code-specialised) and is therefore the recall stage. It is reached through
 * its daemon, which holds the model resident on the GPU; the CLI call is a thin
 * client to that daemon, not a model load.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { Candidate, Engine, Health, Query } from './types.js';

const run = promisify(execFile);
const BIN = process.env.LENS_SEMANTIC_BIN ?? 'ccc';

export class SemanticEngine implements Engine {
  readonly id = 'semantic' as const;
  constructor(private cwd: string = process.cwd()) {}

  private async ccc(args: string[], timeout = 120_000, cwd = this.cwd) {
    return run(BIN, args, { cwd, timeout, maxBuffer: 32 << 20 });
  }

  /**
   * Is this engine mid-reindex? A full reindex saturates its daemon, so queries
   * queue behind it and die at the timeout. The raw failure ("Command failed:
   * ccc search …") reads like a broken invocation and misled two agents into
   * diagnosing a spawn defect — the truth is simply "busy, try later".
   */
  static reindexing(): boolean {
    try {
      execFileSync('pgrep', ['-f', 'ccc index'], { stdio: 'pipe', timeout: 5_000 });
      return true;
    } catch { return false; }
  }

  /** Turn an engine failure into something that names the actual condition. */
  static explain(e: unknown): string {
    const m = String((e as Error)?.message ?? e);
    if (/timed out|ETIMEDOUT/i.test(m) || /Command failed: ccc search/.test(m)) {
      return SemanticEngine.reindexing()
        ? 'semantic engine is BUSY reindexing — recall falls back to the graph until it finishes'
        : 'semantic engine did not answer in time';
    }
    if (/not in an initialized project/i.test(m)) return 'this repo is not indexed by the semantic engine';
    return m.slice(0, 90);
  }

  async health(): Promise<Health> {
    try {
      const { stdout } = await this.ccc(['status'], 30_000);
      const model = /model:\s*(\S+)/.exec(stdout)?.[1];
      const device = /device:\s*(\S+)/.exec(stdout)?.[1];
      const project = /Project:\s*(\S+)/.exec(stdout)?.[1];
      return {
        id: this.id, up: true, repos: project ? [project] : [],
        model: model ?? readGlobal('model'), device: device ?? readGlobal('device'),
        detail: /Chunks:\s*(\d+)/.exec(stdout)?.[0],
      };
    } catch (e) {
      const msg = (e as Error).message;
      // "not an initialized project" means the ENGINE is fine and this repo is
      // simply not indexed — a coverage gap, not an outage. Saying otherwise
      // would send the operator hunting a healthy daemon.
      const uninitialised = /not in an initialized project/i.test(msg);
      return {
        id: this.id, up: uninitialised, repos: [],
        model: readGlobal('model'), device: readGlobal('device'),
        detail: uninitialised ? 'engine up; this repo is NOT indexed by it' : msg.slice(0, 200),
      };
    }
  }

  /** `ccc` is a fixed command set, so parity is a literal list, not a probe. */
  async capabilities(): Promise<string[]> {
    return ['init', 'index', 'search', 'grep', 'status', 'reset', 'doctor', 'mcp', 'daemon'];
  }

  async passthrough(name: string, args: Record<string, unknown>): Promise<unknown> {
    const argv = [name];
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === '_') { argv.push(...(Array.isArray(v) ? v.map(String) : [String(v)])); continue; }
      argv.push(`--${k}`);
      if (v !== true) argv.push(String(v));
    }
    const { stdout } = await this.ccc(argv);
    try { return JSON.parse(stdout); } catch { return stdout; }
  }

  /**
   * `repo` means different things to the two engines: a NAME to the graph
   * (which holds many indexes in one server) and a DIRECTORY here (the CLI is
   * cwd-scoped). Passing a name through as a cwd made every query fail with
   * ENOENT, so the two meanings are reconciled once, here.
   */
  private dirFor(repo?: string, callerCwd?: string): string {
    if (repo) {
      if (repo.includes('/') && existsSync(repo)) return repo;
      const guess = `${process.env.HOME}/Code/${repo}`;
      if (existsSync(guess)) return guess;
    }
    // The CALLER's directory, not this process's. Under the hot server those
    // differ: the server is long-lived with its own cwd, so falling back to
    // `this.cwd` ran every query in the server's directory and failed with
    // "not in an initialized project" for repos that are perfectly well indexed.
    if (callerCwd && existsSync(callerCwd)) return callerCwd;
    return this.cwd;
  }

  async seed(q: Query): Promise<Candidate[]> {
    const { stdout } = await this.ccc(
      ['search', q.text, '--json', '--limit', String(q.limit ?? 12)],
      120_000,
      this.dirFor(q.repo, q.cwd),
    );
    let doc: any;
    try { doc = JSON.parse(stdout); } catch { return []; }
    const rows: any[] = Array.isArray(doc) ? doc : doc?.results ?? doc?.matches ?? [];
    // Field names verified against real output (`ccc search --json`):
    // file_path / start_line / end_line / score / content. Guessing these was
    // why every spot rendered as "unknown" with no line number.
    return rows.map((r) => ({
      file: r.file_path ?? r.file ?? r.path ?? 'unknown',
      startLine: num(r.start_line ?? r.startLine ?? r.line),
      endLine: num(r.end_line ?? r.endLine),
      symbol: r.symbol ?? r.name ?? firstSymbol(r.content),
      relevance: num(r.score ?? r.similarity),
      preview: typeof r.content === 'string' ? r.content.slice(0, 240) : r.summary,
      source: this.id,
    }));
  }
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/**
 * The semantic engine returns chunks, not symbols, but the graph stage needs a
 * symbol to expand. Recover a plausible anchor from the chunk's own text so
 * recall hits can still be given consequence.
 */
function firstSymbol(content?: string): string | undefined {
  if (typeof content !== 'string') return undefined;
  const m = /\b(?:function|const|class|def|async function)\s+([A-Za-z_$][\w$]*)/.exec(content)
         ?? /\b([A-Za-z_$][\w$]{2,})\s*\(/.exec(content);
  return m?.[1];
}

/** The curated global config is the source of truth for model and device. */
function readGlobal(key: 'model' | 'device'): string | undefined {
  try {
    const p = `${process.env.HOME}/.cocoindex_code/global_settings.yml`;
    const m = new RegExp(`^\\s*${key}:\\s*(\\S+)`, 'm').exec(readFileSync(p, 'utf8'));
    return m?.[1];
  } catch { return undefined; }
}
