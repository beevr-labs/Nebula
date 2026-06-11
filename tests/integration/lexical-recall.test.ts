import { describe, it, expect, afterEach } from 'vitest';
import { VectorStore, type ChunkRecord } from '../../src/lib/db/store';

// FR-RET-003 (the RECALL half) · REAL SurrealDB (@surrealdb/wasm, mem://).
// The exact-term lexical channel must surface a chunk the VECTOR ranking would never return —
// the "invoice ID / rare proper noun" case where the embedding is weakest but literal match is
// total. hybridRerank can't fix that (it only re-orders what vector returned); this channel
// retrieves independently of HNSW. Terms are what queryTerms() emits: lowercased, ≥3 chars,
// split on punctuation (so "ACME-9931" arrives as the terms "acme" and "9931").

const chunks: ChunkRecord[] = [
  {
    chunkId: 'sleep#0',
    docId: 'notes/sleep.md',
    text: 'melatonin regulates the circadian rhythm', // the query vector points HERE
    charStart: 0,
    charEnd: 40,
    embedding: [1, 0, 0]
  },
  {
    chunkId: 'inv#0',
    docId: 'invoices/2024.md',
    text: 'Invoice ACME-9931 paid in full', // exact-term target, embedding orthogonal to the query
    charStart: 0,
    charEnd: 30,
    embedding: [0, 1, 0]
  },
  {
    chunkId: 'spend#0',
    docId: 'notes/offsite.md',
    text: 'we spend the weekend offsite', // 'spend' must NOT match the term 'end' (whole-word filter)
    charStart: 0,
    charEnd: 28,
    embedding: [0, 0, 1]
  },
  {
    chunkId: 'vn#0',
    docId: 'notes/ngan-sach.md',
    text: 'ngân sách cho chuyến đi Kyoto', // Vietnamese proper-noun / diacritic case
    charStart: 0,
    charEnd: 29,
    embedding: [0.5, 0.5, 0]
  }
];

let store: VectorStore;
afterEach(async () => {
  await store?.close();
});

async function seeded(): Promise<VectorStore> {
  const s = new VectorStore();
  await s.connect('mem://', 3);
  await s.upsertChunks(chunks);
  return s;
}

describe('VectorStore.lexicalSearch — exact-term recall channel (FR-RET-003)', () => {
  it('finds a chunk by an exact term even when the query vector points elsewhere', async () => {
    store = await seeded();
    // Query vector aims at the sleep note; the literal terms aim at the invoice ID.
    const hits = await store.lexicalSearch([1, 0, 0], ['acme', '9931'], 8);
    expect(hits.map((h) => h.chunkId)).toContain('inv#0');
    expect(hits[0].chunkId).toBe('inv#0'); // two whole-word term hits → ranks first
  });

  it('applies a WHOLE-WORD filter — "end" does not match inside "spend"/"weekend"', async () => {
    store = await seeded();
    const hits = await store.lexicalSearch([0, 0, 1], ['end'], 8);
    expect(hits.map((h) => h.chunkId)).not.toContain('spend#0');
  });

  it('matches Vietnamese terms (unicode, diacritics preserved)', async () => {
    store = await seeded();
    const hits = await store.lexicalSearch([1, 0, 0], ['ngân', 'sách'], 8);
    expect(hits.map((h) => h.chunkId)).toContain('vn#0');
  });

  it('carries the cosine similarity as score, so hits display on the seed scale', async () => {
    store = await seeded();
    const [hit] = await store.lexicalSearch([0, 1, 0], ['acme', '9931'], 8);
    expect(hit.chunkId).toBe('inv#0');
    expect(hit.score).toBeGreaterThan(0.99); // query == inv#0's embedding direction
  });

  it('returns [] when no term is long enough to be distinctive (≥3 chars)', async () => {
    store = await seeded();
    expect(await store.lexicalSearch([1, 0, 0], ['ok', 'a'], 8)).toEqual([]);
  });

  it('returns [] when a term matches no chunk (recall channel is a clean no-op)', async () => {
    store = await seeded();
    expect(await store.lexicalSearch([1, 0, 0], ['globex'], 8)).toEqual([]);
  });
});
