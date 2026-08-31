/**
 * `lens doctor` — per-engine health, GPU residency, and PARITY.
 *
 * Parity is the load-bearing check. code-lens claims to cover 100% of what the
 * engines can do; that claim is worthless unless something FAILS when an engine
 * gains a capability the lens has never seen. A parity check that cannot fail
 * is decoration.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { GraphEngine } from '../engines/graph.js';
import { SemanticEngine } from '../engines/semantic.js';

/** Capabilities reachable through the lens: routed fast path + passthrough. */
const ROUTED = ['ask', 'spots', 'breaks', 'diff', 'dupe'];

export interface GpuProc { pid: number; name: string; mib: number }

export function gpuProcesses(): GpuProc[] {
  try {
    const out = execFileSync('nvidia-smi',
      ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader'],
      { encoding: 'utf8', timeout: 10_000 });
    return out.trim().split('\n').filter(Boolean).map((l) => {
      const [pid, name, mem] = l.split(',').map((s) => s.trim());
      return { pid: Number(pid), name: name ?? '', mib: parseInt(mem ?? '0', 10) || 0 };
    });
  } catch { return []; }
}

export function gpuSummary(): { index: number; usedMiB: number; totalMiB: number }[] {
  try {
    const out = execFileSync('nvidia-smi',
      ['--query-gpu=index,memory.used,memory.total', '--format=csv,noheader'],
      { encoding: 'utf8', timeout: 10_000 });
    return out.trim().split('\n').filter(Boolean).map((l) => {
      const [i, u, t] = l.split(',').map((s) => s.trim());
      return { index: Number(i), usedMiB: parseInt(u ?? '0', 10), totalMiB: parseInt(t ?? '0', 10) };
    });
  } catch { return []; }
}

export function amdGpuStatus() {
  try {
    const run = (args: string[]) => JSON.parse(execFileSync('amd-smi', args,
      { encoding: 'utf8', timeout: 10_000 }));
    const asic = run(['static', '--asic', '--json']).gpu_data?.[0]?.asic ?? {};
    const memory = run(['metric', '--mem-usage', '--json']).gpu_data?.[0]?.mem_usage ?? {};
    const processList = run(['process', '--json'])?.[0]?.process_list ?? [];
    const processes: GpuProc[] = processList.map((p: any) => {
      const info = p.process_info ?? {};
      const pid = Number(info.pid);
      let name = String(info.name ?? '');
      try { name = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim(); }
      catch { /* process exited between amd-smi and /proc */ }
      const bytes = Number(info.memory_usage?.gtt_mem?.value ?? 0) +
                    Number(info.memory_usage?.vram_mem?.value ?? 0);
      return { pid, name, mib: Math.round(bytes / 1024 / 1024) };
    });
    return {
      name: String(asic.market_name ?? 'AMD GPU'),
      target: String(asic.target_graphics_version ?? ''),
      usedGttMiB: Number(memory.used_gtt?.value ?? 0),
      processes,
    };
  } catch { return undefined; }
}

async function npuStatus() {
  const endpoint = process.env.LENS_NPU_URL ?? 'http://127.0.0.1:52625/v1';
  const device = existsSync('/dev/accel/accel0');
  let server = false;
  try {
    const r = await fetch(`${endpoint}/models`, { signal: AbortSignal.timeout(2_000) });
    server = r.ok;
  } catch { /* optional accelerator */ }
  return { device, server, endpoint, model: 'EmbeddingGemma-300M' };
}

/** Match a GPU-resident process to the engine that owns it. */
function residency(procs: GpuProc[]) {
  const hit = (re: RegExp) => procs.find((p) => re.test(p.name));
  return {
    semantic: hit(/cocoindex|ccc/i),
    graph: hit(/gitnexus|(^|\/)node$/i),
  };
}

export async function doctor(opts: { parity?: boolean; json?: boolean } = {}): Promise<number> {
  const graph = new GraphEngine();
  const semantic = new SemanticEngine();
  const [gh, sh, npu] = await Promise.all([graph.health(), semantic.health(), npuStatus()]);
  const amdGpu = amdGpuStatus();
  const procs = [...gpuProcesses(), ...(amdGpu?.processes ?? [])];
  const res = residency(procs);
  const gpus = gpuSummary();

  let caps: string[] = [];
  let capErr: string | undefined;
  try { caps = await graph.capabilities(); } catch (e) { capErr = (e as Error).message; }
  const sCaps = await semantic.capabilities();

  const report = {
    engines: {
      semantic: { ...sh, gpuMiB: res.semantic?.mib, capabilities: sCaps.length },
      graph: { ...gh, gpuMiB: res.graph?.mib, capabilities: caps.length },
    },
    gpu: gpus,
    amdGpu: amdGpu ? { name: amdGpu.name, target: amdGpu.target,
                       usedGttMiB: amdGpu.usedGttMiB } : undefined,
    npu,
    hotLoaded: { semantic: Boolean(res.semantic), graph: Boolean(res.graph) },
    parity: opts.parity ? parity(caps, sCaps, capErr) : undefined,
  };

  if (opts.json) { console.log(JSON.stringify(report, null, 2)); }
  else { print(report); }

  const failed =
    !report.engines.graph.up ||
    !report.engines.semantic.up ||
    (opts.parity && report.parity && !report.parity.ok);
  return failed ? 1 : 0;
}

function parity(graphCaps: string[], semCaps: string[], err?: string) {
  // Passthrough is generated, so every live capability IS reachable — the check
  // is that we can still ENUMERATE them. An engine we cannot interrogate is an
  // engine whose parity we cannot assert, and that must fail loudly.
  const unreachable: string[] = [];
  if (err) unreachable.push(`graph: cannot enumerate (${err})`);
  if (!graphCaps.length && !err) unreachable.push('graph: reported zero capabilities');
  if (!semCaps.length) unreachable.push('semantic: reported zero capabilities');
  return {
    ok: unreachable.length === 0,
    routed: ROUTED.length,
    graph: graphCaps.length,
    semantic: semCaps.length,
    total: graphCaps.length + semCaps.length,
    unreachable,
  };
}

function print(r: any): void {
  const mark = (b: boolean) => (b ? '✓' : '✗');
  console.log('code-lens doctor\n');
  console.log('Engines');
  for (const id of ['semantic', 'graph'] as const) {
    const e = r.engines[id];
    console.log(`  ${mark(e.up)} ${id.padEnd(9)} ${e.detail ?? ''}`);
    if (e.model) console.log(`      model:  ${e.model}${e.device ? `  device: ${e.device}` : ''}`);
    // Residency is measured through nvidia-smi. On a machine with no CUDA card
    // that probe can only ever say "no", so reporting NOT RESIDENT would be a
    // false alarm about a daemon that is in fact warm in RAM.
    const hot = r.hotLoaded[id] ? `RESIDENT (${e.gpuMiB} MiB)`
      : id === 'graph' && r.npu.server ? `NPU embeddings — ${r.npu.model}; graph traversal on CPU`
      : r.gpu.length || r.amdGpu ? 'NOT resident — first query pays a cold load'
      : 'CPU — residency not measurable here; the daemon keeps the model in RAM';
    console.log(`      hot:    ${hot}`);
    if (e.repos?.length) console.log(`      repos:  ${e.repos.join(', ')}`);
  }
  console.log('\nGPU');
  if (!r.gpu.length && !r.amdGpu) {
    console.log('  none usable — no CUDA or ROCm device detected. CPU is supported.');
  }
  if (r.amdGpu) {
    console.log(`  ${r.amdGpu.name} (${r.amdGpu.target}): ${r.amdGpu.usedGttMiB} MiB shared GTT in use`);
  }
  for (const g of r.gpu) {
    const free = g.totalMiB - g.usedMiB;
    console.log(`  GPU ${g.index}: ${g.usedMiB}/${g.totalMiB} MiB used  (${free} MiB headroom)`);
  }
  console.log('\nNPU');
  console.log(`  ${mark(r.npu.device)} XDNA device ${r.npu.device ? '/dev/accel/accel0' : 'not found'}`);
  console.log(`  ${mark(r.npu.server)} ${r.npu.server ? `${r.npu.model} serving at ${r.npu.endpoint}` : 'embedding server not reachable'}`);
  if (r.parity) {
    console.log('\nParity');
    console.log(`  ${mark(r.parity.ok)} ${r.parity.total} engine capabilities reachable ` +
                `(graph ${r.parity.graph}, semantic ${r.parity.semantic}) + ${r.parity.routed} routed verbs`);
    for (const u of r.parity.unreachable) console.log(`      UNREACHABLE: ${u}`);
  }
}
