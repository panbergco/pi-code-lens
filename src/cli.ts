/**
 * code-lens CLI — the single surface.
 *
 * Two layers, deliberately:
 *   ROUTED      ask / spots / breaks / diff / dupe   — the fused fast path
 *   PASSTHROUGH graph <tool> / semantic <cmd>        — every engine capability
 *
 * The routed layer is where code-lens leads with its own implementation. The
 * passthrough layer is why nothing an engine can do becomes unreachable by
 * adopting this tool — it forwards by name, so a capability added upstream
 * works the day it ships.
 */
import { GraphEngine } from './engines/graph.js';
import { SemanticEngine } from './engines/semantic.js';
import { render } from './core/fuse.js';
import { ask } from './core/ask.js';
import { askViaServer } from './server/client.js';
import { serve } from './server/server.js';
import { mcp } from './commands/mcp.js';
import { doctor } from './commands/doctor.js';
import { install } from './install/installer.js';
import { refresh } from './commands/refresh.js';

const USAGE = `code-lens — one surface over two code-intelligence engines

ROUTED (fused: recall proposes, structure disposes)
  lens ask "<question>"        routed + ranked + budgeted answer
  lens spots <symbol|file:line>  360° view of a known anchor
  lens breaks <symbol>         blast radius only (no recall stage)
  lens diff [--base <ref>]     changed symbols + related-but-untouched code
  lens dupe <file>             "does this already exist?"

PASSTHROUGH (100% of both engines, forwarded by name)
  lens graph <tool> [--k v ...]      any of the graph engine's tools
  lens semantic <cmd> [--k v ...]    any of the semantic engine's commands
  lens caps                          list every reachable capability

OPERATE
  lens refresh [--repo R] [--graph-only] [--semantic-every MIN] [--dry-run]
                                     incremental update of both indexes
  lens doctor [--parity] [--json]    health, GPU residency, capability parity
  lens install [--hot-load] [--npu] [--gpu-graph N] [--gpu-semantic M] [--dry-run]
                                     installs GitNexus + ccc; auto-detects CPU/CUDA/ROCm
  lens serve                         hot server (engines stay warm)
  lens mcp                           stdio MCP server — one tool for agents

COMMON FLAGS
  --repo <name>   target repository      --budget <tokens>  output ceiling (default 600)
  --json          machine-readable       --all              do not elide spots
`;

interface Args { _: string[]; flags: Record<string, string | boolean> }

function parse(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out.flags[key] = true;
      else { out.flags[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The working directory already names the project; only pass it if indexed.
 *  The resolution itself lives on the engine, so the CLI, the pi tools and the
 *  `/lens` command all fill `repo` the same way. */
const repoArg = (explicit?: string) => new GraphEngine().repoArg(process.cwd(), explicit);

async function askCmd(question: string, f: Args['flags']): Promise<number> {
  const repo = str(f.repo);
  const budget = Number(f.budget ?? 600);
  const input = { question, repo, cwd: process.cwd() };

  // Server first, in-process fallback. The fallback is silent by design: a tool
  // that fails because a background service is not running has made the user
  // responsible for its own optimisation.
  const r = (await askViaServer(input)) ?? (await ask(input));

  if (f.json) {
    console.log(JSON.stringify(r, null, 2));
    return r.spots.length ? 0 : 1;
  }
  console.log(`intent: ${r.plan.intent} — ${r.plan.why}  (${r.ms} ms)\n`);
  console.log(r.spots.length ? render(r.spots, f.all ? 1e9 : budget) : 'no spots found');
  for (const n of r.notes) console.log(`\n! ${n}`);
  return r.spots.length ? 0 : 1;
}

async function caps(): Promise<number> {
  const graph = new GraphEngine();
  const semantic = new SemanticEngine();
  const g = await graph.capabilities().catch(() => [] as string[]);
  const s = await semantic.capabilities();
  console.log(`graph (${g.length}):    ${g.join(' ')}`);
  console.log(`semantic (${s.length}): ${s.join(' ')}`);
  console.log(`routed (5):      ask spots breaks diff dupe`);
  console.log(`\ntotal reachable: ${g.length + s.length + 5}`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const { _, flags } = parse(argv);
  const cmd = _[0];

  switch (cmd) {
    case 'ask':
      return _[1] ? askCmd(_.slice(1).join(' '), flags) : (console.log(USAGE), 2);
    case 'spots':
    case 'breaks':
      return _[1] ? askCmd(_[1], flags) : (console.log(USAGE), 2);
    case 'dupe':
      return _[1] ? askCmd(`does this already exist: ${_[1]}`, flags) : (console.log(USAGE), 2);
    case 'serve': return serve();
    case 'mcp': return mcp();
    case 'diff': {
      const graph = new GraphEngine();
      const out = await graph.passthrough('detect_changes', {
        ...(await repoArg(str(flags.repo))),
        ...(str(flags.base) ? { scope: 'compare', base_ref: str(flags.base) } : {}),
      });
      console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
      return 0;
    }
    case 'graph':
    case 'semantic': {
      const tool = _[1];
      if (!tool) { console.log(USAGE); return 2; }
      const engine = cmd === 'graph' ? new GraphEngine() : new SemanticEngine();
      const args: Record<string, unknown> = { ...flags };
      if (cmd === 'graph' && !args.repo) Object.assign(args, await repoArg(undefined));
      if (_.length > 2) args._ = _.slice(2);
      const out = await engine.passthrough(tool, args);
      console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
      return 0;
    }
    case 'refresh':
      return refresh({
        repo: str(flags.repo),
        graphOnly: Boolean(flags['graph-only']),
        semanticEvery: flags['semantic-every'] !== undefined ? Number(flags['semantic-every']) : undefined,
        dryRun: Boolean(flags['dry-run']),
      });
    case 'caps': return caps();
    case 'doctor': return doctor({ parity: Boolean(flags.parity), json: Boolean(flags.json) });
    case 'install':
      return install({
        hotLoad: Boolean(flags['hot-load']),
        npu: Boolean(flags.npu),
        gpu: flags.gpu !== undefined ? Number(flags.gpu) : undefined,
        gpuGraph: flags['gpu-graph'] !== undefined ? Number(flags['gpu-graph']) : undefined,
        gpuSemantic: flags['gpu-semantic'] !== undefined ? Number(flags['gpu-semantic']) : undefined,
        warmEvery: flags['warm-every'] !== undefined ? Number(flags['warm-every']) : undefined,
        dryRun: Boolean(flags['dry-run']),
      });
    default:
      console.log(USAGE);
      return cmd ? 2 : 0;
  }
}
