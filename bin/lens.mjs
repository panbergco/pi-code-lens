#!/usr/bin/env node
// Thin client. It must never load a model or boot an engine: the engines are
// long-lived services, and the whole latency argument for code-lens rests on
// this process doing as little as possible.
import { main } from '../dist/cli.js';
import { GraphEngine } from '../dist/engines/graph.js';
import { exitAfterFlush } from '../dist/core/exit.js';

// Hand every graph session back before exiting. The engine holds a live server
// per session and caps at 1,000; one command that opens one and walks away is
// invisible, a few hundred in a loop take the engine down for everybody with
// "Server at session capacity" — measured, and it looked exactly like a missing
// index. Bounded so goodbye can never become the slowest part of a command.
//
// And exit only once the answer has left the process: process.exit() alone
// discarded whatever a slow reader had not drained — 262,401 bytes arrived as
// 262,144, and in a controlled test as 8,192 of 300,000, three times of three.
const farewell = async (code) => {
  await Promise.race([GraphEngine.closeAll(), new Promise((r) => setTimeout(r, 2_000))]);
  await exitAfterFlush(code);
};

main(process.argv.slice(2))
  .then(farewell)
  .catch((err) => {
    console.error(`lens: ${err?.message ?? err}`);
    farewell(1);
  });
