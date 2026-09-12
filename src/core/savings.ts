/**
 * What this answer saved, against the only honest baseline: reading the files
 * it points at.
 *
 * Adapted from Graft's model (trailhq/Graft, MIT, `src/context/savings.ts`):
 * baseline minus this output, where the baseline is the size of the source the
 * agent would otherwise have opened whole. Two of their rules are kept because
 * both are about not lying:
 *
 *   - When no file in the baseline has a known size, the estimate is OMITTED
 *     rather than faked.
 *   - The saving is only claimed when it is positive. A block bigger than the
 *     file it describes saved nothing, and should say nothing.
 *
 * Why it exists at all: adoption was invisible here for weeks. Every number I
 * had came from reconstructing transcripts afterwards, which is slow and, four
 * times in one day, wrong. A footer on the answer makes the value visible to the
 * reader at the moment it is delivered, and gives the session something to
 * count.
 */
import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** Rough tokens for a byte length. 4 chars/token is close enough for an estimate. */
export const toTokens = (chars: number) => Math.round(chars / 4);

/**
 * Most a single file may contribute to the baseline.
 *
 * Nobody reads a 207KB file to learn who calls one function — they read a slice
 * of it. Measured without this cap, a two-line answer about `actuator.ts`
 * claimed "51,819 tokens saved (100%)", which is arithmetic nobody believes and
 * the kind of number that discredits the honest ones beside it. Cap the claim at
 * roughly what a real read pulls, and let it be boring.
 */
export const MAX_FILE_CHARS = 24_000;   // ~6k tokens, a large but plausible read

/**
 * Bytes of the distinct files this answer points at. Files that cannot be
 * measured are skipped, so an unreadable path yields a smaller baseline rather
 * than a wrong one.
 */
export function baselineChars(files: Iterable<string>, cwd = process.cwd()): { files: number; chars: number } {
  let chars = 0, n = 0;
  for (const f of new Set([...files].filter(Boolean))) {
    try {
      const s = statSync(isAbsolute(f) ? f : join(cwd, f));
      if (!s.isFile()) continue;
      chars += Math.min(s.size, MAX_FILE_CHARS); n++;
    } catch { /* unmeasurable: leave it out of the baseline */ }
  }
  return { files: n, chars };
}

/**
 * One line, or nothing at all. `body` is what the agent is being handed; the
 * baseline is what it would have read instead.
 */
export function savingsLine(body: string, files: Iterable<string>, cwd = process.cwd()): string | undefined {
  const base = baselineChars(files, cwd);
  if (!base.files || base.chars <= 0) return undefined;
  const baseTokens = toTokens(base.chars);
  const packTokens = toTokens(body.length);
  const saved = baseTokens - packTokens;
  if (saved <= 0) return undefined;
  const pct = Math.round((saved / baseTokens) * 100);
  return `[code-lens] ~${saved.toLocaleString()} tokens saved (${pct}%): this block is ~${packTokens.toLocaleString()} tok ` +
         `against ~${baseTokens.toLocaleString()} for opening ${base.files} file${base.files === 1 ? '' : 's'} whole.`;
}
