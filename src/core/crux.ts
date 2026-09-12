/**
 * The few lines that actually carry the logic, lifted out of the file.
 *
 * A pointer is not an answer. Graft's whole pitch against plain code maps is
 * that "most code maps stop at an address: this thing lives in that file, on
 * that line. That tells an agent where to look, not what it will find, so it
 * still has to open the source" (trailhq/Graft, README). Measured here, that is
 * exactly what happens: answers land with `file:line` and callers, and the agent
 * opens the file anyway.
 *
 * Two deliberate choices, both theirs:
 *   - The TEXT is carried, never a line range. Line numbers drift whenever
 *     unrelated code above them shifts; the lines that matter do not.
 *   - It is small. This rides inside someone else's turn, so a crux that needs
 *     scrolling is a tax, not a gift.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** Lines of source carried with a spot. Beyond this it stops being a crux. */
export const CRUX_LINES = 6;

/** Never lift a line this long: minified or generated, and useless either way. */
const MAX_LINE = 160;

/**
 * The signature line at `line`, plus the few that follow, with blank lines and
 * comment-only lines dropped so the budget buys logic rather than prose.
 * Returns undefined when the file cannot be read or has nothing worth lifting —
 * silence beats a misleading excerpt.
 */
export function crux(file: string, line: number | undefined, cwd = process.cwd(),
                     maxLines = CRUX_LINES): string | undefined {
  if (!file || !line || line < 1) return undefined;
  let text: string;
  try { text = readFileSync(isAbsolute(file) ? file : join(cwd, file), 'utf8'); }
  catch { return undefined; }
  const all = text.split('\n');
  if (line > all.length) return undefined;          // the file moved on; say nothing

  const out: string[] = [];
  for (let i = line - 1; i < all.length && out.length < maxLines; i++) {
    const raw = all[i] ?? '';
    const trimmed = raw.trim();
    if (!trimmed) { if (out.length) break; continue; }           // stop at the first gap
    if (/^(\/\/|\/\*|\*|#)/.test(trimmed)) { if (out.length) continue; else continue; }
    if (raw.length > MAX_LINE) return undefined;                 // generated or minified
    out.push(raw.replace(/\s+$/, ''));
  }
  if (!out.length) return undefined;
  // Strip the shared indent so a deeply nested body does not spend the budget on
  // whitespace.
  const indent = Math.min(...out.map((l) => l.match(/^\s*/)![0].length));
  return out.map((l) => l.slice(indent)).join('\n');
}
