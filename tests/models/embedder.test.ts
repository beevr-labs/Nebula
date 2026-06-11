import { describe, it, expect } from 'vitest';
import { embed, embedBatch, makeBgeTokenCounter } from '../../src/lib/embed/embedder';
import { EMBEDDING_DIM, EMBEDDING_MAX_TOKENS } from '../../src/lib/inference/provider';

// FR-ING-004 — REAL MiniLM-L12 multilingual embeddings on CPU (no GPU). Proves the degraded-tier
// semantic path (FR-CAP-002) actually runs headless, and that non-English (Vietnamese) retrieval
// works — the reason we use a multilingual embedder (ADR-021).

describe('embed — real EMBEDDING_DIM normalized vectors', () => {
  it('produces an EMBEDDING_DIM L2-normalized vector', async () => {
    const v = await embed('The launch is scheduled for Q3.');
    expect(v).toHaveLength(EMBEDDING_DIM);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 3); // normalized at write time (ALGORITHMS §2)
  });

  it('embeds a batch into N rows of EMBEDDING_DIM', async () => {
    const rows = await embedBatch(['alpha', 'beta', 'gamma']);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toHaveLength(EMBEDDING_DIM);
  });

  it('semantically similar text scores higher than unrelated text', async () => {
    const [q, near, far] = await embedBatch([
      'When does the product launch?',
      'The release date is set for the third quarter.',
      'Cats are small domesticated carnivores.'
    ]);
    const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
    expect(dot(q, near)).toBeGreaterThan(dot(q, far));
  });

  it('retrieves the right note for a VIETNAMESE query (multilingual, ADR-021)', async () => {
    // A Vietnamese question about the refund policy must rank the Vietnamese refund note over an
    // unrelated one — cross-lingual is also fine (query VI, could match EN). bge-small-en failed this.
    const [q, refund, cats] = await embedBatch([
      'Chính sách hoàn tiền của chúng ta là gì?',
      'Chính sách hoàn tiền cho phép khách trả hàng trong vòng ba mươi ngày.',
      'Mèo là loài động vật có vú nhỏ được thuần hóa.'
    ]);
    const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
    expect(dot(q, refund)).toBeGreaterThan(dot(q, cats));
  });
});

describe('makeBgeTokenCounter — the real tokenizer that closes R-1', () => {
  it('counts tokens and flags text past the embedding window (silent-truncation guard)', async () => {
    const count = await makeBgeTokenCounter();
    expect(count('The launch is scheduled for Q3.')).toBeGreaterThan(0);
    // Past the embed window → would truncate if chunked naively (the chunker uses THIS counter, ADR-006).
    const long = 'word '.repeat(EMBEDDING_MAX_TOKENS + 500);
    expect(count(long)).toBeGreaterThan(EMBEDDING_MAX_TOKENS);
  });
});
