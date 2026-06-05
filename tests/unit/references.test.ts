import { describe, it, expect } from 'vitest';
import { dedupeByDoc, referencesFromHits, relevantHits } from '../../src/lib/retrieval/search';

// FR-RET-001 / FR-CHAT-002. Multi-doc breadth + the References list at the foot of an answer.

describe('dedupeByDoc', () => {
  it('keeps the best (first) hit per document, preserving rank order', () => {
    const hits = [
      { docId: 'notes/a.md', chunkId: 'notes/a.md#0', score: 0.9 },
      { docId: 'notes/a.md', chunkId: 'notes/a.md#1', score: 0.85 }, // same doc → dropped
      { docId: 'notes/b.md', chunkId: 'notes/b.md#0', score: 0.8 },
      { docId: 'notes/c.md', chunkId: 'notes/c.md#0', score: 0.7 }
    ];
    expect(dedupeByDoc(hits).map((h) => h.docId)).toEqual([
      'notes/a.md',
      'notes/b.md',
      'notes/c.md'
    ]);
  });

  it('caps the number of distinct docs', () => {
    const hits = [
      { docId: 'notes/a.md', chunkId: 'a#0' },
      { docId: 'notes/b.md', chunkId: 'b#0' },
      { docId: 'notes/c.md', chunkId: 'c#0' }
    ];
    expect(dedupeByDoc(hits, 2).map((h) => h.docId)).toEqual(['notes/a.md', 'notes/b.md']);
  });
});

describe('relevantHits', () => {
  // The exact screenshot case: a strong security hit + three low-score distractors.
  const hits = [
    { docId: 'notes/security.md', score: 0.83 },
    { docId: 'notes/apollo.md', score: 0.49 },
    { docId: 'notes/refunds.md', score: 0.38 },
    { docId: 'notes/cats.md', score: 0.31 }
  ];

  it('drops the low-score tail, keeping only genuinely relevant notes', () => {
    // cutoff = max(0.35, 0.83 × 0.6 = 0.498) = 0.498 → only security clears it.
    expect(relevantHits(hits).map((h) => h.docId)).toEqual(['notes/security.md']);
  });

  it('keeps several when they are all close to the top score', () => {
    const close = [
      { docId: 'a', score: 0.8 },
      { docId: 'b', score: 0.78 },
      { docId: 'c', score: 0.75 }
    ];
    expect(relevantHits(close).map((h) => h.docId)).toEqual(['a', 'b', 'c']);
  });

  it('returns [] when even the top hit is below the absolute floor (no-results guard)', () => {
    expect(relevantHits([{ docId: 'a', score: 0.2 }])).toEqual([]);
  });

  it('is empty on empty input', () => {
    expect(relevantHits([])).toEqual([]);
  });

  it('honors custom absolute/relative thresholds', () => {
    // cutoff = max(0.3, 0.83 × 0.4 = 0.332) = 0.332 → cats (0.31) drops, the rest clear it.
    expect(relevantHits(hits, { absolute: 0.3, relative: 0.4 }).map((h) => h.docId)).toEqual([
      'notes/security.md',
      'notes/apollo.md',
      'notes/refunds.md'
    ]);
  });
});

describe('referencesFromHits', () => {
  it('numbers the distinct source docs 1..n, aligned with inline [#n]', () => {
    const refs = referencesFromHits([
      { docId: 'notes/a.md', chunkId: 'notes/a.md#0' },
      { docId: 'notes/a.md', chunkId: 'notes/a.md#1' },
      { docId: 'notes/b.md', chunkId: 'notes/b.md#0' }
    ]);
    expect(refs).toEqual([
      { n: 1, docId: 'notes/a.md', chunkId: 'notes/a.md#0' },
      { n: 2, docId: 'notes/b.md', chunkId: 'notes/b.md#0' }
    ]);
  });
});
