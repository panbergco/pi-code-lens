/**
 * What is this search actually about?
 *
 * Adoption cannot be won by asking. Pi's own docs say a model "doesn't always"
 * load a skill, and prompt guidelines are advice competing with every other
 * bullet — measured here as 28 shell searches and zero index calls in one
 * session that had the tools, the skill and the instruction in front of it.
 *
 * So the lens stops waiting to be called and answers the search the agent
 * already ran. This module is the part that reads a search and says what it was
 * looking for; the extension turns that into a ranked answer from BOTH engines.
 *
 * The extraction rules are adapted from pi-gitnexus 0.6.4 (MIT), which solved
 * the same problem for a single engine.
 */
import { basename, extname } from 'node:path';

/** Reading a source file is a question about that file; reading a log is not. */
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.rb', '.php', '.swift', '.kt',
  '.scala', '.lua', '.dart', '.sh', '.sql', '.vue', '.svelte',
]);

/** Tools whose results are worth enriching. `bash` covers grep/rg/find/cat. */
export const SEARCH_TOOLS = new Set(['grep', 'find', 'bash', 'read']);

/**
 * Words that are never worth a lookup.
 *
 * Measured in a live session: of 37 enrichments, 33 were about words like
 * `function`, `scopes`, `project` and `SKILL` — a search for prose or a keyword,
 * answered with a meaningless self-reference. The structural gate hides those,
 * but only after paying for the query, so reject them at the door.
 */
const NOT_A_SUBJECT = new Set([
  // language keywords and universal type names
  'function', 'class', 'const', 'let', 'var', 'return', 'import', 'export', 'default',
  'async', 'await', 'interface', 'type', 'enum', 'extends', 'implements', 'public',
  'private', 'static', 'void', 'null', 'undefined', 'true', 'false', 'string', 'number',
  'boolean', 'object', 'array', 'promise', 'throw', 'catch', 'finally', 'switch', 'case',
  // shell and tooling nouns that show up in commands, not in code
  'grep', 'find', 'head', 'tail', 'sed', 'awk', 'cat', 'echo', 'node', 'npm', 'npx',
  'git', 'bash', 'test', 'tests', 'build', 'dist', 'temp', 'tmp', 'log', 'logs',
  // prose that survives tokenizing but names nothing
  'the', 'and', 'not', 'with', 'from', 'this', 'that', 'when', 'what', 'where', 'which',
  'name', 'names', 'value', 'values', 'data', 'text', 'file', 'files', 'path', 'paths',
  'line', 'lines', 'code', 'item', 'items', 'list', 'result', 'results', 'error', 'errors',
  'status', 'scope', 'scopes', 'project', 'index', 'main', 'config', 'options',
  'input', 'output', 'args', 'params', 'skill', 'skills', 'readme', 'docs',
  // words a search hits constantly in output rather than in code
  'pass', 'fail', 'failed', 'passed', 'working', 'done', 'todo', 'warning', 'debug',
]);

/**
 * Is this worth asking the index about?
 *
 * It used to guess from the SHAPE of the word: a bare lowercase word had to be
 * six characters before it counted as a name. That rule threw away the best
 * subjects in the repository. Measured over 1,154 real searches: `sprint`
 * (47 searches, 13 callers), `tick` (18, 15 callers), `store` (10, 62 callers),
 * `lanes`, `witness`, `declared` — every one of them refused at the door for
 * looking like prose, while the index knew exactly what they were.
 *
 * So the shape rule is gone. The index itself is the arbiter: it answers in
 * ~40 ms and its answer is a fact, where the heuristic was a guess. All that
 * remains here is the cheap, certain rejection — keywords, shell nouns and
 * English that no index will have a symbol for.
 */
export function isUsefulSubject(subject: string, _from: 'pattern' | 'path' = 'pattern'): boolean {
  if (subject.length < 4) return false;                      // too short to mean one thing
  if (NOT_A_SUBJECT.has(subject.toLowerCase())) return false;
  return !/^\d+$/.test(subject);
}

/**
 * The longest literal run in a regex — the part that carries meaning.
 * `handle(Inbox|Mail)Delivery` is a poor query; `Delivery` is a usable one.
 */
export function literalFromRegex(pattern: string): string | null {
  const runs = pattern.split(/[^A-Za-z0-9_$]+/).filter((s) => s.length >= 3);
  if (!runs.length) return null;
  return runs.reduce((a, b) => (b.length > a.length ? b : a));
}

/**
 * Split a shell command into tokens, respecting quotes, and mark the points
 * where one command ends and another begins. Without the boundary marker,
 * `ls | grep foo` reads the argument of `ls` as grep's pattern.
 */
export function tokenizeCommand(cmd: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  const flush = () => { if (current) { tokens.push(current); current = ''; } };

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote) {
      if (ch === quote) quote = null; else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '|' || ch === ';') {
      flush(); tokens.push('|');
      if (ch === '|' && cmd[i + 1] === '|') i++;
      continue;
    }
    if (ch === '&' && cmd[i + 1] === '&') { flush(); tokens.push('|'); i++; continue; }
    if (/\s/.test(ch)) flush(); else current += ch;
  }
  flush();
  return tokens;
}

/** A file path a person searched → the thing they were looking for. */
function symbolFromPath(path: string): string | null {
  if (!CODE_EXTENSIONS.has(extname(path))) return null;
  const name = basename(path).replace(/\.\w+$/, '');
  return isUsefulSubject(name, 'path') ? name : null;
}

/**
 * What was this tool call looking for? Returns null when the answer is "not
 * code" — a log tail, a two-character pattern, a directory listing — because a
 * useless enrichment costs context and teaches the agent to ignore the block.
 */
export function searchSubject(toolName: string, input: Record<string, unknown>): string | null {
  let subject: string | null = null;
  // `read`, `find` and file-reading shell commands name a path that exists;
  // `grep` names a guess. Only the guess has to prove it looks like code.
  let origin: 'pattern' | 'path' = 'pattern';

  if (toolName === 'grep') {
    const raw = typeof input.pattern === 'string' ? input.pattern : null;
    subject = raw ? literalFromRegex(raw) : null;
  } else if (toolName === 'find') {
    const raw = ['pattern', 'glob', 'path', 'name']
      .map((k) => (typeof input[k] === 'string' ? (input[k] as string) : null))
      .find(Boolean) ?? null;
    if (raw) { subject = basename(raw).replace(/\.\w+$/, '').replace(/[*?[\]{}]/g, '') || null; origin = 'path'; }
  } else if (toolName === 'read') {
    subject = typeof input.path === 'string' ? symbolFromPath(input.path) : null;
    origin = 'path';
  } else if (toolName === 'bash') {
    const found = subjectFromShell(typeof input.command === 'string' ? input.command : '');
    if (found) { subject = found.subject; origin = found.origin; }
  }

  return subject && isUsefulSubject(subject, origin) ? subject : null;
}

function subjectFromShell(command: string): { subject: string; origin: 'pattern' | 'path' } | null {
  const tokens = tokenizeCommand(command);
  let afterSearch = false;
  let afterFileCmd = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '|') { afterSearch = false; afterFileCmd = false; continue; }

    if (token === 'grep' || token === 'rg' || token === 'ag') {
      afterSearch = true; afterFileCmd = false; continue;
    }
    if (afterSearch) {
      if (token.startsWith('-')) continue;
      const literal = literalFromRegex(token);
      return literal ? { subject: literal, origin: 'pattern' } : null;
    }

    if (['cat', 'head', 'tail', 'less', 'sed', 'wc'].includes(token)) {
      afterFileCmd = true; continue;
    }
    if (afterFileCmd) {
      if (token.startsWith('-') || /^['"]?\d/.test(token)) continue;
      const named = symbolFromPath(token);
      if (named) return { subject: named, origin: 'path' };
      afterFileCmd = false;
      continue;
    }

    if ((token === '-name' || token === '-iname') && tokens[i + 1]) {
      const seg = basename(tokens[i + 1]!).replace(/\.\w+$/, '').replace(/[*?[\]{}]/g, '');
      return seg ? { subject: seg, origin: 'path' } : null;
    }
  }
  return null;
}

/**
 * Files the search actually hit, read back out of its output — the second half
 * of the question. A grep for "retry" that lands in `write-lane.ts` is really a
 * question about that file, and the graph knows what depends on it.
 */
/** Subjects already answered, and subjects the index had nothing for. */
export interface SubjectMemory { answered: Set<string>; unanswerable: Set<string> }

/** A search result too small to have found anything asks no question. */
export const MIN_OUTPUT_CHARS = 40;

/**
 * The whole decision: given a finished tool call, what should the index be
 * asked about? Pure, so the rules that decide when to spend someone's context
 * are testable without a running session — the part pi-gitnexus covers with ten
 * hook tests, and the part most likely to go quietly wrong.
 */
export function subjectsForSearch(
  toolName: string,
  input: Record<string, unknown>,
  outputText: string,
  memory: SubjectMemory,
  max = 3,
): string[] {
  if (!SEARCH_TOOLS.has(toolName)) return [];
  if (outputText.trim().length < MIN_OUTPUT_CHARS) return [];
  // Never answer the lens answering itself.
  if (/(^|\s|\/)lens(\.mjs)?\s/.test(String(input.command ?? ''))) return [];

  const primary = searchSubject(toolName, input);
  // Where a search LANDED is the other half of the question; a file that was
  // simply opened is not — its own name is already the subject.
  const secondary = toolName === 'read' ? [] : subjectsFromOutput(outputText, 2);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const subject of [primary, ...secondary]) {
    if (!subject) continue;
    const key = subject.toLowerCase();
    if (seen.has(key) || memory.answered.has(key) || memory.unanswerable.has(key)) continue;
    seen.add(key);
    out.push(subject);
    if (out.length >= max) break;
  }
  return out;
}

export function subjectsFromOutput(text: string, limit = 2): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^\s:]+\.\w+):\d+[:\-]/);
    if (!m) continue;
    const name = symbolFromPath(m[1]!);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}
