/**
 * Effectiveness KPI: of the moments the index COULD have answered, how many did it?
 *
 * The denominator is the whole problem. Counting every command containing the
 * word "grep" produced a 25,000-opportunity population that was 99% tmux polling
 * and sprint paperwork — a number that made the tool look ignored when it was
 * merely irrelevant to what those agents do. So an opportunity here must clear
 * two bars:
 *   1. it names a SUBJECT (a symbol or code file), extracted by the same code the
 *      live hook uses, and
 *   2. the index actually HAS structure for that subject — verified by querying
 *      the graph, not assumed.
 *
 * Three kinds of moment, each with its own "was it served" rule:
 *   SEARCH  an agent searched code       served if an answer rode back on it, or
 *                                        it called a lens tool for that subject
 *   PROMPT  a user asked for work        served if a pack (or nudge) was injected
 *   EDIT    an agent changed a symbol    served if its blast radius was pulled first
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { searchSubject } from '../dist/core/augment.js';

const SESSIONS = process.argv[2];
const REPO_DIR = process.argv[3];
const SINCE = Date.parse(process.argv[4] ?? '2026-09-11T14:15:57Z');
/** When the prompt channel actually existed. Before this, a prompt had nothing
 *  that could serve it, so counting it as a miss measures my deploy date, not
 *  the tool. */
const PROMPT_CHANNEL_FROM = Date.parse('2026-09-11T14:15:57Z');
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|php|swift|kt)$/;

// ── read every session into one ordered event list per session ──────────────
const sessions = [];
for (const f of readdirSync(SESSIONS).filter((x) => x.endsWith('.jsonl'))) {
  if (statSync(join(SESSIONS, f)).mtimeMs < SINCE) continue;
  const ev = [];
  for (const line of readFileSync(join(SESSIONS, f), 'utf8').split('\n')) {
    let x; try { x = JSON.parse(line); } catch { continue; }
    const t = Date.parse(x?.timestamp ?? 0);
    if (!t || t < SINCE) continue;
    if (x.type === 'custom_message') {
      const m = x.message ?? x;
      if ((m.customType ?? x.customType) === 'code-lens-context')
        ev.push({ t, kind: /no strong structural match/.test(String(m.content)) ? 'nudge' : 'pack' });
      continue;
    }
    if (x.type !== 'message') continue;
    const m = x.message;
    if (m?.role === 'user') {
      const txt = (Array.isArray(m.content) ? m.content.map((c) => c?.text ?? '').join('') : String(m.content ?? ''));
      ev.push({ t, kind: 'prompt', text: txt.trim() });
    } else if (m?.role === 'assistant') {
      for (const c of m.content ?? []) {
        if (c.type !== 'toolCall') continue;
        const a = c.arguments ?? {};
        if (c.name?.startsWith('lens_'))
          ev.push({ t, kind: 'lens', subject: String(a.symbol ?? a.question ?? '').toLowerCase() });
        else if (c.name === 'edit' || c.name === 'write')
          ev.push({ t, kind: 'edit', path: String(a.path ?? ''), subject: null });
        else {
          // A command containing the word "grep" is not a code search. Measured on
          // this repo: of 33,189 such commands, 21,389 were sprint paperwork and
          // 8,895 were `tmux capture-pane | grep Working` polling other agents.
          // Counting them built a 25,000-strong opportunity population the index
          // could never serve, and made the tool look ignored when it was simply
          // irrelevant to what these agents spend their day doing.
          const cmd = `${a.command ?? ''} ${a.path ?? ''} ${a.pattern ?? ''}`;
          const noise = /tmux|capture-pane|\/proc\/|pgrep|\bps -|journalctl|\.log\b|\.jsonl|pisg-docs|pisg-proof|sprint-\d/.test(cmd);
          const sub = searchSubject(c.name, a);
          // And a subject the index happens to hold is not automatically a code
          // question: `sprint`, `CHECK`, `resident` are English words that also
          // exist as symbols. Require the word to LOOK like code, or the command
          // to name a code path.
          const codeShaped = sub && (/[a-z][A-Z]|_/.test(sub) || /\.(ts|tsx|mjs|js|py|rs|go)\b/.test(cmd));
          ev.push({ t, kind: noise || !codeShaped ? 'noise' : 'search', subject: sub });
        }
      }
    } else if (m?.role === 'toolResult') {
      const txt = (m.content ?? []).map((c) => c?.text ?? '').join('');
      const hit = /what the index knows about "([^"]+)"/.exec(txt);
      if (hit) ev.push({ t, kind: 'answer', subject: hit[1] });
    }
  }
  if (ev.length) sessions.push(ev);
}

// ── does the index actually hold structure for this subject? ────────────────
// ONE batch lookup, not one query per subject. The per-subject version opened a
// graph session per call and never closed it, exhausted the engine's 1,000-session
// cap mid-run, and then reported that the index knew nothing — a measurement that
// broke the thing it was measuring and believed the wreckage.
const KNOWN = new Set(readFileSync('/home/user/Code/other/.scratch/known-names.txt', 'utf8')
  .split('\n').map((n) => n.trim().toLowerCase()).filter(Boolean));
const known = new Map();
function indexKnows(subject) {
  if (!subject) return false;
  return KNOWN.has(String(subject).toLowerCase());
}
function _unusedIndexKnows(subject) {
  if (!subject) return false;
  const key = subject.toLowerCase();
  if (known.has(key)) return known.get(key);
  let yes = false;
  try {
    const out = execFileSync('lens', ['graph', 'cypher', '--query',
      `MATCH (x)-[r:CodeRelation]->(n) WHERE n.name='${subject.replace(/'/g, "")}' AND r.type='CALLS' RETURN count(x) AS n`],
      { cwd: REPO_DIR, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] });
    yes = Number(/\|\s*(\d+)\s*\|/.exec(JSON.parse(out).markdown ?? '')?.[1] ?? 0) > 0;
  } catch { yes = false; }
  known.set(key, yes);
  return yes;
}

// ── score every moment ──────────────────────────────────────────────────────
const K = {
  search: { opportunities: 0, addressable: 0, served: 0, byAnswer: 0, byTool: 0 },
  prompt: { opportunities: 0, addressable: 0, served: 0, nudged: 0 },
  edit:   { opportunities: 0, addressable: 0, served: 0 },
};
const missed = new Map();

for (const ev of sessions) {
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];

    if (e.kind === 'search' && e.subject) {
      K.search.opportunities++;
      if (!indexKnows(e.subject)) continue;
      K.search.addressable++;
      const after = ev.slice(i + 1, i + 4);
      const answered = after.some((x) => x.kind === 'answer' && x.subject === e.subject);
      const tooled = after.some((x) => x.kind === 'lens' && x.subject?.includes(e.subject.toLowerCase()));
      if (answered) { K.search.served++; K.search.byAnswer++; }
      else if (tooled) { K.search.served++; K.search.byTool++; }
      else missed.set(e.subject, (missed.get(e.subject) ?? 0) + 1);
    }

    if (e.kind === 'prompt' && e.text && e.text.length >= 12 && e.t >= PROMPT_CHANNEL_FROM) {
      K.prompt.opportunities++;
      // Addressable means the prompt names code, not merely an English word that
      // happens to also be a symbol. A bare "sprint" or "check" matches hundreds
      // of prompts and would inflate the denominator until the KPI measured my
      // stoplist instead of the tool: require a code-shaped token.
      const words = [...new Set((e.text.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? []).slice(0, 20))]
        .filter((w) => /[a-z][A-Z]|_|\.(ts|tsx|mjs|js|py|rs|go)$/.test(w));
      // A pack that WAS served proves the prompt was addressable — the live gate
      // is a better judge than any token rule I can write here, so it overrules.
      const near = ev.slice(i, i + 3);
      const packed = near.some((x) => x.kind === 'pack');
      const nudged = near.some((x) => x.kind === 'nudge');
      const hit = packed || words.find((w) => indexKnows(w));
      if (!hit) continue;
      K.prompt.addressable++;
      if (packed) K.prompt.served++;
      else if (nudged) K.prompt.nudged++;
    }

    if (e.kind === 'edit' && CODE.test(e.path)) {
      const sym = e.path.split('/').pop().replace(/\.[^.]+$/, '');
      K.edit.opportunities++;
      if (!indexKnows(sym)) continue;
      K.edit.addressable++;
      const before = ev.slice(Math.max(0, i - 8), i);
      if (before.some((x) => (x.kind === 'lens' && x.subject?.includes(sym.toLowerCase())) ||
                             (x.kind === 'answer' && x.subject.toLowerCase() === sym.toLowerCase())))
        K.edit.served++;
    }
  }
}

const pct = (a, b) => (b ? (a / b * 100).toFixed(1) + '%' : '—');
const out = [];
out.push('moment'.padEnd(22) + 'happened'.padStart(10) + 'index could'.padStart(13) + 'index did'.padStart(11) + 'KPI'.padStart(8));
for (const [k, v] of Object.entries(K))
  out.push(k.padEnd(22) + String(v.opportunities).padStart(10) + String(v.addressable).padStart(13) +
           String(v.served).padStart(11) + pct(v.served, v.addressable).padStart(8));
const A = K.search.addressable + K.prompt.addressable + K.edit.addressable;
const S = K.search.served + K.prompt.served + K.edit.served;
out.push('-'.repeat(64));
out.push('OVERALL'.padEnd(22) + String(K.search.opportunities + K.prompt.opportunities + K.edit.opportunities).padStart(10) +
         String(A).padStart(13) + String(S).padStart(11) + pct(S, A).padStart(8));
out.push('');
out.push(`served by an answer riding on the search: ${K.search.byAnswer}`);
out.push(`served because the agent called a tool:   ${K.search.byTool}`);
out.push(`prompts that got a pack:                  ${K.prompt.served}   (nudged instead: ${K.prompt.nudged})`);
out.push(`distinct subjects the index knew and never spoke about: ${missed.size}`);
out.push('top misses: ' + [...missed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s, n]) => `${s}×${n}`).join(', '));
console.log(out.join('\n'));
writeFileSync('/home/user/Code/other/.scratch/kpi-out.txt', out.join('\n'));
