/**
 * The engine contract.
 *
 * Both capability engines are EXTERNAL PROCESSES that code-lens supervises but
 * never reimplements. An adapter's whole job is to make one of them answer a
 * question in this shape. A third engine (an LSP for exact rename safety, or a
 * literal searcher) is a new adapter, never a fork of this file.
 */

export type EngineId = 'semantic' | 'graph';

/** A candidate location, before ranking. */
export interface Candidate {
  file: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
  /** 0..1 similarity, present only when a recall engine proposed this. */
  relevance?: number;
  /** Free-text snippet or summary, kept short — the budget is enforced later. */
  preview?: string;
  source: EngineId;
  /**
   * The user named this symbol themselves (`breaks`/`spots`), so it is a real
   * anchor to expand — unlike a graph-SEEDED candidate, which is an execution
   * flow and must never be handed to symbol context.
   */
  anchor?: boolean;
}

/** What the graph knows about a candidate: the consequence half of the answer. */
export interface Neighbourhood {
  /** Symbols that call into this one. */
  callers: string[];
  /** Symbols this one calls. */
  callees: string[];
  /** Named execution flows this symbol participates in. */
  flows: string[];
  /** Engine-reported risk class for changing it, if it offered one. */
  risk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface Health {
  id: EngineId;
  /** The engine answered a real probe — not merely "the binary exists". */
  up: boolean;
  version?: string;
  model?: string;
  device?: string;
  /** Resident GPU memory in MiB, when the engine's process could be identified. */
  gpuMiB?: number;
  /** Repos this engine has indexed. */
  repos: string[];
  /** Why it is not up, or why it is degraded. Never silently empty on failure. */
  detail?: string;
}

export interface Query {
  text: string;
  repo?: string;
  limit?: number;
  /**
   * Directory the question was asked FROM. Load-bearing for cwd-scoped engines:
   * the hot server is a long-lived process with its own working directory, so
   * without this it would run every caller's query in the server's directory
   * rather than the caller's repository.
   */
  cwd?: string;
}

/**
 * An engine implements the stages it can. A recall engine has `seed`; a
 * structural engine has `expand`. Nothing is required to implement both —
 * the router asks for what it needs and reports which stages were unavailable.
 */
export interface Engine {
  readonly id: EngineId;
  health(): Promise<Health>;
  seed?(q: Query): Promise<Candidate[]>;
  expand?(c: Candidate[], repo?: string): Promise<Map<string, Neighbourhood>>;
  /** Every capability the engine exposes, for the parity check. */
  capabilities(): Promise<string[]>;
  /** Mechanical 1:1 forwarding, so nothing this engine can do becomes unreachable. */
  passthrough(name: string, args: Record<string, unknown>): Promise<unknown>;
}
