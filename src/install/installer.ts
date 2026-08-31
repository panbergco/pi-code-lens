/**
 * `lens install` — the custom installer for both capability engines.
 *
 * code-lens does not vendor the engines; it PLACES them: installs each one the
 * way its upstream wants, then supervises both as always-on services with their
 * models resident on the GPU.
 *
 * The measured reason this exists: on this hardware a cold engine process
 * answers in ~2,550 ms and a warm resident one in ~190 ms. An engine that
 * unloads between questions gives back the entire benefit — and the semantic
 * engine's daemon idles out by default, which is precisely the failure this
 * installer's keep-warm timer prevents.
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface InstallOpts {
  /** Keep both models warm. Useful on CPU too; acceleration is configured independently. */
  hotLoad?: boolean;
  /** Legacy single-GPU pin. Used for both engines when the split flags are absent. */
  gpu?: number;
  /**
   * One card per engine. The two models are independent and neither saturates a
   * card alone, so sharing one GPU only creates a memory ceiling that forces
   * indexing to run serially. Split them and both can index at once.
   */
  gpuGraph?: number;
  gpuSemantic?: number;
  /** Use a local FastFlowLM XDNA2 endpoint for graph embeddings. */
  npu?: boolean;
  /** Minutes between keep-warm pings. Must be under the engine's idle timeout. */
  warmEvery?: number;
  dryRun?: boolean;
}

export type Accelerator =
  | { kind: 'nvidia'; devices: string[] }
  | { kind: 'amd'; devices: string[]; target: string }
  | { kind: 'cpu'; devices: [] };

const SEMANTIC_MODEL = 'Shuu12121/CodeSearch-ModernBERT-Crow-Plus';
const ROCM_INDEX = 'https://stable.repo.amd.com/rocm/whl-next/';
const ROCM_VERSION = '10.0.0';

/** Resolve the per-engine device placement from the flags given. */
export function placement(o: InstallOpts, deviceCount = gpuAvailable().devices.length): { graph: number; semantic: number } {
  const n = deviceCount;
  if (o.gpuGraph !== undefined || o.gpuSemantic !== undefined) {
    return { graph: o.gpuGraph ?? 0, semantic: o.gpuSemantic ?? (n > 1 ? 1 : 0) };
  }
  if (o.gpu !== undefined) return { graph: o.gpu, semantic: o.gpu };
  // Default: split across cards when there is more than one. The semantic
  // engine takes the higher index because its model is the larger of the two
  // and the desktop usually lives on GPU 0.
  return n > 1 ? { graph: 0, semantic: 1 } : { graph: 0, semantic: 0 };
}

/**
 * Interval in minutes -> a VALID systemd calendar spec.
 *
 * `*:0/60` is not valid — a minute field cannot step by 60 — and systemd
 * rejects the whole unit for it, leaving a timer that loads as "bad-setting"
 * and never fires. Wall-clock schedules are used rather than OnBootSec/
 * OnUnitActiveSec because monotonic timers stop scheduling silently when their
 * chain breaks (a disable/enable cycle, or a boot far in the past) while still
 * reporting active.
 */
export function calendarFor(minutes: number): string {
  if (minutes < 60) return `*:0/${Math.max(1, Math.floor(minutes))}`;
  const hours = Math.max(1, Math.round(minutes / 60));
  return hours === 1 ? 'hourly' : `0/${hours}:00`;
}

const UNIT_DIR = join(homedir(), '.config/systemd/user');
const GRAPH_PORT = Number(process.env.LENS_GRAPH_PORT ?? 3737);

export function gpuAvailable(): { present: boolean; devices: string[] } {
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=index,name,memory.total', '--format=csv,noheader'],
      { encoding: 'utf8', timeout: 10_000 });
    const devices = out.trim().split('\n').filter(Boolean);
    return { present: devices.length > 0, devices };
  } catch { return { present: false, devices: [] }; }
}

/** Detect the runtime we can actually install, not merely a display adapter. */
export function acceleratorAvailable(): Accelerator {
  const nvidia = gpuAvailable();
  if (nvidia.present) return { kind: 'nvidia', devices: nvidia.devices };
  if (!existsSync('/dev/kfd')) return { kind: 'cpu', devices: [] };
  try {
    const detector = which('rocm-bootstrap-detect');
    const out = detector
      ? execFileSync(detector, ['--unique'], { encoding: 'utf8', timeout: 30_000 })
      : execFileSync('uvx', ['--from', 'rocm-bootstrap', '--index', ROCM_INDEX,
          'rocm-bootstrap-detect', '--unique'], { encoding: 'utf8', timeout: 120_000 });
    const targets = out.trim().split('\n').filter((x) => /^gfx[0-9a-f]+$/i.test(x));
    if (targets.length > 0) return { kind: 'amd', target: targets[0]!, devices: targets };
  } catch { /* no installable ROCm target */ }
  return { kind: 'cpu', devices: [] };
}

function which(bin: string): string | undefined {
  try { return execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).trim() || undefined; }
  catch { return undefined; }
}

function have(bin: string): boolean { return Boolean(which(bin)); }

function npuEndpointActive(): boolean {
  try {
    execFileSync('curl', ['-fsS', '--max-time', '2', 'http://127.0.0.1:52625/v1/models'],
      { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function write(path: string, body: string, dry: boolean): void {
  if (dry) { console.log(`--- would write ${path} ---\n${body}`); return; }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  console.log(`  wrote ${path}`);
}

function sh(cmd: string, dry: boolean): void {
  if (dry) { console.log(`  would run: ${cmd}`); return; }
  execSync(cmd, { stdio: 'inherit' });
}

/** Step 1 — place both engines and the accelerator-specific ccc runtime. */
export function installEngines(opts: InstallOpts, dry: boolean,
                               accelerator: Accelerator = acceleratorAvailable()): void {
  console.log('\n[1/4] engines');
  const packageRoot = new URL('../..', import.meta.url).pathname;
  sh(`ln -sfn "${packageRoot}bin/lens.mjs" "${homedir()}/.local/bin/lens"`, dry);
  // The keep-warm unit below runs this script; link it too, or a fresh machine gets a
  // timer pointing at a file that only ever existed on the author's box.
  sh(`ln -sfn "${packageRoot}bin/code-lens-keepwarm" "${homedir()}/.local/bin/code-lens-keepwarm"`, dry);
  if (have('gitnexus')) console.log('  ✓ graph engine (gitnexus) present');
  else {
    if (!have('npm')) throw new Error('npm is required to install GitNexus');
    console.log('  installing graph engine…');
    // User prefix avoids root; optional grammars add minutes and a C++ toolchain.
    sh(`GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1 npm install -g --prefix="${homedir()}/.npm-global" gitnexus@latest`, dry);
  }
  if (!have('uv')) throw new Error('uv is required to install cocoindex-code (ccc)');

  if (accelerator.kind === 'amd') {
    const root = join(homedir(), '.local/share/uv/tools/cocoindex-code-rocm');
    const profile = join(root, 'ROCM_PROFILE');
    const ready = existsSync(join(root, 'bin/ccc')) && existsSync(profile) &&
                  readFileSync(profile, 'utf8').includes(accelerator.target);
    if (ready) console.log(`  ✓ semantic engine (ccc) ROCm ${accelerator.target} profile present`);
    else {
      console.log(`  installing semantic engine for AMD ${accelerator.target}…`);
      sh(`rm -rf "${root}" && uv venv "${root}"`, dry);
      sh(`uv pip install --python "${root}/bin/python" --default-index https://pypi.org/simple ` +
         `--index ${ROCM_INDEX} --index-strategy unsafe-best-match ` +
         `'cocoindex-code[full]' 'mcp<2' ` +
         `'torch[device-${accelerator.target}]==2.13.0+rocm${ROCM_VERSION}'`, dry);
    }
    const wrapper = join(homedir(), '.local/bin/ccc-rocm');
    write(wrapper, `#!/bin/sh
root="${root}"
provider=$(find "$root/lib" -path '*/site-packages/cocoindex/ops/sentence_transformers.py' -print -quit)
# Batch 8 matched the default's speed on gfx1150 while saving about 0.8 GiB.
if grep -q 'runner=coco.GPU, max_batch_size=64' "$provider" 2>/dev/null; then
  sed -i 's/runner=coco.GPU, max_batch_size=64/runner=coco.GPU, max_batch_size=8/' "$provider"
fi
exec "$root/bin/ccc" "$@"
`, dry);
    sh(`chmod +x "${wrapper}"`, dry);
    if (existsSync(join(homedir(), '.local/share/uv/tools/cocoindex-code/bin/ccc'))) {
      sh(`ln -sfn "${homedir()}/.local/share/uv/tools/cocoindex-code/bin/ccc" "${homedir()}/.local/bin/ccc-cpu"`, dry);
    }
    sh(`ln -sfn "${wrapper}" "${homedir()}/.local/bin/ccc"`, dry);
    sh(`ln -sfn "${root}/bin/amd-smi" "${homedir()}/.local/bin/amd-smi"`, dry);
    write(profile, `ROCm ${ROCM_VERSION}; target=${accelerator.target}; sentence-transformers batch=8\n`, dry);
  } else if (accelerator.kind === 'nvidia') {
    console.log('  installing/updating semantic engine for NVIDIA CUDA…');
    // PyPI's Linux torch distribution carries the CUDA runtime; ccc doctor below proves the card is usable.
    sh(`uv tool install --force --upgrade 'cocoindex-code[full]' --with 'mcp<2'`, dry);
    sh(`ln -sfn "${homedir()}/.local/share/uv/tools/cocoindex-code/bin/ccc" "${homedir()}/.local/bin/ccc"`, dry);
  } else if (have('ccc')) {
    console.log('  ✓ semantic engine (ccc) present');
  } else {
    console.log('  installing semantic engine for CPU…');
    // mcp<2 is load-bearing: 2.x removed a module while leaving the CLI apparently healthy.
    sh(`uv tool install --force --upgrade 'cocoindex-code[full]' --with 'mcp<2'`, dry);
  }

  if (opts.npu) {
    if (!existsSync('/dev/accel/accel0')) {
      throw new Error('XDNA device /dev/accel/accel0 not found; --npu cannot be enabled');
    }
    const flm = which('flm');
    if (!flm) {
      throw new Error('FastFlowLM not found. On Arch: sudo pacman -S xrt xrt-plugin-amdxdna fastflowlm');
    }
    sh(`${flm} pull embed-gemma:300m && ${flm} pull gemma3:1b`, dry);
  }
}

export function replaceYamlSection(source: string, key: string, body: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.trim() === `${key}:` && !line.startsWith(' '));
  if (start < 0) return `${source.trimEnd()}${source.trim() ? '\n' : ''}${body.trimEnd()}\n`;
  let end = start + 1;
  while (end < lines.length && (lines[end]!.startsWith(' ') || !lines[end]!.trim())) end++;
  return [...lines.slice(0, start), ...body.trimEnd().split('\n'), ...lines.slice(end)].join('\n');
}

function configureSemantic(device: string | undefined, dry: boolean): void {
  const path = join(homedir(), '.cocoindex_code/global_settings.yml');
  const old = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const block = `embedding:
  provider: sentence-transformers
  model: ${SEMANTIC_MODEL}${device ? `\n  device: ${device}` : ''}
  indexing_params: {}
  query_params:
    prompt_name: query`;
  write(path, replaceYamlSection(old, 'embedding', block), dry);
  if (!dry && have('ccc')) sh('ccc daemon stop >/dev/null 2>&1 || true', false);
}

/** Step 2 — configure the detected accelerator; hot-load only controls residency. */
export function configureGpu(opts: InstallOpts, dry: boolean,
                             accelerator: Accelerator = acceleratorAvailable()): boolean {
  console.log('\n[2/4] accelerator');
  if (accelerator.kind === 'nvidia') {
    accelerator.devices.forEach((d) => console.log(`  found NVIDIA: ${d}`));
    const p = placement(opts, accelerator.devices.length);
    configureSemantic(`cuda:${p.semantic}`, dry);
    console.log(`  semantic: ${SEMANTIC_MODEL} on CUDA GPU ${p.semantic}`);
    console.log(`  graph:    CUDA GPU ${p.graph}`);
  } else if (accelerator.kind === 'amd') {
    console.log(`  found AMD ROCm target: ${accelerator.target}`);
    configureSemantic('cuda', dry); // PyTorch's HIP backend intentionally uses the cuda API name.
    console.log(`  semantic: ${SEMANTIC_MODEL} on ROCm ${accelerator.target}`);
    console.log(`  graph:    ${opts.npu ? 'XDNA2 NPU endpoint' : 'CPU traversal/embeddings'}`);
  } else {
    configureSemantic(undefined, dry);
    console.log('  no installable GPU runtime detected — both engines use CPU');
  }
  console.log(`  keep-warm ${opts.hotLoad ? 'ENABLED' : 'disabled'}${opts.hotLoad ? '' : ' (pass --hot-load to enable)'}`);
  return Boolean(opts.hotLoad);
}

/** Step 3 — supervise: always-on services, pre-warmed at start. */
export function installServices(opts: InstallOpts, hot: boolean, dry: boolean,
                                accelerator: Accelerator = acceleratorAvailable()): void {
  console.log('\n[3/4] services');
  const p = placement(opts, accelerator.kind === 'nvidia' ? accelerator.devices.length : 0);
  const graphBin = which('gitnexus') ?? join(homedir(), '.npm-global/bin/gitnexus');
  const npu = Boolean(opts.npu);
  const npuEnv = npu ? `Environment=CUDA_VISIBLE_DEVICES=\nEnvironment=GITNEXUS_EMBEDDING_DEVICE=cpu
Environment=GITNEXUS_EMBEDDING_URL=http://127.0.0.1:52625/v1
Environment=GITNEXUS_EMBEDDING_MODEL=embed-gemma
Environment=GITNEXUS_EMBEDDING_API_KEY=flm
Environment=GITNEXUS_EMBEDDING_DIMS=768
Environment=GITNEXUS_EMBEDDING_BATCH_SIZE=1
Environment=GITNEXUS_EMBEDDING_SUB_BATCH_SIZE=1
Environment=GITNEXUS_EMBEDDING_TIMEOUT_MS=30000
Environment=GITNEXUS_EMBEDDING_TIMEOUT_RETRIES=3
Environment=GITNEXUS_EMBEDDING_HTTP_TIMEOUT_MS=30000
Environment=GITNEXUS_EMBEDDING_MAX_ATTEMPTS=4
Environment=GITNEXUS_EMBEDDING_RETRY_TIMEOUTS=1
` : '';
  const env = npu ? npuEnv : accelerator.kind === 'nvidia'
    ? `Environment=CUDA_VISIBLE_DEVICES=${p.graph}\nEnvironment=GITNEXUS_EMBEDDING_DEVICE=cuda\n`
    : `Environment=CUDA_VISIBLE_DEVICES=\nEnvironment=GITNEXUS_EMBEDDING_DEVICE=cpu\n`;
  const npuUp = npu && npuEndpointActive();

  if (npu && !npuUp) {
    const flm = which('flm')!;
    write(join(UNIT_DIR, 'flm-embed.service'), `[Unit]
Description=FastFlowLM XDNA2 embedding server for code-lens
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=HOME=${homedir()}
Environment=FLM_DISABLE_UPDATE_CHECK=1
ExecStart=${flm} serve gemma3:1b --embed 1 --host 127.0.0.1 --port 52625
Restart=on-failure
RestartSec=3
LimitMEMLOCK=infinity

[Install]
WantedBy=default.target
`, dry);
  } else if (npu) {
    console.log('  ✓ existing FastFlowLM embedding endpoint at 127.0.0.1:52625');
  }

  write(join(UNIT_DIR, 'gitnexus-mcp.service'), `[Unit]
Description=GitNexus MCP server (code-lens graph engine)
After=network.target

[Service]
Type=simple
${env}Environment=PATH=${homedir()}/.npm-global/bin:/usr/local/bin:/usr/bin
ExecStart=${graphBin} mcp --http --port ${GRAPH_PORT} --host 127.0.0.1
ExecStartPost=${homedir()}/.local/bin/gitnexus-warm
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`, dry);

  // The semantic engine ships its own daemon with an idle timeout, so "always
  // on" for it means a keep-warm ping rather than a supervised process: the
  // daemon starts on demand and stays up only while it is being used.
  if (hot) {
    const every = opts.warmEvery ?? 60;
    write(join(UNIT_DIR, 'code-lens-warm.service'), `[Unit]
Description=code-lens keep-warm — stops engine models from idling out of GPU memory

[Service]
Type=oneshot
Environment=PATH=${homedir()}/.local/bin:${homedir()}/.npm-global/bin:/usr/local/bin:/usr/bin
ExecStart=${homedir()}/.local/bin/code-lens-keepwarm
`, dry);

    write(join(UNIT_DIR, 'code-lens-warm.timer'), `[Unit]
Description=code-lens keep-warm every ${every} min (under the semantic daemon's idle timeout)

[Timer]
OnCalendar=${calendarFor(every)}
AccuracySec=1min
Persistent=true

[Install]
WantedBy=timers.target
`, dry);
  }

  // Freshness: both engines support incremental updates and nothing was
  // triggering them. This timer is the trigger. It runs often because the GRAPH
  // delta is cheap (seconds); the semantic engine is rate-limited inside the
  // command itself, since a full pass on a large repo costs ~50 minutes.
  const repoRootForRefresh = new URL('../..', import.meta.url).pathname;
  write(join(UNIT_DIR, 'code-lens-refresh.service'), `[Unit]
Description=code-lens index refresh — incremental update of both engines

[Service]
Type=oneshot
Environment=PATH=${homedir()}/.local/bin:${homedir()}/.npm-global/bin:/usr/local/bin:/usr/bin
${npuEnv}ExecStart=/usr/bin/node ${repoRootForRefresh}bin/lens.mjs refresh
`, dry);

  write(join(UNIT_DIR, 'code-lens-refresh.timer'), `[Unit]
Description=code-lens index refresh every 15 min (graph delta is seconds; semantic is gated inside)

[Timer]
OnCalendar=*:0/15
AccuracySec=2min
Persistent=true

[Install]
WantedBy=timers.target
`, dry);

  // The lens's own hot server: holds both engines' connections open so a CLI
  // call costs a local round trip instead of a Node start plus an MCP
  // handshake. Loopback only — it serves repository contents.
  const repoRoot = new URL('../..', import.meta.url).pathname;
  write(join(UNIT_DIR, 'code-lens.service'), `[Unit]
Description=code-lens hot server (routing + fusion over both engines)
After=network.target gitnexus-mcp.service

[Service]
Type=simple
Environment=PATH=${homedir()}/.local/bin:${homedir()}/.npm-global/bin:/usr/local/bin:/usr/bin
Environment=LENS_PORT=${process.env.LENS_PORT ?? 3939}
ExecStart=/usr/bin/node ${repoRoot}bin/lens.mjs serve
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`, dry);

  sh('systemctl --user daemon-reload', dry);
  if (npu && !npuUp) sh('systemctl --user enable --now flm-embed.service', dry);
  sh('systemctl --user enable gitnexus-mcp.service code-lens.service code-lens-refresh.timer', dry);
  sh('systemctl --user restart gitnexus-mcp.service code-lens.service code-lens-refresh.timer', dry);
  if (hot) {
    sh('systemctl --user enable code-lens-warm.timer', dry);
    sh('systemctl --user restart code-lens-warm.timer', dry);
  }
}

/** Step 4 — verify the installed binaries, model/device pair, services, and parity. */
export function verify(dry: boolean): void {
  console.log('\n[4/4] verify');
  if (dry) { console.log('  (dry run — skipped)'); return; }
  const graphBin = which('gitnexus') ?? join(homedir(), '.npm-global/bin/gitnexus');
  const semanticBin = which('ccc') ?? join(homedir(), '.local/bin/ccc');
  sh(`"${graphBin}" --version`, false);
  sh(`"${semanticBin}" doctor`, false); // Downloads the model and proves it embeds on the configured device.
  const root = new URL('../..', import.meta.url).pathname;
  sh(`/usr/bin/node "${root}bin/lens.mjs" doctor --parity`, false);
}

export async function install(opts: InstallOpts): Promise<number> {
  const dry = Boolean(opts.dryRun);
  const accelerator = acceleratorAvailable();
  console.log(`code-lens installer${dry ? ' (DRY RUN)' : ''}`);
  console.log(`accelerator: ${accelerator.kind}${accelerator.kind === 'amd' ? ` (${accelerator.target})` : ''}`);
  installEngines(opts, dry, accelerator);
  const hot = configureGpu(opts, dry, accelerator);
  installServices(opts, hot, dry, accelerator);
  verify(dry);
  return 0;
}
