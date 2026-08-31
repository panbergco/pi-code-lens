import assert from 'node:assert/strict';
import { placement, replaceYamlSection } from '../dist/install/installer.js';

const original = `# keep me
embedding:
  provider: sentence-transformers
  model: old-model
  device: cpu
envs:
  TOKENIZERS_PARALLELISM: "false"
`;
const replacement = `embedding:
  provider: sentence-transformers
  model: Shuu12121/CodeSearch-ModernBERT-Crow-Plus
  device: cuda
  indexing_params: {}
  query_params:
    prompt_name: query`;
const result = replaceYamlSection(original, 'embedding', replacement);

assert.match(result, /model: Shuu12121\/CodeSearch-ModernBERT-Crow-Plus/);
assert.match(result, /device: cuda/);
assert.doesNotMatch(result, /old-model|device: cpu/);
assert.match(result, /envs:\n  TOKENIZERS_PARALLELISM: "false"/);
assert.equal((result.match(/^embedding:$/gm) ?? []).length, 1);
assert.deepEqual(placement({}, 2), { graph: 0, semantic: 1 });
assert.deepEqual(placement({ gpu: 1 }, 2), { graph: 1, semantic: 1 });

console.log('ok — accelerator model config is replaced without deleting unrelated ccc settings');
