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
import { subjectsForSearch } from "../src/core/augment.js";
import { render } from "../src/core/fuse.js";
import { loadSettings, saveSettings, SETTINGS_PATH } from "../src/core/settings.js";
import { askViaServer, serverUp } from "../src/server/client.js";
import { refresh } from "../src/commands/refresh.js";
import { doctor } from "../src/commands/doctor.js";

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
const DEAD_END_TTL_MS = 10 * 60_000; // the index changes; a miss is not permanent
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
  pi.on("before_agent_start", async (event) => {
    const active = pi.getActiveTools();
    const tools = LENS_TOOLS.filter((t) => active.includes(t));
    if (!tools.length) return;
    if (ANNOUNCED_BY_PI.test(event.systemPrompt) || event.systemPrompt.includes(RULES_HEADING)) return;
    return {
      systemPrompt:
        `${event.systemPrompt}\n\n${RULES_HEADING} (${tools.join(", ")})\n` +
        "- Use lens_ask before grep/find for where code lives, how it works, or what to change.\n" +
        "- Use lens_breaks on a function, class or method before editing it.\n" +
        '- Use lens_graph with tool "detect_changes" before committing.\n' +
        "- Load the pi-code-lens skill for the full sequence.",
    };
  });

  // Staleness created in-session → refresh on the event, not the clock.
  // tool_result carries the input; only successful, history-moving git
  // commands arm the (debounced) trigger. The same hook answers searches.
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "bash" && !event.isError) {
      const cmd = String((event.input as { command?: string })?.command ?? "");
      if (GIT_MUTATION_RE.test(cmd)) scheduleRefresh(ctx, "git history moved");
    }
    return await enrichSearch(event, ctx);
  });

  /** Why a search was or was not answered. Set LENS_AUGMENT_DEBUG to a path.
   *  Silence is this feature's normal state, so it must be explainable. */
  const trace = (...parts: unknown[]) => {
    const path = process.env.LENS_AUGMENT_DEBUG;
    if (!path) return;
    try { appendFileSync(path, `${new Date().toISOString()} ${parts.join(" ")}\n`); } catch { /* debug only */ }
  };

  /** Answer the search the agent just ran, or say nothing at all. */
  async function enrichSearch(event: any, ctx: ExtensionContext): Promise<{ content: unknown[] } | undefined> {
    if (!settings.augment || event.isError) return;
    if (!Array.isArray(event.content) || !event.content.length) return;
    if (freshness(ctx.cwd).state === "unindexed") return;  // nothing to answer with

    const input = (event.input ?? {}) as Record<string, unknown>;
    const text = event.content.map((c: { text?: string }) => c.text ?? "").join("\n");
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
    const body = found
      .map((f) => `[code-lens — what the index knows about "${f.subject}"]\n${f.body}`)
      .join("\n\n");
    return {
      content: [...event.content, { type: "text" as const, text: `\n\n---\n${body}\n---` }],
    };
  }

  /** One routed answer, bounded in both time and tokens. Failure is silence. */
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
      if (!result) { trace("timeout/none", subject); unanswerable.set(key, Date.now()); return undefined; }
      trace("answer", subject, `${result.ms}ms`, `${result.spots.length} spots`,
        JSON.stringify(result.spots[0]?.signals ?? []));

      // Only speak when the index says something the search could not. The agent
      // already has the text matches, so a purely textual answer is worthless
      // here — and so is a bare risk label, which is a verdict without the
      // evidence behind it. Callers and flows are the knowledge grep cannot get.
      const structural = result.spots.filter((s) =>
        s.signals.some((sig) => /caller|flow/i.test(sig)) || s.breaks.length > 0);
      if (!structural.length) { unanswerable.set(key, Date.now()); return undefined; }

      answered.set(key, Date.now());
      return { subject, body: render(structural, budgetTokens) };
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
