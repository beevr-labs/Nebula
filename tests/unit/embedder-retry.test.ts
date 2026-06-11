// A transient embed-model load failure (offline blip, storage quota, WebGPU hiccup) must NOT be
// cached forever. Before the fix, getEmbedder() memoized the REJECTED promise via `??=`, so one
// failed load wedged ALL indexing until a page reload — every later save reported "failed to index".
// These tests pin the self-heal: the memoized slot is dropped on failure so the next call retries.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted so the mock factory can reference these (vi.mock is hoisted above imports).
const { pipeline, fromPretrained } = vi.hoisted(() => ({
  pipeline: vi.fn(),
  fromPretrained: vi.fn()
}));

vi.mock('@huggingface/transformers', () => ({
  pipeline: (...a: unknown[]) => pipeline(...a),
  AutoTokenizer: { from_pretrained: (...a: unknown[]) => fromPretrained(...a) }
}));

describe('embedder self-heals after a failed load (no permanent poisoning)', () => {
  beforeEach(() => {
    vi.resetModules(); // fresh module-level extractorPromise/tokenizerPromise per test
    pipeline.mockReset();
    fromPretrained.mockReset();
  });

  it('getEmbedder retries after a transient failure instead of caching the rejection', async () => {
    const { getEmbedder } = await import('$lib/embed/embedder');
    pipeline.mockRejectedValueOnce(new Error('fetch failed')); // no WebGPU in Node → CPU path → this call
    await expect(getEmbedder()).rejects.toThrow('fetch failed');

    const fakeExtractor = (() => {}) as unknown;
    pipeline.mockResolvedValueOnce(fakeExtractor);
    await expect(getEmbedder()).resolves.toBe(fakeExtractor); // would still reject if the failure were cached

    expect(pipeline).toHaveBeenCalledTimes(2); // proves it actually retried
  });

  it('getTokenizer self-heals the same way', async () => {
    const { getTokenizer } = await import('$lib/embed/embedder');
    fromPretrained.mockRejectedValueOnce(new Error('network'));
    await expect(getTokenizer()).rejects.toThrow('network');

    const fakeTok = { encode: () => [] } as unknown;
    fromPretrained.mockResolvedValueOnce(fakeTok);
    await expect(getTokenizer()).resolves.toBe(fakeTok);

    expect(fromPretrained).toHaveBeenCalledTimes(2);
  });

  it('a successful load is still memoized (only ONE load for repeated calls)', async () => {
    const { getEmbedder } = await import('$lib/embed/embedder');
    const fakeExtractor = (() => {}) as unknown;
    pipeline.mockResolvedValue(fakeExtractor);
    const [a, b] = await Promise.all([getEmbedder(), getEmbedder()]);
    expect(a).toBe(fakeExtractor);
    expect(b).toBe(fakeExtractor);
    expect(pipeline).toHaveBeenCalledTimes(1); // success path is NOT re-run — self-heal only affects failures
  });
});
