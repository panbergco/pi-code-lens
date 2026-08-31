#!/usr/bin/env node
// Thin client. It must never load a model or boot an engine: the engines are
// long-lived services, and the whole latency argument for code-lens rests on
// this process doing as little as possible.
import { main } from '../dist/cli.js';

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`lens: ${err?.message ?? err}`);
    process.exit(1);
  });
