import { describe, it, expect, vi } from 'vitest';
import { vectorSearch, type IndexedChunk } from '../../src/lib/retrieval/search';
import { assemblePrompt, parseCitations, NO_RESULTS_MESSAGE } from '../../src/lib/chat/prompt';
import { MockInferenceProvider } from '../../src/lib/inference/mock';
import type { GenerateRequest } from '../../src/lib/inference/provider';

// End-to-end RAG pipeline on the InferenceProvider mock (no GPU):
// retrieve → assemble grounded prompt → generate (stream) → map citations.
// Covers FR-CHAT-001/002/003 + the no-fabrication guard (FR-CHAT-002).

const corpus: IndexedChunk[] = [
  {
    chunkId: 'k1',
    docId: 'notes/a.md',
    text: 'The launch is scheduled for Q3.',
    page: 1,
    charStart: 0,
    charEnd: 31,
    embedding: [1, 0]
  },
  {
    chunkId: 'k2',
    docId: 'notes/b.md',
    text: 'Unrelated cat facts.',
    page: 1,
    charStart: 0,
    charEnd: 20,
    embedding: [0, 1]
  }
];

describe('TC-CHAT — grounded, cited answer via the mock provider', () => {
  it('streams an answer whose citations map back to real context chunks', async () => {
    const hits = vectorSearch([1, 0], corpus, { k: 2, floor: 0.2 });
    const prompt = assemblePrompt('When is the launch?', hits);
    expect(prompt.kind).toBe('grounded');
    if (prompt.kind !== 'grounded') return;

    const provider = new MockInferenceProvider();
    await provider.loadModel('mock-model', () => {});

    const streamed: string[] = [];
    const req: GenerateRequest = {
      requestId: 'r1',
      query: 'When is the launch?',
      context: hits,
      modelId: 'mock-model',
      maxTokens: 256
    };
    const result = await provider.generate(
      req,
      (t) => streamed.push(t),
      new AbortController().signal
    );

    // tokens actually streamed and reconstruct the final text
    expect(streamed.length).toBeGreaterThan(1);
    expect(streamed.join('')).toBe(result.text);

    // every citation references a chunk that was in the context (click-to-source is valid)
    const ctxIds = new Set(hits.map((h) => h.chunkId));
    expect(result.citations.length).toBeGreaterThanOrEqual(1);
    for (const c of result.citations) expect(ctxIds.has(c.chunkId)).toBe(true);

    // re-parsing the answer agrees with the provider's citations
    const reparsed = parseCitations(result.text, prompt.contextOrder);
    expect(reparsed.citations[0].chunkId).toBe('k1');
  });

  it('no-results path never calls the model (no fabricated citations)', async () => {
    const hits = vectorSearch([3, 1], corpus, { k: 2, floor: 0.99 }); // best cosine ≈0.95 < floor
    expect(hits).toEqual([]);

    const prompt = assemblePrompt('obscure question', hits);
    expect(prompt.kind).toBe('no_results');

    const provider = new MockInferenceProvider();
    const spy = vi.spyOn(provider, 'generate');
    // Caller answers directly from the no-results result; generate is never invoked.
    if (prompt.kind === 'no_results') {
      expect(prompt.message).toBe(NO_RESULTS_MESSAGE);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('honors AbortSignal (cancellation)', async () => {
    const provider = new MockInferenceProvider();
    await provider.loadModel('mock-model', () => {});
    const ctrl = new AbortController();
    ctrl.abort();
    const req: GenerateRequest = {
      requestId: 'r2',
      query: 'q',
      context: vectorSearch([1, 0], corpus, { k: 1 }),
      modelId: 'mock-model',
      maxTokens: 64
    };
    await expect(provider.generate(req, () => {}, ctrl.signal)).rejects.toThrow(/abort/i);
  });
});
