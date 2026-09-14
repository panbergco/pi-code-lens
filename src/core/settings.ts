/**
 * The few knobs a person may want to keep.
 *
 * Deliberately small. Caps and timeouts here were derived from measurement, not
 * taste, so they are recorded as defaults rather than offered as preferences —
 * but a decision a human makes ("stop appending to my searches") must outlive
 * the session that made it, or they have to make it again every restart.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Settings {
  /** Answer searches automatically. */
  augment: boolean;
  /** Subjects looked up per search. */
  maxSubjects: number;
  /** Total tokens an appended answer may occupy, across all subjects. */
  budgetTokens: number;
  /** A search must never wait longer than this on the index. Paid by the AGENT,
   *  mid-turn, which is why it can afford to be seconds. */
  timeoutMs: number;
  /** Ceiling on the whole prompt hook — paid by a PERSON, between pressing enter
   *  and the turn starting, watching a still terminal.
   *
   *  It is a different budget from `timeoutMs` because it is a different payer,
   *  and conflating them cost an operator 4.7 s per submit and 51.9 s on the
   *  first. 400 ms is under the threshold where a wait reads as the tool being
   *  broken; past it the turn simply starts without a pack, and the next prompt
   *  gets one. */
  hookBudgetMs: number;
  /** How long an answer stays "already said". Sessions here run for days, so
   *  never repeating is wrong: the answer leaves the reader's context long
   *  before the session ends. */
  repeatAfterMinutes: number;
}

export const DEFAULTS: Settings = {
  augment: true,
  maxSubjects: 3,
  budgetTokens: 220,
  timeoutMs: 6_000,
  hookBudgetMs: 400,
  repeatAfterMinutes: 30,
};

export const SETTINGS_PATH = join(homedir(), '.code-lens', 'settings.json');

/** Merge a saved file over the defaults, ignoring anything unrecognised or absurd. */
export function loadSettings(path = SETTINGS_PATH): Settings {
  let saved: Partial<Settings> = {};
  try { saved = JSON.parse(readFileSync(path, 'utf8')); } catch { /* first run, or hand-edited into invalid JSON */ }
  return {
    augment: typeof saved.augment === 'boolean' ? saved.augment : DEFAULTS.augment,
    maxSubjects: clamp(saved.maxSubjects, 1, 5, DEFAULTS.maxSubjects),
    budgetTokens: clamp(saved.budgetTokens, 60, 1_200, DEFAULTS.budgetTokens),
    timeoutMs: clamp(saved.timeoutMs, 500, 30_000, DEFAULTS.timeoutMs),
    // Hard ceiling of 2 s even when hand-edited: this budget is somebody's
    // attention, and no answer is worth making a person wait longer than that
    // for something they did not ask for.
    hookBudgetMs: clamp(saved.hookBudgetMs, 50, 2_000, DEFAULTS.hookBudgetMs),
    repeatAfterMinutes: clamp(saved.repeatAfterMinutes, 0, 24 * 60, DEFAULTS.repeatAfterMinutes),
  };
}

/** Persist. Failure to save is not worth failing a session over. */
export function saveSettings(s: Settings, path = SETTINGS_PATH): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(s, null, 2) + '\n');
    return true;
  } catch { return false; }
}

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}
