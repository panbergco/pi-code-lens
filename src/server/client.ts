/**
 * Server-first client.
 *
 * The CLI prefers the hot server and falls back to running in-process. The
 * fallback must stay silent and automatic: a tool that errors because a
 * background service is not running has made the user responsible for its own
 * optimisation.
 */
import type { AskInput, AskResult } from '../core/ask.js';

const PORT = Number(process.env.LENS_PORT ?? 3939);
const HOST = process.env.LENS_HOST ?? '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;

/** Returns null when the server is absent — the caller then works in-process. */
export async function askViaServer(input: AskInput): Promise<AskResult | null> {
  try {
    const res = await fetch(`${BASE}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as AskResult;
  } catch { return null; }
}

export async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1_500) });
    return res.ok;
  } catch { return false; }
}
