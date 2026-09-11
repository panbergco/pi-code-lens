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


// ── one engine's device policy must not travel to the other ─────────────────
// GitNexus runs its embeddings on the NPU, so the graph half is launched with
// CUDA_VISIBLE_DEVICES= (empty). That mask is inherited by every child, and an
// empty mask hides the GPU from PyTorch completely — so the first `ccc` that
// carries it starts a daemon which answers "No CUDA GPUs are available" for the
// rest of its life. Measured on this machine: recall was dead, and it surfaced
// as two 121-second timeouts in a real session with nothing naming the cause.
{
  const { cccEnv } = await import('../dist/engines/semantic.js');
  assert.equal('CUDA_VISIBLE_DEVICES' in cccEnv({ CUDA_VISIBLE_DEVICES: '', PATH: '/bin' }), false,
    'the graph engine\'s empty mask is stripped before reaching the semantic engine');
  assert.equal(cccEnv({ CUDA_VISIBLE_DEVICES: '0', PATH: '/bin' }).CUDA_VISIBLE_DEVICES, '0',
    'but a real device choice is somebody\'s decision, and is left alone');
  assert.equal(cccEnv({ PATH: '/bin' }).PATH, '/bin', 'and an unset mask changes nothing');
}
