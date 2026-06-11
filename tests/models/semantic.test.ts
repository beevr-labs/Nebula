import { describe, it, expect } from 'vitest';
import { chunk } from '../../src/lib/ingest/chunker';
import { embed, embedBatch, makeBgeTokenCounter } from '../../src/lib/embed/embedder';
import { vectorSearch, type IndexedChunk } from '../../src/lib/retrieval/search';

// REAL end-to-end semantic search on CPU: text → chunk (real embed-model tokenizer) →
// embed (real EMBEDDING_DIM vectors) → cosine retrieval. Proves FR-ING-003/004 + FR-RET-001 +
// the degraded-tier semantic promise (FR-CAP-002) without any GPU.

const doc = [
  'The Apollo project will ship to customers in the third quarter of next year.',
  'Our refund policy allows returns within thirty days of purchase.',
  'Photosynthesis converts sunlight into chemical energy in plants.',
  'The engineering team meets every Tuesday to review sprint progress.'
].join('\n\n');

describe('real pipeline — chunk → embed → retrieve', () => {
  it('retrieves the semantically correct chunk for a paraphrased query', async () => {
    const countTokens = await makeBgeTokenCounter();

    // Small chunks so each paragraph is its own retrieval unit; real tokenizer sizing.
    const chunks = chunk(doc, { size: 20, overlap: 4, countTokens });
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    const vectors = await embedBatch(chunks.map((c) => c.text));
    const index: IndexedChunk[] = chunks.map((c, i) => ({
      chunkId: `c${i}`,
      docId: 'doc.md',
      text: c.text,
      charStart: c.charStart,
      charEnd: c.charEnd,
      embedding: vectors[i]
    }));

    // Paraphrase — no shared keywords with "ship to customers in the third quarter".
    const query = await embed('When will the release reach users?');
    const hits = vectorSearch(query, index, { k: 1 });

    expect(hits).toHaveLength(1);
    expect(hits[0].text).toMatch(/Apollo project will ship/);
  });

  it('every chunk stays within the embedding window (real token sizing, ADR-006)', async () => {
    const countTokens = await makeBgeTokenCounter();
    const chunks = chunk(doc, { size: 20, overlap: 4, countTokens });
    for (const c of chunks) {
      expect(countTokens(c.text)).toBeLessThan(512); // never silently truncated
    }
  });
});
