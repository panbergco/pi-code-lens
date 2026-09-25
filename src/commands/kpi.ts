/**
 * `lens kpi` — of the moments this index COULD have answered, what share did it?
 *
 * The single number that says whether the tool is earning its place in a given
 * checkout. It is deliberately measured from the agent's own transcripts rather
 * than from anything this project writes about itself: a tool grading its own
 * homework is how "it's working well" survives a day of it not working at all.
 *
 * ── THE DENOMINATOR IS THE WHOLE EXERCISE ─────────────────────────────────────
 * Three filters decide "could have", and every one of them was added after a
 * measurement lied:
 *
 *   1. The index must actually hold structure for the subject. Checked against
 *      the graph's own list of names that have callers — never assumed.
 *   2. The command must be a code search. A command containing the word "grep"
 *      is not one: measured on a large monorepo, of 33,189 such commands 21,389
 *      were sprint paperwork and 8,895 were `tmux capture-pane | grep Working`
 *      polling other agents. Counting them inflates opportunities ~15x.
 *   3. The subject must look like code. `sprint`, `CHECK` and `resident` are
 *      English words that also exist as symbols; requiring camelCase, an
 *      underscore or a code path keeps English out of the denominator (~2x).
 *
 * Without 2 and 3 the same data reads 20.8% instead of 49.2%. The filters live
 * here, in code, so the number cannot drift with whoever is presenting it.
 *
 * ── PER PROJECT, ALWAYS ───────────────────────────────────────────────────────
 * The KPI is a property of a checkout, not of the tool: it moves with what the
 * agents in THAT repo spend their day doing, and with how complete that repo's
 * index is. A repo whose agents file paperwork and poll panes can sit at a
 * fraction of one whose agents read code all day, with the same engine, the same
 * build, and nothing wrong. So the report is per repo and never averaged.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GraphEngine } from '../engines/graph.js';
import { promptSubjects, searchSubject } from '../core/augment.js';
import { readDeliveries, type Delivery } from '../core/deliveries.js';

/** Sessions pi keeps for a checkout: the absolute path, `/` → `-`, fenced by `--`. */
export function sessionDirFor(repoDir: string, home = homedir()): string {
  return join(home, '.pi', 'agent', 'sessions', `-${repoDir.replace(/\//g, '-')}--`);
}

/** Commands that merely contain a search word while doing something else. */
const NOISE_RE = /tmux|capture-pane|\/proc\/|pgrep|\bps -|journalctl|\.log\b|\.jsonl|-proof|-docs\//;
const CODE_PATH_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|php|swift|kt)\b/;
/** A subject worth counting: shaped like an identifier, or named with a code path. */
const codeShaped = (sub: string | null, cmd: string) =>
  !!sub && (/[a-z][A-Z]|_/.test(sub) || CODE_PATH_RE.test(cmd));

export interface Kpi {
  repo: string;
  moments: Record<'search' | 'prompt' | 'edit', { happened: number; addressable: number; served: number }>;
  byAnswer: number;
  byTool: number;
  nudged: number;
  /** Every lens tool call the agent made of its own accord. `byTool` counts
   *  only the ones that followed a search on the same subject, so a lens call
   *  made INSTEAD of searching — the case adoption is about — was invisible:
   *  the report said 0 while the transcripts held 4. */
  lensChosen: number;
  /** Packs delivered on prompts that named no code the graph knows. */
  packsUnasked: number;
  /** Why the unserved moments went unserved. A KPI that reports only a
   *  percentage sends the reader to write their own script, and two scripts
   *  disagreeing about the same hour is how a day gets lost. */
  why: Record<string, number>;
  /** Moments left unanswered ON PURPOSE, because the same subject was answered
   *  minutes earlier and is still in the reader's context. Counting these as
   *  failures measures the memory doing its job: on a large monorepo they were
   *  54.7% of all misses. */
  recentlyTold: number;
  misses: Array<[string, number]>;
  sessions: number;
  /** What was measured, when it was not simply "this checkout". */
  scope?: string;
}

/** Files something imports — the only honest test of whether an EDIT is
 *  addressable. A file stem is not a symbol name: `dataset.ts` never appears in
 *  the caller graph, yet seven files import it, so testing the stem against
 *  symbol names scored every such edit as unanswerable and hid a whole channel. */
async function importedFiles(repo: string | undefined, graph: GraphEngine): Promise<Set<string>> {
  const out: any = await graph.passthrough('cypher', {
    query: "MATCH ()-[r:CodeRelation]->(b) WHERE r.type='IMPORTS' AND b.name IS NOT NULL " +
           'RETURN DISTINCT b.name AS name LIMIT 20000',
    ...(repo ? { repo } : {}),
  });
  return new Set(String(out?.markdown ?? '').split('\n').slice(2)
    .map((l) => l.replace(/\|/g, '').trim().toLowerCase().replace(/\.[^.]+$/, '')).filter(Boolean));
}

/** Names the graph can say something structural about, in one batch query. */
async function knownNames(repo: string | undefined, graph: GraphEngine): Promise<Set<string>> {
  const out: any = await graph.passthrough('cypher', {
    query: "MATCH (x)-[r:CodeRelation]->(n) WHERE r.type='CALLS' AND n.name IS NOT NULL " +
           'RETURN DISTINCT n.name AS name LIMIT 20000',
    ...(repo ? { repo } : {}),
  });
  const rows = String(out?.markdown ?? '').split('\n').slice(2)
    .map((l) => l.replace(/\|/g, '').trim().toLowerCase()).filter(Boolean);
  return new Set(rows);
}

export async function kpi(
  o: { repo?: string; cwd?: string; sinceHours?: number; sessions?: string[] } = {},
): Promise<number> {
  const cwd = o.cwd ?? process.cwd();
  const graph = new GraphEngine();
  const repoArg = await graph.repoArg(cwd, o.repo);
  const known = await knownNames((repoArg as any).repo, graph);
  const imported = await importedFiles((repoArg as any).repo, graph);
  if (!known.size) {
    console.log('no structural index for this repo — nothing to measure. run: lens refresh');
    return 1;
  }
  const since = Date.now() - (o.sinceHours ?? 24) * 3_600_000;
  const dir = sessionDirFor(cwd);

  const K: Kpi = {
    repo: cwd.split('/').pop() ?? cwd,
    moments: {
      search: { happened: 0, addressable: 0, served: 0 },
      prompt: { happened: 0, addressable: 0, served: 0 },
      edit: { happened: 0, addressable: 0, served: 0 },
    },
    byAnswer: 0, byTool: 0, nudged: 0, recentlyTold: 0, misses: [], sessions: 0,
    lensChosen: 0, packsUnasked: 0,
    why: {},
    scope: o.sessions?.length ? `${o.sessions.length} named session(s)` : undefined,
  };
  const missed = new Map<string, number>();

  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); }
  catch { console.log(`no pi sessions recorded for ${cwd}`); return 1; }
  // Narrow to named sessions when asked. A checkout's transcripts include every
  // session ever opened in it — including throwaway probes — and mixing those
  // with the agents actually doing the work measures the wrong population. The
  // id is the one on each session's status line.
  if (o.sessions?.length)
    files = files.filter((f) => o.sessions!.some((id) => f.includes(id)));

  for (const f of files) {
    const path = join(dir, f);
    if (statSync(path).mtimeMs < since) continue;
    K.sessions++;
    type Ev = { t: number; kind: string; subject?: string | null; text?: string; path?: string };
    const ev: Ev[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      let x: any; try { x = JSON.parse(line); } catch { continue; }
      const t = Date.parse(x?.timestamp ?? 0);
      if (!t || t < since) continue;
      if (x.type === 'custom_message') {
        const m = x.message ?? x;
        if ((m.customType ?? x.customType) === 'code-lens-context') {
          // Classified by what the message CARRIES, in every wording the hook
          // has used. Recognising only the first nudge wording meant every later
          // nudge — and every message carrying nothing but the repository map —
          // was scored as a served answer.
          const c = String(m.content);
          const kind = /already knows about this task/.test(c) ? 'pack'
            : /no strong structural match|nothing strong matched/.test(c) ? 'nudge'
            : 'map';
          ev.push({ t, kind });
        }
        continue;
      }
      if (x.type !== 'message') continue;
      const m = x.message;
      if (m?.role === 'user') {
        const txt = Array.isArray(m.content) ? m.content.map((c: any) => c?.text ?? '').join('') : String(m.content ?? '');
        ev.push({ t, kind: 'prompt', text: txt.trim() });
      } else if (m?.role === 'assistant') {
        for (const c of m.content ?? []) {
          if (c.type !== 'toolCall') continue;
          const a = c.arguments ?? {};
          if (String(c.name).startsWith('lens_')) {
            K.lensChosen++;
            ev.push({ t, kind: 'lens', subject: String(a.symbol ?? a.question ?? '').toLowerCase() });
          } else if (c.name === 'edit' || c.name === 'write') {
            ev.push({ t, kind: 'edit', path: String(a.path ?? '') });
          } else {
            const cmd = `${a.command ?? ''} ${a.path ?? ''} ${a.pattern ?? ''}`;
            const sub = searchSubject(String(c.name), a);
            const real = sub && !NOISE_RE.test(cmd) && codeShaped(sub, cmd);
            ev.push({ t, kind: real ? 'search' : 'other', subject: sub });
          }
        }
      } else if (m?.role === 'toolResult') {
        const txt = (m.content ?? []).map((c: any) => c?.text ?? '').join('');
        // Every shape the index speaks in: on a search, on an empty search, and
        // on an edit. A channel the KPI cannot see reads as a channel that does
        // not work — which is how the prompt pack showed up as zero for a day.
        const hit = /what the index knows about "([^"]+)"|that search found nothing; the index has "([^"]+)"/.exec(txt);
        if (hit) ev.push({ t, kind: 'answer', subject: hit[1] ?? hit[2] });
        const radius = /you just changed "([^"]+)"; this depends on it/.exec(txt);
        if (radius) ev.push({ t, kind: 'radius', subject: radius[1] });
      }
    }

    const told = new Map<string, number>();
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]!;
      if (e.kind === 'answer' || e.kind === 'radius') told.set(String(e.subject).toLowerCase(), e.t);
      if (e.kind === 'search' && e.subject) {
        K.moments.search.happened++;
        if (!known.has(e.subject.toLowerCase())) continue;
        K.moments.search.addressable++;
        const after = ev.slice(i + 1, i + 4);
        if (after.some((x) => x.kind === 'answer' && x.subject === e.subject)) { K.moments.search.served++; K.byAnswer++; }
        else if (after.some((x) => x.kind === 'lens' && x.subject?.includes(e.subject!.toLowerCase()))) { K.moments.search.served++; K.byTool++; }
        else if (told.has(e.subject.toLowerCase()) && e.t - told.get(e.subject.toLowerCase())! < 30 * 60_000) {
          K.recentlyTold++;
          bump(K, 'search: already answered minutes ago');
        } else {
          missed.set(e.subject, (missed.get(e.subject) ?? 0) + 1);
          bump(K, 'search: never answered in this session');
        }
      }
      if (e.kind === 'prompt' && (e.text?.length ?? 0) >= 12) {
        K.moments.prompt.happened++;
        const near = ev.slice(i, i + 3);
        const packed = near.some((x) => x.kind === 'pack');
        // Answerable means the prompt NAMES code the graph knows — judged with the
        // hook's own extractor, and never by whether a pack arrived. Letting a
        // served pack prove the prompt was answerable put every success in the
        // denominator too, so the row read 81-100% while the channel delivered
        // one pack in three hours.
        const named = promptSubjects(e.text!, 5)
          .some((w) => known.has(w.toLowerCase()) || imported.has(w.toLowerCase()));
        if (!named) { if (packed) K.packsUnasked++; continue; }
        K.moments.prompt.addressable++;
        if (packed) K.moments.prompt.served++;
        else if (near.some((x) => x.kind === 'nudge')) { K.nudged++; bump(K, 'prompt: nudged, not answered'); }
        else bump(K, 'prompt: named known code, got nothing');
      }
      if (e.kind === 'edit' && CODE_PATH_RE.test(e.path ?? '')) {
        const sym = (e.path!.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
        K.moments.edit.happened++;
        // Addressable when the graph knows the symbol OR knows that something
        // imports the file. Test files and entry points import nothing and are
        // correctly excluded — a blast radius for a leaf is not knowledge.
        if (!known.has(sym.toLowerCase()) && !imported.has(sym.toLowerCase())) continue;
        K.moments.edit.addressable++;
        const before = ev.slice(Math.max(0, i - 8), i);
        const after = ev.slice(i + 1, i + 3);
        // Pulled first, or handed over straight after the write — both leave the
        // agent holding the callers while the change is still the thing being
        // worked on, which is what the moment is for.
        if (before.some((x) => (x.kind === 'lens' && x.subject?.includes(sym.toLowerCase())) ||
                               (x.kind === 'answer' && x.subject?.toLowerCase() === sym.toLowerCase())) ||
            after.some((x) => x.kind === 'radius' && x.subject?.toLowerCase() === sym.toLowerCase()))
          K.moments.edit.served++;
        // An edit loop is the normal shape of work: 72 edits in one hour landed
        // on 13 files, three of them test files saved 16, 12 and 10 times. One
        // answer per file per repeat window is the DESIGN, so scoring every
        // later save as a failure measures the memory, not the tool.
        else if (told.has(sym.toLowerCase()) && e.t - told.get(sym.toLowerCase())! < 30 * 60_000) {
          K.recentlyTold++;
          bump(K, 'edit: same file answered minutes ago');
        } else bump(K, 'edit: no blast radius offered');
      }
    }
  }
  K.misses = [...missed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  await graph.close();
  render(K, o.sinceHours ?? 24);
  renderLog(readDeliveries(cwd, since), Boolean(o.sessions?.length));
  return 0;
}

const bump = (K: Kpi, k: string) => { K.why[k] = (K.why[k] ?? 0) + 1; };

/**
 * What the delivery log recorded, channel by channel, with the reasons for
 * silence. The table above is reconstructed from transcripts; this is what the
 * extension wrote down at the moment it decided. Where the two disagree, the
 * log is the record and the transcripts are the check.
 */
function renderLog(log: Delivery[], filtered: boolean): void {
  if (!log.length) {
    console.log('\n  delivery log: nothing recorded for this repository in this window yet');
    return;
  }
  const channels = ['prompt', 'search', 'empty-search', 'edit', 'map'] as const;
  console.log(`\n  recorded live (delivery log, ${log.length} decisions${filtered ? ', every session in this repository' : ''}):`);
  console.log('    channel'.padEnd(18) + 'delivered'.padStart(10) + 'silent'.padStart(8) + '  median ms   why silent');
  for (const ch of channels) {
    const rows = log.filter((d) => d.channel === ch);
    if (!rows.length) continue;
    const ok = rows.filter((d) => d.outcome === 'delivered');
    const ms = rows.map((d) => d.ms).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
    const why = new Map<string, number>();
    for (const d of rows) if (d.outcome === 'silent') why.set(d.reason, (why.get(d.reason) ?? 0) + 1);
    const top = [...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${r} ×${n}`).join(', ');
    console.log(`    ${ch}`.padEnd(18) + String(ok.length).padStart(10) + String(rows.length - ok.length).padStart(8) +
                `  ${ms.length ? String(ms[ms.length >> 1]).padStart(9) : '        —'}   ${top}`);
  }
}

function render(K: Kpi, hours: number): void {
  const pct = (a: number, b: number) => (b ? `${(a / b * 100).toFixed(1)}%` : '—');
  const A = Object.values(K.moments).reduce((n, m) => n + m.addressable, 0);
  const S = Object.values(K.moments).reduce((n, m) => n + m.served, 0);
  console.log(`code-lens effectiveness — ${K.repo} · last ${hours}h · ${K.sessions} session(s)` +
              `${K.scope ? ` · ${K.scope}` : ''}\n`);
  console.log('  moment'.padEnd(14) + 'happened'.padStart(10) + 'index could'.padStart(13) + 'index did'.padStart(11) + 'KPI'.padStart(8));
  for (const [name, m] of Object.entries(K.moments))
    console.log(`  ${name}`.padEnd(14) + String(m.happened).padStart(10) + String(m.addressable).padStart(13) +
                String(m.served).padStart(11) + pct(m.served, m.addressable).padStart(8));
  console.log('  ' + '-'.repeat(54));
  console.log('  OVERALL'.padEnd(14) + String(Object.values(K.moments).reduce((n, m) => n + m.happened, 0)).padStart(10) +
              String(A).padStart(13) + String(S).padStart(11) + pct(S, A).padStart(8));
  // Split by CHANNEL, because the two say different things: an answer the index
  // volunteered is adoption we engineered, a tool the agent chose is adoption we
  // were granted. Reporting them as one total hid that the second is near zero.
  console.log(`\n  answered on the agent's own search:      ${K.byAnswer}`);
  console.log(`  answered up front, from the prompt:      ${K.moments.prompt.served}`);
  // The usage mix, as Graft scores it per session (graft reads against source
  // reads): of the code searches the agent chose to run, how many went to a
  // lens tool. This is the adoption number; the rows above are delivery.
  const searched = K.moments.search.happened;
  const mix = K.lensChosen + searched;
  console.log(`\n  agent's own choice — lens tools: ${K.lensChosen} · grep/rg/read for code: ${searched}` +
              (mix ? `  (${(K.lensChosen / mix * 100).toFixed(1)}% lens)` : ''));
  if (K.byTool) console.log(`    of the lens calls, ${K.byTool} directly replaced a search on the same subject`);
  if (K.packsUnasked) console.log(`  packs on prompts that named no known code: ${K.packsUnasked} (not counted as served)`);
  if (K.nudged) console.log(`  prompts nudged instead of answered:      ${K.nudged}`);
  if (K.recentlyTold)
    console.log(`  held back — same answer given <30 min ago:  ${K.recentlyTold}` +
                `  (counted as a miss above; the memory working, not a gap)`);
  const why = Object.entries(K.why).sort((a, b) => b[1] - a[1]);
  if (why.length) {
    const total = why.reduce((n, [, v]) => n + v, 0);
    console.log(`\n  why the other ${total} went unanswered:`);
    for (const [k, v] of why)
      console.log(`    ${String(v).padStart(5)}  ${(v / total * 100).toFixed(0).padStart(3)}%  ${k}`);
  }
  if (K.misses.length)
    console.log(`\n  known but never spoken about: ${K.misses.map(([s, n]) => `${s}×${n}`).join(', ')}`);
  console.log('\n  This number belongs to THIS checkout. It moves with what its agents do all');
  console.log('  day and how complete its index is — comparing two repos compares their work.');
}
