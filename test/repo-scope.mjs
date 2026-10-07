import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── a question answers from ITS repository, or from none — never another ─────
// Measured 2026-10-07: with one repository indexed, a question asked in an
// unindexed project came back with that one repository's files, because the
// folder-name guess named no repo and the engine fell back to its only index.
const root = mkdtempSync(join(tmpdir(), 'lens-scope-'));
const reg = join(root, 'registry.json');
for (const d of ['overstand/src/speech', 'overstand2', 'other']) mkdirSync(join(root, d), { recursive: true });
writeFileSync(reg, JSON.stringify([{ name: 'overstand', path: join(root, 'overstand') }]));
process.env.GITNEXUS_REGISTRY = reg;
const { repoForDir, GraphEngine } = await import('../dist/engines/graph.js');

assert.equal(repoForDir(join(root, 'overstand'), reg), 'overstand');
assert.equal(repoForDir(join(root, 'overstand/src/speech'), reg), 'overstand', 'a subfolder is still its repository');
assert.equal(repoForDir(join(root, 'other'), reg), undefined, 'an unindexed project belongs to no repository');
assert.equal(repoForDir(join(root, 'overstand2'), reg), undefined, 'a name prefix is not a path');
assert.equal(repoForDir(root, join(root, 'missing.json')), undefined, 'no registry, no guess');

// The guard is in front of the network: no server is running here.
const g = new GraphEngine('http://127.0.0.1:9/mcp');
await assert.rejects(g.passthrough('query', { search_query: 'x' }), /not inside an indexed repository/,
  'an unnamed call is refused, not answered from whichever repository the engine holds');
console.log('ok — every question is scoped to the repository it was asked in, or to none');
