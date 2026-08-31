/**
 * `lens refresh` — keep both indexes current as the code changes.
 *
 * Both engines support incremental updates; nothing was triggering them. This
 * is the trigger. It is deliberately CENTRALISED rather than a git hook in each
 * repository: hooks would have to be installed into repos this tool does not
 * own, and a repo that already manages its own hooks (or sets core.hooksPath)
 * would silently not get one.
 *
 * Cadence follows the measured cost, which differs by ~30x:
 *   graph engine    ~100 s for a 218k-node repo, seconds for a delta  -> run often
 *   semantic engine ~50 min for the same repo's full pass             -> run sparingly
 *
 * The hard rule: NEVER start an index while one is already running. Two
 * concurrent passes over one index is how a refresh turns into corruption and
 * an hour of wasted GPU.
 */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { GraphEngine } from '../engines/graph.js';

const run = promisify(execFile);
const STATE = join(homedir(), '.code-lens', 'refresh-state.json');
const LOCK = join(homedir(), '.code-lens', 'refresh.lock');

export interface RepoState {
  semanticCommit?: string;
  semanticAt?: number;
  graphAt?: number;
  /** How long the last graph rebuild took. Drives cost-aware cadence. */
  graphMs?: number;
  /** Hash of the scope config. The graph engine is BLIND to scope changes. */
  scopeHash?: string;
  /** Cached layer detection — probing is a full scan, too slow for every cycle. */
  layers?: { pdg: boolean; embeddings: boolean };
  /** The index this layer answer describes. Anyone may build a layer by hand;
   *  when they do, the index is rewritten and the cached answer is a lie. */
  layersFor?: string;
}

/**
 * The graph engine has no incremental mode — upstream lists it as unbuilt — so
 * every commit change costs a full re-parse. Cadence therefore follows measured
 * COST per repo rather than one global clock: cheap repos refresh every cycle,
 * expensive ones hourly. A repo whose commit has not moved is a ~9 s no-op
 * either way, so an idle hour costs almost nothing.
 */
const EXPENSIVE_MS = 60_000;
const EXPENSIVE_INTERVAL_MS = 60 * 60_000;

/**
 * Scope config fingerprint. Editing what is indexed does NOT move the commit,
 * so the graph engine reports "up to date" and silently ignores the new files.
 * Only a full rebuild applies a scope change — so detect it here, or a scope
 * edit never takes effect and nothing says so.
 */
function scopeHash(dir: string): string {
  try {
    return createHash('sha1').update(readFileSync(join(dir, '.gitnexusignore'))).digest('hex').slice(0, 12);
  } catch { return 'none'; }
}
type State = Record<string, RepoState>;

const loadState = (): State => {
  try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; }
};
const saveState = (s: State) => {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2));
};

/**
 * Is ANY index work in flight? Checked by process, because that is the truth.
 *
 * The vector pass belongs on this list. It was missing, and the timer started a
 * rebuild on top of a 20-minute embedding pass that was writing to the same
 * index — caught in the act, mid-run. A pass this list does not name is a pass
 * this guard cannot protect.
 */
export function indexRunning(): string | null {
  // Anchored to the BINARY, not to a mention. An unanchored pattern matches any
  // process whose command line merely contains the words — a shell running
  // `grep "gitnexus analyze"`, or this project's own test suite — and the
  // refresh then skips silently, forever, for a reason nobody can see.
  const passes = [
    ['(^|/)ccc +index', 'semantic'],
    ['(^|/)gitnexus +analyze', 'graph'],
    ['(^|/)gitnexus +embeddings', 'graph vector'],
  ] as const;
  for (const [pat, name] of passes) {
    try { execFileSync('pgrep', ['-f', pat], { stdio: 'pipe', timeout: 5_000 }); return name; }
    catch { /* not running */ }
  }
  return null;
}

/**
 * Engine configuration that must be identical everywhere, or an index refuses
 * to be touched at all.
 *
 * An index carrying embeddings records HOW they were made. Reach it with a
 * different endpoint and the engine refuses the whole rebuild — not just the
 * vectors — with "the embedding provider configuration differs". So a refresh
 * launched by hand and a refresh launched by the timer must agree, which means
 * this configuration cannot live inside a service unit that only one of them
 * reads. It lives in one file; the unit and the command both read it.
 *
 * Existing variables always win: an operator overriding one deliberately, for a
 * single run, must not be silently overruled by a file.
 */
export const ENGINE_ENV = join(homedir(), '.code-lens', 'engine-env');

export function loadEngineEnv(path = ENGINE_ENV, env: NodeJS.ProcessEnv = process.env): string[] {
  const applied: string[] = [];
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return applied; }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    const [, key, raw] = m;
    if (env[key!] !== undefined) continue;                       // an explicit override wins
    env[key!] = raw!.replace(/^(['"])(.*)\1$/, '$2');            // tolerate quoted values
    applied.push(key!);
  }
  return applied;
}

/** When was this graph index last written? The layer cache is keyed to it. */
function indexedAt(dir: string): string {
  try {
    return String(JSON.parse(readFileSync(join(dir, '.gitnexus', 'meta.json'), 'utf8')).indexedAt ?? '');
  } catch { return ''; }
}

const head = (dir: string): string | null => {
  try {
    // stderr piped: a directory that is not a git repo is an ordinary case
    // here, and letting git print "fatal: not a git repository" makes a normal
    // skip look like a failure in the log.
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'],
      { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
};

/**
 * Repos either engine knows about: graph registry ∪ directories with a semantic
 * index.
 *
 * The graph engine's own registry supplies each repo's REAL path. Deriving it
 * as `~/Code/<name>` was wrong for any repo nested deeper — one lives at
 * `~/Code/<org>/<name>`, so every refresh for it ran in the wrong directory and
 * failed. The registry knows; do not guess.
 */
async function repos(): Promise<{ name: string; dir: string; graph: boolean; semantic: boolean }[]> {
  const out = new Map<string, { name: string; dir: string; graph: boolean; semantic: boolean }>();
  try {
    const { stdout } = await run('gitnexus', ['list'], { timeout: 60_000, maxBuffer: 8 << 20 });
    let name = '';
    for (const line of stdout.split('\n')) {
      const n = /^\s{2}(\S.*?)\s*$/.exec(line);
      const p = /^\s*Path:\s*(\S.*?)\s*$/.exec(line);
      if (p && name && existsSync(p[1]!)) {
        out.set(name, { name, dir: p[1]!, graph: true, semantic: false });
        name = '';
      } else if (n && !/^(Path|Indexed|Commit|Branch|Stats|Clusters|Processes):/.test(n[1]!)) {
        name = n[1]!;
      }
    }
  } catch { /* graph engine down; semantic repos below still refreshable */ }

  // A repo known to the graph may ALSO have a semantic index — check at its real
  // path. The directory scan below only walks one level under ~/Code, so a repo
  // nested deeper (~/Code/<org>/<name>) had its graph refreshed forever while its
  // semantic index silently went stale.
  for (const r of out.values()) {
    if (existsSync(join(r.dir, '.cocoindex_code'))) r.semantic = true;
  }

  const root = join(homedir(), 'Code');
  try {
    for (const entry of execFileSync('ls', [root], { encoding: 'utf8', timeout: 10_000 }).split('\n')) {
      const dir = join(root, entry.trim());
      if (!entry.trim() || !existsSync(join(dir, '.cocoindex_code'))) continue;
      const existing = [...out.values()].find((v) => v.dir === dir);
      if (existing) existing.semantic = true;
      else out.set(entry.trim(), { name: entry.trim(), dir, graph: false, semantic: true });
    }
  } catch { /* no Code dir */ }
  return [...out.values()];
}

/**
 * Which analysis layers does this index currently carry? A refresh must
 * reproduce them, or it quietly deletes work that took minutes of GPU to build.
 *
 * CACHED in state, because probing is not free: counting nodes by label on a
 * 222k-node graph is a full scan, and doing it for every repo on every cycle
 * made a *dry run* exceed five minutes. A timer that stalls for minutes each
 * cycle is a worse problem than the one this function solves, so the answer is
 * remembered and only re-probed when unknown.
 */
export async function detectLayers(
  repo: string, st: RepoState, dir: string, timeoutMs = 20_000,
): Promise<{ pdg: boolean; embeddings: boolean }> {
  // Trust the cache only while it describes the index that is actually there.
  // Someone built the control-flow layer by hand; the cache still said "no
  // layers", so the next refresh would have rebuilt without --pdg and deleted
  // 90,417 basic blocks — the exact loss this function exists to prevent,
  // caused by the optimisation that makes it affordable.
  const stamp = indexedAt(dir);
  if (st.layers && st.layersFor === stamp) return st.layers;
  const g = new GraphEngine();
  const count = async (label: string): Promise<number> => {
    try {
      const r: any = await Promise.race([
        g.passthrough('cypher', { query: `MATCH (n:${label}) RETURN count(n) AS n`, repo }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), timeoutMs)),
      ]);
      return Number(/\|\s*(\d+)\s*\|/.exec(r?.markdown ?? '')?.[1] ?? 0);
    } catch { return 0; }
  };
  const [pdg, emb] = await Promise.all([count('BasicBlock'), count('CodeEmbedding')]);
  const layers = { pdg: pdg > 0, embeddings: emb > 0 };
  st.layers = layers;
  st.layersFor = stamp;
  return layers;
}

export interface RefreshOpts {
  repo?: string;
  /** Only refresh the graph engine (cheap). Default refreshes both by policy. */
  graphOnly?: boolean;
  /** Minimum minutes between semantic passes — it is the expensive engine. */
  semanticEvery?: number;
  dryRun?: boolean;
}

export async function refresh(o: RefreshOpts = {}): Promise<number> {
  const applied = loadEngineEnv();
  if (applied.length) console.log(`engine config: ${applied.length} settings from ${ENGINE_ENV}`);
  const busy = indexRunning();
  if (busy) {
    console.log(`skipped: the ${busy} engine is already indexing — refusing to start a second pass`);
    return 0;
  }
  // A lock is only meaningful while its holder is alive. A refresh killed mid-run
  // (timeout, reboot, Ctrl-C) leaves the file behind, and a naive existence check
  // then skips EVERY future run, silently and forever — failing closed and quiet,
  // which is worse than the double-run it prevents. So the holder must prove it
  // still exists.
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, 'utf8').trim());
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* gone */ }
    if (alive) { console.log(`skipped: refresh ${pid} is still running`); return 0; }
    console.log(`clearing stale lock from dead process ${pid || '?'}`);
  }
  mkdirSync(dirname(LOCK), { recursive: true });
  writeFileSync(LOCK, String(process.pid));

  try {
    const state = loadState();
    const minGap = (o.semanticEvery ?? 0) * 60_000;  // 0 = every cycle: its delta is cheap
    const list = (await repos()).filter((r) => !o.repo || r.name === o.repo);
    if (!list.length) { console.log('no indexed repositories found'); return 0; }

    for (const r of list) {
      const commit = head(r.dir);
      const st = state[r.name] ?? {};
      console.log(`\n${r.name}`);

      // --- graph: cheap, and it decides staleness itself from the commit -----
      if (r.graph) {
        // A dry run must be instant: it reports the DECISION, not the index state.
        // Re-analysing WITHOUT the flags the index was built with silently
        // downgrades it. Observed: a refresh that omitted --pdg destroyed
        // 169,617 basic blocks — the whole control-flow substrate — and the
        // only visible sign was a smaller node count in a log line. So the
        // layers present in the index decide the flags, not a fixed default.
        const layers = await detectLayers(r.name, st, r.dir);
        const hash = scopeHash(r.dir);
        const scopeChanged = st.scopeHash !== undefined && st.scopeHash !== hash;
        const expensive = (st.graphMs ?? 0) > EXPENSIVE_MS;
        const dueByCost = !expensive || !st.graphAt ||
                          Date.now() - st.graphAt > EXPENSIVE_INTERVAL_MS;

        if (!dueByCost && !scopeChanged) {
          const mins = Math.round((EXPENSIVE_INTERVAL_MS - (Date.now() - (st.graphAt ?? 0))) / 60_000);
          console.log(`  graph: deferred ~${mins} min — last rebuild took ` +
                      `${((st.graphMs ?? 0) / 1000).toFixed(0)}s and this engine has no delta`);
        } else {
          // The two layers behave OPPOSITELY across a re-analyse, measured:
          //   embeddings SURVIVE — a bare re-analyse left 46,780 intact. Passing
          //     --embeddings again makes it re-insert them and the bulk copy
          //     fails outright ("Analysis failed: COPY fail").
          //   the PDG does NOT survive — omitting --pdg deleted 169,617 basic
          //     blocks silently.
          // So: re-request the control-flow layer, never re-request embeddings.
          const flags = ['analyze', '--index-only', ...(layers.pdg ? ['--pdg'] : [])];
          if (o.dryRun) {
            console.log(`  graph: would run ${flags.join(' ')}` +
                        (scopeChanged ? ' (after clean — SCOPE CHANGED)' : ''));
          } else {
            const t0 = Date.now();
            try {
              // A scope edit does not move the commit, so the engine would
              // report "up to date" and ignore the new files. Only a wipe
              // applies it.
              if (scopeChanged) {
                console.log('  graph: scope changed — full rebuild required');
                await run('gitnexus', ['clean', '--force'], { cwd: r.dir, timeout: 600_000 });
              }
              const { stdout } = await run('gitnexus', flags,
                { cwd: r.dir, timeout: 3_600_000, maxBuffer: 32 << 20 });
              const nodes = /([\d,]+) nodes/.exec(stdout)?.[1] ?? '?';
              st.graphMs = Date.now() - t0;
              st.graphAt = Date.now();
              st.scopeHash = hash;
              console.log(`  graph: updated in ${(st.graphMs / 1000).toFixed(1)}s (${nodes} nodes)`);
            } catch (e) {
              // Keep the WHOLE error. The first 90 characters of this one read
              // "COPY failed for File: Ru" — enough to know it broke, not enough
              // to know why, and engine failures are rare enough to afford the
              // bytes. Noise from the engine's JSON logging is dropped instead.
              const msg = String((e as Error).message)
                .split('\n').filter((l) => !l.includes('"level":30')).join(' ').slice(0, 400);
              console.log(`  graph: FAILED — ${msg}`);
            }
          }
        }
      }

      // --- semantic: expensive, so gated on both change AND elapsed time -----
      if (r.semantic && !o.graphOnly) {
        const changed = commit && commit !== st.semanticCommit;
        const due = !st.semanticAt || Date.now() - st.semanticAt > minGap;
        if (!changed) console.log('  semantic: skipped — no new commit since last pass');
        else if (!due) {
          const mins = Math.round((minGap - (Date.now() - (st.semanticAt ?? 0))) / 60_000);
          console.log(`  semantic: deferred — next pass in ~${mins} min (expensive engine)`);
        } else if (o.dryRun) console.log('  semantic: would run incremental index');
        else {
          const t0 = Date.now();
          try {
            const { stdout } = await run('ccc', ['index'],
              { cwd: r.dir, timeout: 14_400_000, maxBuffer: 32 << 20 });
            const n = /(\d+)\s+added/.exec(stdout)?.[1] ?? '?';
            console.log(`  semantic: updated in ${((Date.now() - t0) / 1000).toFixed(0)}s (${n} files added)`);
            st.semanticCommit = commit ?? undefined;
            st.semanticAt = Date.now();
          } catch (e) {
            console.log(`  semantic: FAILED — ${String((e as Error).message).slice(0, 90)}`);
          }
        }
      }
      state[r.name] = st;
    }
    if (!o.dryRun) saveState(state);
    return 0;
  } finally {
    try { execFileSync('rm', ['-f', LOCK]); } catch { /* best effort */ }
  }
}
