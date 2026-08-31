/**
 * The ask pipeline, extracted so the CLI, the hot server and the MCP surface
 * all run the SAME code. Three copies of routing and fusion would drift, and
 * the one that drifts is always the one an agent is actually using.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { GraphEngine, locKey } from '../engines/graph.js';
import { SemanticEngine } from '../engines/semantic.js';
import type { Candidate, Neighbourhood } from '../engines/types.js';
import { route, type Plan } from './router.js';
import { fuse, DEFAULT_WEIGHTS, type Spot } from './fuse.js';

export interface AskInput {
  question: string;
  repo?: string;
  /** Directory the question is asked from; decides the semantic engine's scope. */
  cwd?: string;
}

export interface AskResult {
  question: string;
  plan: Plan;
  spots: Spot[];
  /** Every degradation, stated. A silent half-answer is worse than a refusal. */
  notes: string[];
  ms: number;
}

export interface Engines { graph: GraphEngine; semantic: SemanticEngine }

/** Built once by a long-lived host so connections and sessions stay warm. */
export function createEngines(cwd = process.cwd()): Engines {
  return { graph: new GraphEngine(), semantic: new SemanticEngine(cwd) };
}

export async function ask(input: AskInput, engines?: Engines): Promise<AskResult> {
  const t0 = Date.now();
  const cwd = input.cwd ?? process.cwd();
  const { graph, semantic } = engines ?? createEngines(cwd);
  const plan = route(input.question);
  const notes: string[] = [];
  let cands: Candidate[] = [];

  /**
   * Resolve the repository ONCE, and pass it to every engine call.
   *
   * The graph server holds many indexes, so with more than one registered every
   * call without a repo is ambiguous and fails. The caller should not have to
   * repeat --repo for a question asked from inside the repository itself: the
   * directory already says which project this is. Resolved against the engine's
   * own registry so a directory that is not indexed stays undefined rather than
   * inventing a name.
   */
  const gh = await graph.healthCached();
  const guess = basename(cwd);
  const repo = input.repo
    ?? (gh.repos.some((r) => r === guess || r.endsWith(`/${guess}`)) ? guess : undefined);
  if (!input.repo && !repo && gh.repos.length > 1) {
    notes.push(`ambiguous: "${guess}" is not an indexed repo and ${gh.repos.length} are ` +
               `registered (${gh.repos.join(', ')}) — pass --repo`);
  }

  if (plan.seed) {
    try {
      cands = await semantic.seed({ text: input.question, repo, limit: 12, cwd });
    } catch (e) {
      notes.push(SemanticEngine.explain(e));
    }
    if (!cands.length) {
      try {
        cands = await graph.seed({ text: input.question, repo });
        if (cands.length) notes.push('DEGRADED: recall came from the graph engine’s weaker model');
      } catch (e) {
        notes.push(`graph recall failed (${short(e)})`);
      }
    }
  } else {
    cands = [{ file: input.question, symbol: input.question, source: 'graph', relevance: 1,
               anchor: true }];
  }

  // Only symbol-level candidates can be expanded. Graph-seeded candidates are
  // execution FLOWS; asking for symbol context on a flow id is a category error
  // that cost 120 s in testing and returned nothing.
  // A user-named anchor is expandable too — excluding it made `breaks`, the one
  // verb that exists ONLY to expand, silently return "no symbol anchors" while
  // the graph held 47 callers for the same symbol.
  const expandable = cands.filter((c) => (c.source === 'semantic' || c.anchor) && c.symbol);
  let hoods = new Map<string, Neighbourhood>();

  if (plan.expand && expandable.length) {
    const target = repo ?? guess;
    const covered = gh.up && gh.repos.some((r) => r === target || r.endsWith(`/${target}`));
    if (!covered) {
      notes.push(`structure unavailable: the graph engine has no index for "${target}" ` +
                 `(indexed: ${gh.repos.join(', ') || 'none'}) — run: gitnexus analyze`);
    } else {
      try {
        // Location join first — one query, and it resolves chunks to the real
        // enclosing function. Name-based lookup is the fallback for candidates
        // that carry a symbol but no line.
        hoods = await graph.expandByLocation(expandable.slice(0, 12), repo);
        // Name-based fallback ONLY for candidates with no line to join on.
        // Running it for line-carrying candidates meant every chunk the graph
        // has no Function for (test files, generated code) burned a lookup
        // timeout — 8.5 s of the 8.6 s response, for nothing.
        const unresolved = expandable.filter((c) => !c.startLine && c.symbol);
        if (unresolved.length) {
          const byName = await graph.expand(unresolved.slice(0, 6), repo);
          for (const c of unresolved) {
            const h = byName.get(c.symbol!);
            if (h) hoods.set(locKey(c), h);
          }
        }
      } catch (e) {
        notes.push(`DEGRADED: no structural stage (${short(e)})`);
      }
    }
  } else if (plan.expand && cands.length) {
    notes.push('flow-level results: no symbol anchors to expand structurally');
  }

  const stale = staleness(cwd);
  if (stale) notes.push(stale);

  return {
    question: input.question,
    plan,
    spots: fuse(cands, hoods, DEFAULT_WEIGHTS),
    notes,
    ms: Date.now() - t0,
  };
}

/**
 * Is the STRUCTURAL half describing an older codebase than the one on disk?
 *
 * It lives here, in the shared pipeline, because staleness is a property of the
 * answer rather than of any one caller: the same lag reached the CLI silently
 * while the pi tools warned about it, which is the worst possible split — the
 * surface with no warning is the one a person reads without a model in the way.
 *
 * The graph engine indexes a COMMIT, so the check is a commit comparison, not a
 * clock. Recall is not covered by this note: it indexes files on disk, so it
 * already sees uncommitted work.
 */
export function staleness(cwd: string): string | undefined {
  try {
    const meta = join(cwd, '.gitnexus', 'meta.json');
    if (!existsSync(meta)) return undefined;
    const indexed = JSON.parse(readFileSync(meta, 'utf8')).lastCommit as string | undefined;
    if (!indexed) return undefined;
    const git = (args: string[]) => execFileSync('git', args,
      { cwd, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const head = git(['rev-parse', 'HEAD']);
    if (!head || head === indexed) return undefined;
    let behind: number | undefined;
    // An indexed commit can vanish from history entirely (rebase, squash, force
    // push). Counting then throws, and reporting "0 behind" would be a lie.
    try { behind = Number(git(['rev-list', '--count', `${indexed}..HEAD`])) || 0; } catch { /* orphaned */ }
    return behind === undefined
      ? `structure was indexed at ${indexed.slice(0, 9)}, which is no longer in this branch's history — it needs a rebuild`
      : `structure is ${behind} commit${behind === 1 ? '' : 's'} behind HEAD ` +
        `(indexed ${indexed.slice(0, 9)}) — refresh runs every 15 min`;
  } catch { return undefined; }
}

const short = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 90);
