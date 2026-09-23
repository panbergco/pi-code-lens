/**
 * pi-code-lens — code-lens as a NATIVE pi extension.
 *
 * Pi first principles, applied:
 *
 *  - No MCP. Pi deliberately ships without an MCP client; the pi-native way is
 *    `pi.registerTool()`. This file registers the same four-tool surface the
 *    MCP server exposes (`lens_ask`, `lens_breaks`, `lens_graph`,
 *    `lens_semantic`) as first-class tools with typebox schemas, prompt
 *    snippets and custom rendering. Four tools, not twenty-six — an agent
 *    asked to choose between a similarity engine and a graph engine chooses
 *    badly, so `lens_ask` takes the question and decides.
 *
 *  - No build step. Pi loads extensions through jiti, which resolves the
 *    `.js`-suffixed TypeScript imports below straight from `src/`. The CLI
 *    still compiles to `dist/`; the extension never needs it.
 *
 *  - CLIENT ONLY — this extension never boots, installs or supervises an
 *    engine. The engines are long-lived external services (typically already
 *    running and shared with other harnesses). `lens_ask` prefers the hot
 *    server (`LENS_PORT`, default 3939) and falls back to the in-process
 *    pipeline, whose engine adapters are themselves thin clients: graph over
 *    MCP-HTTP (:3737), semantic via the `ccc` CLI against its daemon. If
 *    nothing is running, tools degrade with named notes — same contract as
 *    the CLI. Start/repair services with `lens install --hot-load`, never
 *    from here.
 *
 *  - Lazy, session-scoped state. Engine clients are created on first use with
 *    the session's cwd (per pi guidance: no background resources at extension
 *    load), and dropped on session shutdown.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  formatSize,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { ask, createEngines, type Engines } from "../src/core/ask.js";
import { foundNothing, subjectsForSearch, symbolFromPath } from "../src/core/augment.js";
import { crux } from "../src/core/crux.js";
import { savingsLine } from "../src/core/savings.js";
import { render } from "../src/core/fuse.js";
import { loadSettings, saveSettings, SETTINGS_PATH } from "../src/core/settings.js";
import { askViaServer, serverUp } from "../src/server/client.js";
import { graphRebuildingHere, refresh } from "../src/commands/refresh.js";
import { GraphEngine } from "../src/engines/graph.js";
import { doctor } from "../src/commands/doctor.js";
import { kpi } from "../src/commands/kpi.js";

// ─── Index freshness — event-driven, pi-native ───────────────────────────────
//
// Insights adopted from the extensions that already solved index lifecycle
// natively (studied: gitnexus-opencode 0.5.3, pi-gitnexus 0.6.4,
// @pi-unipi/cocoindex 2.2.0):
//
//   1. STALENESS IS A COMMIT COMPARISON, not a clock. `.gitnexus/meta.json`
//      records `lastCommit`; the index is stale exactly when HEAD differs.
//      (gitnexus-opencode's staleness.js — cheap, exact, no daemon.)
//   2. REFRESH ON THE EVENT THAT CAUSES STALENESS. Only history-moving git
//      commands (commit/merge/rebase/pull/cherry-pick/switch/reset) change
//      what the engines index — so watch the bash tool for exactly those and
//      debounce a background refresh. (gitnexus-opencode's autoRefreshOnCommit.)
//      Plain edit/write events are deliberately NOT triggers: both engine
//      stages key on the commit, so refreshing then is a guaranteed no-op.
//   3. CHECK ON SESSION START, FIX IN THE BACKGROUND, TELL THE AGENT.
//      (gitnexus-opencode's autoRefreshStale + freshness envelope.)
//
// The executor is NOT new machinery: triggers call the service's own
// `refresh({ repo })` — the same lock-protected, cost-aware path the systemd
// timer uses. Pi-native here means pi supplies the *trigger* (the moment
// staleness is created), while the shared service keeps supplying the
// *execution* (locking, cost policy, both engines). The 15-min timer remains
// as backstop for mutations made outside pi.

/** History-moving git invocations — adapted from gitnexus-opencode. */
const GIT_MUTATION_RE =
  /(?:^|[;&|]\s*)(?:\w+=\S+\s+)*git(?:\s+-C\s+\S+|\s+--\S+(?:=\S+)?)*\s+(commit|merge|rebase|pull|cherry-pick|switch|reset)\b/;

function gitHead(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return ""; }
}

function metaCommit(cwd: string): string | null {
  try {
    const p = join(cwd, ".gitnexus", "meta.json");
    if (!existsSync(p)) return null;
    return (JSON.parse(readFileSync(p, "utf8")).lastCommit as string) ?? null;
  } catch { return null; }
}

function commitsBehind(cwd: string, from: string): number {
  try {
    return Number(execFileSync("git", ["rev-list", "--count", `${from}..HEAD`], { cwd, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim()) || 0;
  } catch { return 0; }
}

type Freshness =
  | { state: "unindexed" }
  | { state: "fresh"; commit: string }
  | { state: "stale"; behind: number }
  | { state: "refreshing" };

let refreshing = false;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

function freshness(cwd: string): Freshness {
  if (refreshing) return { state: "refreshing" };
  const indexed = metaCommit(cwd);
  if (!indexed) return { state: "unindexed" };
  const head = gitHead(cwd);
  if (!head || head === indexed) return { state: "fresh", commit: indexed.slice(0, 7) };
  return { state: "stale", behind: commitsBehind(cwd, indexed) };
}

/** Run the service's lock-protected refresh in the background, with the
 *  extension's console kept quiet (refresh() narrates via console.log, which
 *  would corrupt the TUI). Cross-process safety is the refresh lock's job;
 *  this flag only stops pi stacking its own triggers. */
async function runRefresh(ctx: ExtensionContext, reason: string): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  const repo = ctx.cwd.split("/").pop() ?? "";
  ctx.ui.setStatus("lens", `⟳ lens reindex (${reason})`);
  try {
    await captureOutput(() => refresh({ repo }));
  } catch (e) {
    ctx.ui.notify(`lens refresh failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`, "warning");
  } finally {
    refreshing = false;
    ctx.ui.setStatus("lens", undefined);
  }
}

/** Run something that narrates through console.log and return what it printed.
 *  The shared commands are CLI-shaped; letting them write to the real console
 *  corrupts the TUI, and their output is exactly what a person asking by hand
 *  wants to see. */
async function captureOutput(fn: () => Promise<unknown> | unknown): Promise<string> {
  const logs: string[] = [];
  const orig = { log: console.log, error: console.error };
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  try { await fn(); } finally { console.log = orig.log; console.error = orig.error; }
  return logs.join("\n");
}

function scheduleRefresh(ctx: ExtensionContext, reason: string, delayMs = 15_000): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void runRefresh(ctx, reason);
  }, delayMs);
}

// ─── Session-scoped engine clients (lazy) ───────────────────────────────────

let engines: Engines | null = null;
let enginesCwd = "";

function getEngines(cwd: string): Engines {
  if (!engines || enginesCwd !== cwd) {
    engines = createEngines(cwd);
    enginesCwd = cwd;
  }
  return engines;
}

// ─── Output shaping ─────────────────────────────────────────────────────────

/** Pi first principle: tools MUST truncate; a tool that floods the context has
 *  spent the caller's budget on its own convenience. */
function bounded(s: string): string {
  const t = truncateHead(s, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!t.truncated) return t.content;
  return (
    t.content +
    `\n\n[lens output truncated: ${t.outputLines}/${t.totalLines} lines, ` +
    `${formatSize(t.outputBytes)}/${formatSize(t.totalBytes)} — narrow the question or pass a smaller budget]`
  );
}

function asText(out: unknown): string {
  return typeof out === "string" ? out : JSON.stringify(out, null, 2);
}

interface LensDetails {
  intent?: string;
  ms?: number;
  spots?: number;
  notes?: string[];
}

function resultOf(text: string, details: LensDetails = {}) {
  return { content: [{ type: "text" as const, text: bounded(text) }], details };
}

/** Run an ask: hot server first, in-process fallback — the SAME contract as
 *  the CLI, so pi and every other harness see identical answers from the one
 *  running service. */
async function runAsk(question: string, repo: string | undefined, cwd: string, budget: number) {
  const input = { question, repo, cwd };
  const r = (await askViaServer(input)) ?? (await ask(input, getEngines(cwd)));
  const body = r.spots.length ? render(r.spots, budget) : "no spots found";
  // Commit staleness is now stated by the shared pipeline, so every surface
  // carries it. What only this process knows is that IT is mid-refresh.
  if (refreshing) r.notes.push("index refresh in flight — results may lag the newest commits");
  const notes = r.notes.length ? `\n\n${r.notes.map((n) => `! ${n}`).join("\n")}` : "";
  return {
    text: `intent: ${r.plan.intent} (${r.ms} ms)\n\n${body}${notes}`,
    details: { intent: r.plan.intent, ms: r.ms, spots: r.spots.length, notes: r.notes } as LensDetails,
  };
}

// ─── Extension ──────────────────────────────────────────────────────────────

const LENS_TOOLS = ["lens_ask", "lens_breaks", "lens_graph", "lens_semantic"];

// ─── Enrichment ──────────────────────────────────────────────────────────
//
// Announcement does not produce use. Pi's docs say a model "doesn't always"
// load a skill, and prompt guidelines are one bullet among many; measured in a
// live session that had all four tools announced, the skill loaded and the
// instruction in its prompt: 28 shell searches, zero index calls.
//
// So answer the search that was actually run. pi-gitnexus 0.6.4 (MIT) proved
// the shape for one engine; here BOTH engines answer, through the same routed
// pipeline the tools use — recall proposes, structure ranks — so a grep comes
// back carrying callers and risk without anyone choosing a tool.

/** Tuned by measurement, overridable by hand, remembered across sessions. */
let settings = loadSettings();
let augmentFires = 0;   // searches seen
let augmentHits = 0;    // searches actually enriched
/** The same ~4 chars/token estimate the renderer bills with. */
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/**
 * What has already been said, and when.
 *
 * These were permanent sets, which is wrong for a session that lives for days:
 * an answer given at 09:00 is long out of the model's context by 15:00, yet the
 * subject stayed marked as covered forever. `sprint` was searched 47 times in
 * six hours and could be answered once. So memory expires — quickly enough to
 * stay useful, slowly enough not to repeat itself in the same stretch of work.
 */
/**
 * One engine for this session, not one per question.
 *
 * Every `new GraphEngine()` opens a fresh MCP session against the graph server,
 * which costs ~200 ms and holds a live server object until it times out. Four
 * call sites constructed one each, so a single prompt pack paid that handshake
 * three times over and blew a 400 ms budget doing protocol, not work — and left
 * three sessions behind against a 1,000-session cap.
 */
let sharedGraph: GraphEngine | undefined;
const graphEngine = () => (sharedGraph ??= new GraphEngine());

const DEAD_END_TTL_MS = 10 * 60_000; // the index changes; a miss is not permanent
/**
 * A TIMEOUT is not a dead end.
 *
 * Both were filed in the same drawer, so one slow answer — a cold engine, a
 * rebuild in flight, a busy minute — muted that subject for ten minutes, long
 * after the index could have answered it instantly. Measured on a large monorepo:
 * 9.7% of all missed moments were subjects the index knew, asked again after a
 * single earlier failure, and met with silence. A transient failure earns a
 * pause, not a sentence.
 */
const SLOW_RETRY_MS = 45_000;
const answered = new Map<string, number>();
const unanswerable = new Map<string, number>();

/** A memory view valid at this instant, for the pure decision function. */
function recall() {
  const now = Date.now();
  const live = (m: Map<string, number>, ttl: number) => {
    for (const [k, t] of m) if (now - t > ttl) m.delete(k);
    return new Set(m.keys());
  };
  return {
    answered: live(answered, settings.repeatAfterMinutes * 60_000),
    unanswerable: live(unanswerable, DEAD_END_TTL_MS),
  };
}

/** `/lens <verb>` — what a person can run by hand, and what completion offers.
 *  Mirrors the CLI minus install/serve/mcp, which manage services and have no
 *  business running inside a chat session. */
const VERBS: Record<string, string> = {
  status: "engines, hot server, index freshness (the default)",
  ask: "ask a question and get ranked spots",
  breaks: "blast radius for a symbol",
  spots: "360° view of a known anchor",
  dupe: "does this already exist?",
  diff: "changed symbols against a base ref (default main)",
  graph: "graph tool by name, e.g. graph impact {\"target\":\"foo\"}",
  semantic: "semantic command by name, e.g. semantic status",
  caps: "every capability reachable through the lens",
  doctor: "engine health, residency and capability parity",
  kpi: "did THIS repo's agents get answered when they could have been?",
  refresh: "reindex this repository now",
  augment: "on|off — answer searches automatically (default on)",
};
const RULES_HEADING = "### pi-code-lens tool rules";
/** Pi's own "Available tools" line for this tool. Anchored, because a passing MENTION of
 *  lens_ask in an AGENTS.md is not the same as pi having announced the tool. */
const ANNOUNCED_BY_PI = /^- lens_ask: /m;

export default function piCodeLens(pi: ExtensionAPI) {
  // lens_ask — the routed fast path. The one agents should reach for first.
  pi.registerTool({
    name: "lens_ask",
    label: "Lens Ask",
    description:
      "Find the code that matters for a task, ranked by consequence. Routes the question, " +
      "searches semantically, expands through the call graph, and returns file:line spots with " +
      'why each matters and what breaks. USE THIS INSTEAD OF grep for "where is X", "why does Y ' +
      'fail", "what should I change".',
    promptSnippet: "Routed code search: semantic recall + call-graph ranking, one fused answer",
    promptGuidelines: [
      'Use lens_ask FIRST for "where is X handled", "how does Y work", "what should I change" — ' +
        "fall back to grep only for exact literal strings.",
      "Run lens_breaks on a symbol before editing it; the blast radius is the review.",
      "Load the pi-code-lens skill for the full locate → blast-radius → change-review sequence.",
      "Both lens engines index PER REPOSITORY, and answers only cover indexed repos. A '! no index' " +
        "or 'not indexed' note means the repo needs one-time indexing first — graph: run " +
        "`gitnexus analyze` in the repo; semantic: lens_semantic {command:'index'}. Check coverage with /lens. " +
        "Repo scope is resolved per call from cwd (or an explicit repo param) — concurrent use from other " +
        "agents/harnesses cannot change your scope.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "The question, in plain words." }),
      repo: Type.Optional(Type.String({ description: "Repository name. Defaults to the current one." })),
      budget: Type.Optional(Type.Number({ description: "Token ceiling for the answer (default 600)." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { text, details } = await runAsk(params.question, params.repo, ctx.cwd, params.budget ?? 600);
      return { ...resultOf(text, details) };
    },
    renderCall(args, theme) {
      let s = theme.fg("toolTitle", theme.bold("lens ask "));
      s += theme.fg("muted", `"${args.question ?? ""}"`);
      if (args.repo) s += theme.fg("dim", ` --repo ${args.repo}`);
      return new Text(s, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const d = (result.details ?? {}) as LensDetails;
      const raw = result.content?.[0]?.type === "text" ? result.content[0].text : "";
      if (expanded) return new Text(raw, 0, 0);
      const head =
        d.spots !== undefined
          ? `${d.spots} spot${d.spots === 1 ? "" : "s"} · ${d.intent ?? "?"} · ${d.ms ?? "?"} ms`
          : raw.split("\n")[0] ?? "";
      const warn = d.notes?.length ? theme.fg("warning", ` · ${d.notes.length} note(s)`) : "";
      return new Text(theme.fg("toolOutput", head) + warn, 0, 0);
    },
  });

  // lens_breaks — blast radius, no recall stage.
  pi.registerTool({
    name: "lens_breaks",
    label: "Lens Breaks",
    description:
      "Blast radius for a symbol: callers, execution flows and risk. RUN THIS BEFORE EDITING " +
      "any function, class or method.",
    promptSnippet: "Blast radius for a symbol before you edit it",
    promptGuidelines: [
      "Call lens_breaks on any function, class or method immediately before editing it; " +
        "its caller and flow list is the review that catches breakage.",
    ],
    parameters: Type.Object({
      symbol: Type.String({ description: "Function, class or method name." }),
      repo: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { text, details } = await runAsk(params.symbol, params.repo, ctx.cwd, 600);
      return { ...resultOf(text, details) };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("lens breaks ")) + theme.fg("muted", String(args.symbol ?? "")),
        0,
        0,
      );
    },
  });

  // lens_graph — passthrough so no graph capability is unreachable from pi.
  pi.registerTool({
    name: "lens_graph",
    label: "Lens Graph",
    description:
      "Passthrough to any knowledge-graph tool (impact, context, trace, detect_changes, cypher, " +
      "route_map, shape_check, api_impact, pdg_query, explain, rename, check, …).",
    promptSnippet: "Knowledge-graph operations by name: impact, context, trace, detect_changes, cypher",
    promptGuidelines: [
      'Run lens_graph with tool "detect_changes" before committing, to see which symbols and ' +
        "execution flows the change actually moved.",
    ],
    parameters: Type.Object({
      tool: Type.String({ description: "Graph tool name, e.g. impact, context, trace, cypher." }),
      args: Type.Optional(Type.Any({ description: "Arguments object for the tool." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const graph = getEngines(ctx.cwd).graph;
      // Default the repository from the session's cwd; an explicit arg still wins.
      // Without this, every call in a machine holding several indexes fails with
      // "Multiple repositories indexed" and the agent has to guess the retry.
      const out = await graph.passthrough(params.tool, {
        ...(await graph.repoArg(ctx.cwd)),
        ...((params.args as Record<string, unknown>) ?? {}),
      });
      return resultOf(asText(out));
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("lens graph ")) + theme.fg("muted", String(args.tool ?? "")),
        0,
        0,
      );
    },
  });

  // lens_semantic — passthrough to the semantic engine.
  pi.registerTool({
    name: "lens_semantic",
    label: "Lens Semantic",
    description:
      "Passthrough to the semantic engine (search, index, status, doctor, …). Its model is the " +
      "code-specialised one; use it for meaning-based recall over large corpora.",
    promptSnippet: "Semantic engine directly: search, index, status over the code-specialised model",
    promptGuidelines: [
      "When a lens answer reports no semantic index for the repository, run lens_semantic with " +
        'command "index" rather than falling back to a broad grep.',
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Semantic engine command, e.g. search, status." }),
      args: Type.Optional(Type.Any({ description: "Arguments object for the command." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const out = await getEngines(ctx.cwd).semantic.passthrough(
        params.command,
        (params.args as Record<string, unknown>) ?? {},
      );
      return resultOf(asText(out));
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("lens semantic ")) + theme.fg("muted", String(args.command ?? "")),
        0,
        0,
      );
    },
  });

  // /lens — the human surface. The tools above are for the model; a person needs to be
  // able to drive the same engines BY HAND, both to test that they answer at all and to
  // ask a quick question without spending a turn. So the CLI's read-only verbs are
  // reachable here, with completion, and the three service verbs (install, serve, mcp)
  // deliberately are not: a chat session must not spawn or supervise daemons.
  pi.registerCommand("lens", {
    description: "code-lens: status, or run a verb by hand (/lens ask …, breaks, diff, doctor …)",
    getArgumentCompletions: (prefix: string) => {
      // Only the FIRST word is a verb; after that the user is typing a question,
      // and suggesting verbs into the middle of a sentence is noise.
      if (/\s/.test(prefix)) return null;
      const items = Object.entries(VERBS)
        .filter(([verb]) => verb.startsWith(prefix))
        .map(([verb, description]) => ({ value: verb, label: verb, description }));
      return items.length ? items : null;
    },
    handler: async (args, ctx: ExtensionContext & { ui: any }) => {
      const [verb = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const text = rest.join(" ");
      const show = (body: string, level: "info" | "warning" | "error" = "info") =>
        ctx.ui.notify(bounded(body), level);

      try {
        switch (verb) {
          case "":
          case "status":
            return void (await status(ctx));
          case "ask":
          case "breaks":
          case "spots":
          case "dupe": {
            if (!text) return show(`/lens ${verb} needs an argument`, "warning");
            const q = verb === "dupe" ? `does this already exist: ${text}` : text;
            const { text: out } = await runAsk(q, undefined, ctx.cwd, 600);
            return show(out);
          }
          case "diff": {
            const graph = getEngines(ctx.cwd).graph;
            const out = await graph.passthrough("detect_changes", {
              ...(await graph.repoArg(ctx.cwd)),
              scope: "compare", base_ref: text || "main",
            });
            return show(asText(out));
          }
          case "graph":
          case "semantic": {
            const [name, ...tail] = rest;
            if (!name) return show(`/lens ${verb} needs a tool name`, "warning");
            // A raw JSON tail keeps every engine argument reachable without inventing
            // a second flag syntax that would drift from the CLI's.
            let params: Record<string, unknown> = {};
            if (tail.length) {
              try { params = JSON.parse(tail.join(" ")); }
              catch { return show(`arguments must be JSON, got: ${tail.join(" ")}`, "warning"); }
            }
            if (verb === "graph") {
              const graph = getEngines(ctx.cwd).graph;
              params = { ...(await graph.repoArg(ctx.cwd)), ...params };
              return show(asText(await graph.passthrough(name, params)));
            }
            return show(asText(await getEngines(ctx.cwd).semantic.passthrough(name, params)));
          }
          case "caps": {
            const e = getEngines(ctx.cwd);
            const [g, s] = await Promise.all([
              e.graph.capabilities().catch(() => [] as string[]),
              e.semantic.capabilities(),
            ]);
            return show(
              `graph (${g.length}): ${g.join(" ")}\n\nsemantic (${s.length}): ${s.join(" ")}\n\n` +
              `routed (5): ask spots breaks diff dupe\n\ntotal reachable: ${g.length + s.length + 5}`,
              g.length ? "info" : "warning",
            );
          }
          case "doctor":
            return show(await captureOutput(() => doctor({ parity: true })));
          case "kpi":
            // Always THIS checkout. The number is a property of the repo, not of
            // the tool: measured across four repos on one build it ran 0% to 97%,
            // moved entirely by what those agents spend the day doing.
            return show(await captureOutput(() => kpi({
              cwd: ctx.cwd,
              sinceHours: Number(text) || undefined,
            })));
          case "refresh":
            show("reindexing — the status line shows progress");
            return void runRefresh(ctx, "asked by hand");
          case "augment": {
            let saved = "";
            if (text === "on" || text === "off") {
              settings = { ...settings, augment: text === "on" };
              // A decision a person made must outlive the session that made it.
              saved = saveSettings(settings)
                ? `\nremembered in ${SETTINGS_PATH}`
                : `\ncould not write ${SETTINGS_PATH} — this session only`;
            }
            return show(
              `answering searches automatically: ${settings.augment ? "ON" : "OFF"}\n` +
              `this session: ${augmentHits} of ${augmentFires} searches answered from the index\n` +
              `caps: ${settings.maxSubjects} subjects, ${settings.budgetTokens} tokens, ` +
              `${settings.timeoutMs} ms${saved}`,
            );
          }
          default:
            return show(
              `unknown verb "${verb}". Available:\n` +
              Object.entries(VERBS).map(([v, d]) => `  ${v.padEnd(9)} ${d}`).join("\n"),
              "warning",
            );
        }
      } catch (e) {
        show(`/lens ${verb} failed: ${String((e as Error)?.message ?? e)}`, "error");
      }
    },
  });

  async function status(ctx: ExtensionContext & { ui: any }): Promise<void> {
    const hot = await serverUp();
    const g = await getEngines(ctx.cwd).graph.healthCached(0).catch(() => null);
    const here = ctx.cwd.split("/").pop() ?? "";
    const f = freshness(ctx.cwd);
    const fresh =
      f.state === "fresh" ? `indexed · up to date (${f.commit})`
      : f.state === "stale" ? `indexed · STALE — ${f.behind} commit${f.behind === 1 ? "" : "s"} behind (auto-refresh will catch up; or say the word)`
      : f.state === "refreshing" ? "reindexing now…"
      : "NOT graph-indexed — run `gitnexus analyze` here once; until then answers degrade with named notes";
    const lines = [
      `hot server (:${process.env.LENS_PORT ?? 3939}): ${hot ? "up — answers come from the shared warm service" : "down — falling back in-process (still thin clients)"}`,
      g
        ? `graph engine: ${g.up ? `up · repos: ${g.repos.join(", ") || "none indexed"}` : "unreachable"}`
        : "graph engine: unreachable",
      `this repo (${here}): ${fresh}`,
      "refresh: event-driven (git mutations in-session) + 15-min service timer as backstop",
      `searches answered automatically: ${settings.augment ? "on" : "off"} — ` +
        `${augmentHits} of ${augmentFires} this session ` +
        `(caps: ${settings.maxSubjects} subjects / ${settings.budgetTokens} tok / ${settings.timeoutMs} ms)`,
      "verbs: " + Object.keys(VERBS).join(" "),
    ];
    ctx.ui.notify(lines.join("\n"), hot && f.state !== "unindexed" ? "info" : "warning");
  }

  // Announcement of last resort. `promptSnippet`/`promptGuidelines` only reach the model
  // through pi's DEFAULT system prompt; a session started with --system-prompt (or a custom
  // template) replaces that prompt wholesale and the tools go silent — registered, callable,
  // and never mentioned. So re-state the rule per turn, and only when it is genuinely absent,
  // to avoid paying for the same instruction twice.
  pi.on("before_agent_start", async (event, ctx) => {
    const active = pi.getActiveTools();
    const tools = LENS_TOOLS.filter((t) => active.includes(t));
    if (!tools.length) return;

    // ── the push channel ────────────────────────────────────────────────────
    // Answer the PROMPT, before the agent acts on it. Until now this extension
    // only spoke after a search had already run, which requires the agent to
    // choose the slow path first — and measured over 26 days it chose the tools
    // itself 66 times in 77,029 calls. Graft (trailhq/Graft, MIT, src/claude/
    // hooks.ts:445) puts retrieval on the prompt hook for exactly this reason;
    // their own comment records the same finding from the other side: they
    // assumed a skipped pack was recoverable because "the agent pulls", traced a
    // session, and found it grepped 38 times instead.
    // ── ONE deadline, over everything, charged to the RIGHT person ───────────
    // This hook runs between the human pressing enter and the turn starting, so
    // every millisecond spent here is a millisecond a PERSON waits watching a
    // dead terminal. That was not true of the tool_result hook this grew out of,
    // where the same budget is paid by an agent mid-turn, and the placement
    // changed without the budget changing with it.
    //
    // Measured by the operator, same session and machine, extension by extension:
    //   pi-reverse only      128 ms
    //   pi-code-lens only    4,764 / 5,219 ms, and 51,898 ms on the first submit
    // With, during a 7,129 ms stall: 240 ms of CPU, 1 major fault, asleep in 103
    // of 107 samples. Not working — waiting, on a local engine that was
    // reindexing.
    //
    // So: one ceiling over the WHOLE hook, not a budget per lookup, and it is a
    // hard wall rather than a target. Past it the turn starts without us. A pack
    // is worth having; it is not worth four seconds of somebody's attention, and
    // an index too busy to answer in 400 ms will answer the next prompt instead.
    // Each piece races the SAME wall independently, and whatever arrived is
    // kept. Racing them together was worse than either: Promise.all resolves
    // only when both do, so a cold repo map — orientation, the least urgent
    // thing here — threw away a pack that had been ready in 120 ms. Measured:
    // the pack answers in 120-290 ms while the map's first call pays ~400 ms to
    // open its own engine session.
    const wall = Date.now() + settings.hookBudgetMs;
    const byWall = <T>(p: Promise<T>, what: string) => Promise.race([
      p,
      new Promise<undefined>((r) => setTimeout(() => {
        trace("hook deadline", `${what} missed ${settings.hookBudgetMs}ms — turn starts without it`);
        r(undefined);
      }, Math.max(1, wall - Date.now()))),
    ]);
    const [pack, map] = await Promise.all([
      byWall(promptPack(event.prompt, ctx.cwd), "pack"),
      byWall(repoMap(ctx.cwd), "repo map"),
    ]);

    const announced = ANNOUNCED_BY_PI.test(event.systemPrompt) || event.systemPrompt.includes(RULES_HEADING);
    const result: { systemPrompt?: string; message?: any } = {};
    if (!announced) {
      result.systemPrompt =
        `${event.systemPrompt}\n\n${RULES_HEADING} (${tools.join(", ")})\n` +
        "- Use lens_ask before grep/find for where code lives, how it works, or what to change.\n" +
        "- Use lens_breaks on a function, class or method before editing it.\n" +
        '- Use lens_graph with tool "detect_changes" before committing.\n' +
        // Call discipline, after Graft's directive (format.ts:219): the failure
        // mode of a retrieval tool is not being ignored, it is being called four
        // times with the question reworded.
        "- Pick the ONE lens tool that fits and act on its answer; most tasks need a single call. " +
        "Do not re-ask the same question reworded — switch tool or switch to reading the file.\n" +
        "- Load the pi-code-lens skill for the full sequence.";
    }
    // Orientation rides with the first pack of the session rather than as its own
    // message: a cold agent cannot search for what it does not know exists, and
    // this is the one thing no search can produce. Graft ships INDEX.md on every
    // SessionStart for the same reason (trailhq/Graft, src/claude/hooks.ts).
    const content = [map, pack].filter(Boolean).join("\n\n");
    if (content) {
      result.message = {
        customType: "code-lens-context",
        content,
        display: false,   // the model needs it; the human already has their own screen
      };
    }
    return Object.keys(result).length ? result : undefined;
  });

  // Staleness created in-session → refresh on the event, not the clock.
  // tool_result carries the input; only successful, history-moving git
  // commands arm the (debounced) trigger. The same hook answers searches.
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "bash" && !event.isError) {
      const cmd = String((event.input as { command?: string })?.command ?? "");
      if (GIT_MUTATION_RE.test(cmd)) scheduleRefresh(ctx, "git history moved");
    }
    const radius = await blastRadius(event, ctx);
    if (radius) return radius;
    return await enrichSearch(event, ctx);
  });

  /**
   * A symbol was just changed — say who depends on it, unasked.
   *
   * The weakest surface by measurement: on a large monorepo only 10% of edits to
   * an indexed symbol had its blast radius pulled first, because nothing ever
   * offered it. `tool_call` can only BLOCK a tool, and blocking an edit to teach
   * someone about callers is a worse trade than being slightly late — so this
   * speaks straight after the write, while the change is still the thing being
   * worked on and a sibling caller can still be fixed in the same breath.
   * (Same placement as Graft's post-edit hook, trailhq/Graft src/claude/hooks.ts.)
   *
   * Silent unless the graph actually knows dependents, and once per file per
   * repeat window — an edit loop must not narrate the same callers every save.
   */
  async function blastRadius(event: any, ctx: ExtensionContext): Promise<{ content: unknown[] } | undefined> {
    if (!settings.augment || event.isError) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const path = String((event.input as { path?: string })?.path ?? "");
    // Same rule as a search subject: a code file, and a name worth asking about.
    const symbol = symbolFromPath(path);
    if (!symbol) return;
    if (freshness(ctx.cwd).state === "unindexed") return;
    if (recall().answered.has(symbol.toLowerCase())) return;

    // A file is not a symbol. `lane-mint.ts`, `dataset.ts`, `capture-control.mjs`
    // name FILES, and asking the caller graph about them returns nothing — which
    // is why this channel delivered zero while the graph held 7 importers for
    // dataset.ts and 8 for proof.ts. Ask about the symbol when the name is one,
    // and about the file otherwise.
    let answer = await answerFor(symbol, ctx.cwd, settings.timeoutMs, settings.budgetTokens);
    if (!answer) {
      const importers = await graphEngine().importersOf(symbol, undefined, 6);
      if (!importers.length) return;   // nothing depends on it: nothing to warn about
      answer = {
        subject: symbol,
        body: `imported by ${importers.length} file${importers.length === 1 ? "" : "s"}: ` +
              importers.map((f) => f.split("/").slice(-2).join("/")).join(", "),
        files: importers,
      };
      answered.set(symbol.toLowerCase(), Date.now());
    }
    augmentHits++;
    trace("blast radius", symbol);
    return {
      content: [...(event.content ?? []), {
        type: "text" as const,
        text: `\n\n---\n[code-lens — you just changed "${answer.subject}"; this depends on it]\n` +
              `${answer.body}\nCheck the callers above before moving on — patching one file and ` +
              `leaving its siblings is the classic miss.\n---`,
      }],
    };
  }

  /** Why a search was or was not answered. Set LENS_AUGMENT_DEBUG to a path.
   *  Silence is this feature's normal state, so it must be explainable. */
  const trace = (...parts: unknown[]) => {
    const path = process.env.LENS_AUGMENT_DEBUG;
    if (!path) return;
    try { appendFileSync(path, `${new Date().toISOString()} ${parts.join(" ")}\n`); } catch { /* debug only */ }
  };

  /** Answer the search the agent just ran, or say nothing at all. */
  async function enrichSearch(event: any, ctx: ExtensionContext): Promise<{ content: unknown[] } | undefined> {
    if (!settings.augment) return;
    if (!Array.isArray(event.content)) return;
    if (freshness(ctx.cwd).state === "unindexed") return;  // nothing to answer with

    const input = (event.input ?? {}) as Record<string, unknown>;
    const text = event.content.map((c: { text?: string }) => c.text ?? "").join("\n");
    // A search that found NOTHING is the moment this index is worth most: the
    // agent has learned nothing and is about to search again, usually with a
    // reworded pattern. Skipping errors and short output cost 2,933 of these in
    // 24 hours on one repo. A broken shell still gets silence — that is a fact
    // about the command, not about the code.
    const empty = foundNothing(text, Boolean(event.isError));
    if (event.isError && !empty) return;   // the command itself failed
    const subjects = subjectsForSearch(event.toolName, input, text,
      recall(), settings.maxSubjects);
    if (!subjects.length) return;

    augmentFires++;
    trace("search", event.toolName, JSON.stringify(String(input.command ?? input.pattern ?? input.path ?? "")).slice(0, 120));

    trace("subjects", subjects.join(","));
    // ONE AT A TIME, best subject first. Fanning three questions out in parallel
    // was measured at 6s+ timeouts for two of them while the same questions
    // answer in ~100ms alone: the graph engine serialises on its session, so
    // concurrency here buys nothing and costs the search its latency.
    //
    // Every subject that has something structural to say is kept — but the
    // TOKENS are the cap, not the count. Answers share one budget and the first
    // is the most consequential, so a second and third appear only while there
    // is room, and never at the cost of the first.
    const deadline = Date.now() + settings.timeoutMs;
    const found: { subject: string; body: string }[] = [];
    let left = settings.budgetTokens;
    for (const subject of subjects) {
      if (Date.now() >= deadline) { trace("time spent"); break; }
      if (left < 60) { trace("budget spent"); break; }   // too little room to say anything useful
      const answer = await answerFor(subject, ctx.cwd, deadline - Date.now(), left);
      if (!answer) continue;
      found.push(answer);
      left -= estimateTokens(answer.body);
    }
    if (!found.length) { trace("nothing structural to add"); return; }

    augmentHits++;
    trace("appended", found.map((f) => f.subject).join(","), `${settings.budgetTokens - left} tok`);
    // Two different facts, two different headings. "Your search found nothing,
    // here is where it lives" is worth more than the same block phrased as a
    // footnote, and it tells the agent not to reword the pattern and try again.
    const body = found
      .map((f) => (empty
        ? `[code-lens — that search found nothing; the index has "${f.subject}"]\n${f.body}`
        : `[code-lens — what the index knows about "${f.subject}"]\n${f.body}`))
      .join("\n\n");
    // What this saved, measured against opening those files whole. It makes the
    // value visible at the moment of delivery instead of reconstructing it from
    // transcripts days later — which is how adoption stayed invisible for weeks.
    const saved = savingsLine(body, found.flatMap((f) => f.files ?? []), ctx.cwd);
    return {
      content: [...event.content, {
        type: "text" as const,
        text: `\n\n---\n${body}${saved ? `\n${saved}` : ""}\n---`,
      }],
    };
  }

  /** One routed answer, bounded in both time and tokens. Failure is silence. */
  /** Commits behind HEAD past which a structural claim is not worth making.
   *  Roughly an hour of a busy repo's history. */
  const MAX_BEHIND = 30;

  // ── per-prompt retrieval, ported from Graft's prompt hook ────────────────────
  // (trailhq/Graft, MIT: src/claude/hooks.ts:445-462, src/claude/format.ts:150-209)

  /** Shorter than this is conversational — "yes", "go on", "thanks" — and no gate
   *  can judge it. Graft's own floor, hooks.ts:20. */
  const MIN_PROMPT_CHARS = 12;
  /** How many already-shown spots a session remembers, so the same pointer is
   *  never injected twice. Graft's cap, format.ts:155. */
  const INJECTED_CAP = 40;
  /** Nudges one session may spend when the index has nothing strong. A line that
   *  appears every turn stops being read. Graft's NUDGE_CAP, format.ts:161. */
  const NUDGE_CAP = 2;

  const injected = new Set<string>();
  let nudges = 0;

  /**
   * What to put in front of the agent for THIS prompt, or nothing.
   *
   * Pointers only, never inlined code: a per-prompt injection is fresh
   * full-price input on every turn, while what the agent pulls itself is paid
   * for once, when it is actually wanted (Graft, format.ts:108-114).
   */
  /** Sent once per session: what this repository's busiest code is. */
  let mapSent = false;
  async function repoMap(cwd: string): Promise<string | undefined> {
    if (mapSent || !settings.augment) return undefined;
    mapSent = true;   // set before the await: one attempt per session, success or not
    if (freshness(cwd).state === "unindexed") return undefined;
    try {
      // Bounded like everything else on this path. Unbounded, this ONE call was
      // the 51,898 ms first submit an operator measured: a cold engine takes as
      // long as it takes, and a repo map is the least urgent thing here — it is
      // orientation, not an answer to anything that was asked.
      const hubs = await Promise.race([
        graphEngine().hubs(undefined, 8),
        new Promise<never[]>((r) => setTimeout(() => r([]), Math.min(settings.hookBudgetMs, 1_000))),
      ]);
      if (!hubs.length) return undefined;
      trace("repo map", hubs.length);
      return `[code-lens — where the weight sits in ${cwd.split("/").pop()}]\n` +
        hubs.map((h) => `  ${h.name} — ${h.callers} callers`).join("\n") +
        `\nAsk lens_ask for anything you cannot place; lens_breaks before changing one of these.`;
    } catch { return undefined; }
  }

  async function promptPack(prompt: string, cwd: string): Promise<string | undefined> {
    if (!settings.augment) { trace("prompt: augment off"); return undefined; }
    const q = (prompt ?? "").trim();
    if (q.length < MIN_PROMPT_CHARS) { trace("prompt: too short", q); return undefined; }
    const state = freshness(cwd).state;
    if (state === "unindexed") { trace("prompt: unindexed", cwd); return undefined; }
    // Never queue behind a rebuild on a person's time. The stall an operator
    // measured was the engine REINDEXING: sockets to it opened a second into the
    // wait and stayed open, while this process used 240 ms of CPU across 7.1 s
    // and slept through 103 of 107 samples. It was not working; it was waiting,
    // in a hook where somebody is watching the cursor.
    // Skip only when the STRUCTURAL engine is rebuilding — that is the one this
    // hook waits on, and the one an operator caught holding sockets open for
    // seconds while this process slept. A semantic pass is a different program:
    // measured with `ccc index` genuinely running, the same questions answered
    // in 372 ms and 481 ms. Muting the channel for it would trade a real answer
    // for a saving nobody needed.
    //
    // And only a rebuild of THIS repository. A pass on any other repository
    // leaves this one's queries untouched (measured: 4 ms median while another
    // was rebuilt), yet the machine-wide check muted this channel whenever the
    // refresh walked its fifteen repositories — 73% of one sampled minute.
    //
    // LENS_TEST_NO_PASS lets a test state that nothing is indexing. Without it
    // this reads the real machine, so a suite running during a genuine rebuild
    // asserts against a tool that is correctly staying quiet — a red test
    // proving the feature works.
    if (!process.env.LENS_TEST_NO_PASS && graphRebuildingHere(cwd)) {
      trace("prompt: skipped", "this repository's graph is being rebuilt");
      return undefined;
    }
    try {
      const answer = await answerFor(q, cwd, settings.timeoutMs, settings.budgetTokens);
      if (!answer) {
        // Silence is not free. Graft measured the alternative: assuming the agent
        // would reach for the tool on its own, it grepped 38 times instead. Say
        // the one useful thing, twice per session, then stop.
        if (nudges >= NUDGE_CAP) return undefined;
        nudges++;
        // Name the call, not the news. Graft rewrote the same line after tracing
        // a session where a bare "no match" left the agent to grep 38 times:
        // a nudge that does not carry the command is just an apology.
        const asking = q.length > 90 ? `${q.slice(0, 90)}…` : q;
        return `[code-lens] nothing strong matched this prompt automatically — the index holds more ` +
               `than that probe found. Before grepping, run:\n` +
               `  lens_ask { question: "${asking.replace(/"/g, "'")}" }\n` +
               `and lens_breaks on any symbol you are about to change.`;
      }
      // Novelty: a spot already shown this session is not news, and re-injecting
      // it spends the reader's context to tell them something they have.
      const lines = answer.body.split("\n").filter((l) => !injected.has(l.trim()) || !/^\d+\./.test(l.trim()));
      const fresh = answer.body.split("\n").filter((l) => /^\s*\d+\./.test(l) && !injected.has(l.trim()));
      if (!fresh.length) return undefined;
      for (const l of fresh) {
        injected.add(l.trim());
        if (injected.size > INJECTED_CAP) injected.delete(injected.values().next().value as string);
      }
      return `[code-lens — what the index already knows about this task]\n${lines.join("\n")}\n` +
             `Follow a pointer with lens_ask or lens_breaks; do not grep for what is listed above.`;
    } catch { return undefined; }   // a pack is never worth failing a turn over
  }

  async function answerFor(subject: string, cwd: string, budgetMs = settings.timeoutMs, budgetTokens = settings.budgetTokens) {
    const key = subject.toLowerCase();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The bare subject on purpose, which routes to the structure lane and
      // answers about THAT symbol. Phrasing it as a question was tried and
      // measured worse: 11 spots, but the structural ones described other
      // symbols entirely — richer-looking and less true. Precision matters more
      // here than volume, because this text is spent on someone else's turn.
      const input = { question: subject, cwd };
      const result = await Promise.race([
        (async () => (await askViaServer(input)) ?? (await ask(input, getEngines(cwd))))(),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), Math.max(500, budgetMs)); }),
      ]);
      if (!result) {
        // Park it briefly, not for the full dead-end window: nothing was learned
        // about the index here, only about how busy it was this second.
        trace("timeout/none", subject);
        unanswerable.set(key, Date.now() - (DEAD_END_TTL_MS - SLOW_RETRY_MS));
        return undefined;
      }
      trace("answer", subject, `${result.ms}ms`, `${result.spots.length} spots`,
        JSON.stringify(result.spots[0]?.signals ?? []));

      // Only speak when the index says something the search could not. The agent
      // already has the text matches, so a purely textual answer is worthless
      // here — and so is a bare risk label, which is a verdict without the
      // evidence behind it. Callers and flows are the knowledge grep cannot get.
      const structural = result.spots.filter((s) =>
        s.signals.some((sig) => /caller|flow/i.test(sig)) || s.breaks.length > 0);
      if (!structural.length) {
        // A name with no callers may still be a FILE, and the graph knows what
        // imports it. A large share of what agents search for is module-shaped
        // — `actuator`, `file-lock`, `lane-bar` — and those met silence from an
        // index holding 1,671 import edges nobody asked about.
        //
        // INSIDE the deadline. This ran after the timeout race that was supposed
        // to bound it, so a subject the engine was slow about spent the whole
        // budget on the race and then waited again, unbounded, on this call —
        // measured as seconds of a person's time, in a hook that promised none.
        const importers = await Promise.race([
          graphEngine().importersOf(subject, undefined, 5),
          new Promise<string[]>((r) => setTimeout(() => r([]), Math.max(250, Math.min(budgetMs, 1_500)))),
        ]);
        if (importers.length) {
          answered.set(key, Date.now());
          return {
            subject,
            body: `imported by ${importers.length} file${importers.length === 1 ? '' : 's'}: ` +
                  importers.map((f) => f.split('/').slice(-2).join('/')).join(', '),
            files: importers,
          };
        }
        unanswerable.set(key, Date.now());
        return undefined;
      }

      // A caller list describes the commit it was built from. Far enough behind
      // and it describes a different codebase — and this block arrives in
      // someone else's turn wearing the same confident shape either way, which
      // is worse than silence: they already have the grep output, so saying
      // nothing costs them a fact, while saying something stale costs them a
      // wrong one. Measured on a large monorepo: 19-43 commits behind at all
      // times, because a 121s rebuild tripped the hourly cost deferral.
      const behind = Number(/structure is (\d+) commits? behind/.exec(result.notes.join(' '))?.[1] ?? 0);
      if (behind > MAX_BEHIND) {
        trace("stale", subject, `${behind} commits behind — suppressed`);
        return undefined;   // deliberately NOT memoised: the next refresh fixes it
      }

      answered.set(key, Date.now());
      // Carry the lines that do the work, not just the address. A pointer makes
      // the agent open the file; the crux often means it never has to.
      //
      // A bare-symbol question — which is what this path always asks — answers
      // with the SYMBOL in the file field and no line, so the crux and the
      // savings line both silently did nothing until the location was looked up.
      const top = structural[0]!;
      let file = top.file, line = top.line;
      if (!line || !file.includes("/")) {
        const at = await graphEngine().locate(top.symbol ?? subject);
        if (at) { file = at.file; line = at.line; }
      }
      const lifted = crux(file, line, cwd);
      const body = render(structural, budgetTokens) +
        (lifted ? `\n\n${file}:${line}\n\`\`\`\n${lifted}\n\`\`\`` : "");
      const files = [file, ...structural.map((s) => s.file)].filter((f) => f.includes("/"));
      return { subject, body, files };
    } catch (e) {
      trace("failed", subject, String((e as Error)?.message ?? e).slice(0, 120));
      unanswerable.set(key, Date.now());   // an engine that failed once will fail again this turn
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Staleness inherited from outside pi → detect at session start, fix in the
  // background. Deferred so startup never blocks on git probes.
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    setTimeout(() => {
      const f = freshness(ctx.cwd);
      if (f.state === "stale") void runRefresh(ctx, `${f.behind} commit${f.behind === 1 ? "" : "s"} behind`);
      // Open the graph session NOW, on nobody's clock. Measured: the answer
      // itself takes 80 ms, while the first call on a new session pays a
      // 2,756 ms handshake — so the entire prompt-hook budget was being spent on
      // protocol the first time anyone asked anything, which is exactly the
      // 51.9 s first submit an operator caught, and why every later pack still
      // missed a 400 ms wall. The cost is unavoidable; being charged for it at
      // the moment a person presses enter is not.
      void graphEngine().locate("main").catch(() => { /* warming only */ });
    }, 2_000);
  });

  // Session lifecycle: drop client handles so a /resume into another cwd
  // re-resolves scope. Nothing to kill — we own no processes.
  pi.on("session_shutdown", async () => {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = undefined; }
    engines = null;
    enginesCwd = "";
    answered.clear();
    unanswerable.clear();
    augmentFires = 0;
    augmentHits = 0;
    settings = loadSettings();   // a hand edit between sessions must take effect
  });
}
