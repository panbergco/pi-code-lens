/**
 * Evidence for a stalled semantic pass, recorded by the stalled daemon itself.
 *
 * Two real stalls (26 Sep) left no trace: the ccc daemon rewrites its log on
 * restart, and restarting was the only cure. This installs a small module into
 * each ccc tool environment that, inside the daemon only, answers SIGUSR1 by
 * writing every thread's stack, every pending asyncio task's stack (including
 * the loop GPU waiters sleep on) and the GPU pool's capacity to
 * ~/.code-lens/stalls/. The progress watchdog triggers it before restarting.
 *
 * Kept here as a string so the installer and the refresh share one copy; the
 * refresh re-installs it, because upgrading ccc replaces its environment.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const STALL_DIR = () => join(homedir(), '.code-lens', 'stalls');

export const RECORDER_SOURCE = "\"\"\"code-lens: record where a stalled ccc daemon is stuck (SIGUSR1 -> ~/.code-lens/stalls/).\n\nInstalled by code-lens into the ccc tool environment. Active only in the daemon\nprocess. Writes every thread's stack, every pending asyncio task's stack on every\nlive event loop, and the GPU pool's capacity -- the evidence two real stalls\n(26 Sep) lost because the daemon log is rewritten on restart.\n\"\"\"\nimport os\nimport sys\n\nif any(\"run-daemon\" in a for a in sys.argv):\n    import signal\n\n    def _dump(signum, frame):  # noqa: ARG001\n        import asyncio, faulthandler, gc, io, time\n        d = os.path.expanduser(\"~/.code-lens/stalls\")\n        os.makedirs(d, exist_ok=True)\n        path = os.path.join(d, f\"ccc-{os.getpid()}-{time.strftime('%Y%m%d-%H%M%S')}.txt\")\n        with open(path, \"w\") as f:\n            f.write(\"== threads\\n\")\n            f.flush()\n            faulthandler.dump_traceback(file=f, all_threads=True)\n            loops = [o for o in gc.get_objects() if isinstance(o, asyncio.AbstractEventLoop)]\n            main = asyncio.events._get_running_loop()   # the handler runs on the main thread\n            if main is not None and main not in loops:\n                loops.append(main)\n            try:\n                from cocoindex._internal import runner as r\n                pool = r._get_default_gpu_pool()\n                if pool._bound_loop is not None and pool._bound_loop not in loops:\n                    loops.append(pool._bound_loop)   # the loop GPU waiters sleep on\n                f.write(f\"\\n== GPU pool capacity={pool._capacity} bound_loop={id(pool._bound_loop):x}\\n\")\n            except Exception as e:  # noqa: BLE001\n                f.write(f\"\\n== GPU pool: unreadable ({e!r})\\n\")\n            for loop in loops:\n                f.write(f\"\\n== loop {id(loop):x} running={loop.is_running()} closed={loop.is_closed()}\\n\")\n                try:\n                    tasks = asyncio.all_tasks(loop)\n                except Exception as e:  # noqa: BLE001\n                    f.write(f\"  tasks unreadable: {e!r}\\n\")\n                    continue\n                for t in tasks:\n                    f.write(f\"\\n-- {t.get_name()}: {repr(t)[:240]}\\n\")\n                    buf = io.StringIO()\n                    t.print_stack(limit=25, file=buf)\n                    f.write(buf.getvalue())\n        sys.stderr.write(f\"[code-lens] stall dump written to {path}\\n\")\n\n    try:\n        signal.signal(signal.SIGUSR1, _dump)\n    except Exception:  # noqa: BLE001 -- never break the daemon over a diagnostic\n        pass\n";

/** Every ccc tool environment's site-packages directory on this machine. */
export function cccSitePackages(home = homedir()): string[] {
  const tools = join(home, '.local', 'share', 'uv', 'tools');
  const out: string[] = [];
  let envs: string[] = [];
  try { envs = readdirSync(tools).filter((d) => d.startsWith('cocoindex-code')); } catch { return out; }
  for (const env of envs) {
    let pys: string[] = [];
    try { pys = readdirSync(join(tools, env, 'lib')).filter((d) => d.startsWith('python')); } catch { continue; }
    for (const py of pys) {
      const sp = join(tools, env, 'lib', py, 'site-packages');
      if (existsSync(sp)) out.push(sp);
    }
  }
  return out;
}

/** Install or refresh the recorder in every ccc environment. Returns the ones changed. */
export function ensureStallRecorder(home = homedir()): string[] {
  const changed: string[] = [];
  for (const sp of cccSitePackages(home)) {
    const mod = join(sp, 'code_lens_stall_dump.py');
    const pth = join(sp, 'code_lens_stall_dump.pth');
    let current = '';
    try { current = readFileSync(mod, 'utf8'); } catch { /* absent */ }
    try {
      if (current !== RECORDER_SOURCE) { writeFileSync(mod, RECORDER_SOURCE); changed.push(sp); }
      if (!existsSync(pth)) { writeFileSync(pth, 'import code_lens_stall_dump\n'); if (!changed.includes(sp)) changed.push(sp); }
    } catch { /* not writable: the watchdog still works, only without evidence */ }
  }
  return changed;
}

/** Ask the running ccc daemon to record where it is stuck; the file written, if any. */
export async function captureStall(home = homedir(), waitMs = 3_000): Promise<string | undefined> {
  let pid = 0;
  try { pid = Number(readFileSync(join(home, '.cocoindex_code', 'daemon.pid'), 'utf8').trim()); } catch { return undefined; }
  if (!pid) return undefined;
  const before = Date.now();
  try { process.kill(pid, 'SIGUSR1'); } catch { return undefined; }
  const dir = join(home, '.code-lens', 'stalls');
  for (let waited = 0; waited < waitMs; waited += 200) {
    await new Promise((r) => setTimeout(r, 200));
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.startsWith(`ccc-${pid}-`)); } catch { continue; }
    const fresh = files.map((f) => join(dir, f)).find((f) => { try { return statSync(f).mtimeMs >= before - 1_000; } catch { return false; } });
    if (fresh) return fresh;
  }
  return undefined;
}
