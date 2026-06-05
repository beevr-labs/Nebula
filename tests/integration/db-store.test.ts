import { describe, it, expect, afterEach } from 'vitest';
import { VectorStore, type ChunkRecord } from '../../src/lib/db/store';

// FR-ING-005 (HNSW index) + FR-RET-001 (top-K) + FR-DATA-002 (rebuildable cache).
// REAL SurrealDB (@surrealdb/wasm) running in-process via mem:// — no GPU, no network.

const fixtures: ChunkRecord[] = [
  {
    chunkId: 'a1',
    docId: 'arch',
    text: 'system architecture',
    charStart: 0,
    charEnd: 19,
    embedding: [1, 0, 0]
  },
  {
    chunkId: 'c1',
    docId: 'cats',
    text: 'cats and kittens',
    charStart: 0,
    charEnd: 16,
    embedding: [0, 1, 0]
  },
  {
    chunkId: 'f1',
    docId: 'fin',
    text: 'quarterly finance',
    charStart: 0,
    charEnd: 17,
    embedding: [0, 0, 1]
  }
];

let store: VectorStore;
afterEach(async () => {
  await store?.close();
});

describe('VectorStore — real HNSW cosine search', () => {
  it('upserts chunks and returns top-K by cosine similarity', async () => {
    store = new VectorStore();
    await store.connect('mem://', 3);
    await store.upsertChunks(fixtures);

    const hits = await store.search([0.9, 0.1, 0], 2);
    expect(hits).toHaveLength(2);
    expect(hits[0].docId).toBe('arch'); // closest to the query
    expect(hits[0].score).toBeGreaterThan(hits[1].score); // descending similarity
    expect(hits[0].score).toBeGreaterThan(0.9);
  });

  it('upsert is idempotent by chunkId (no duplicate rows on re-ingest)', async () => {
    store = new VectorStore();
    await store.connect('mem://', 3);
    await store.upsertChunks(fixtures);
    await store.upsertChunks(fixtures); // re-ingest same chunks
    expect(await store.count()).toBe(3);
  });

  it('deleteDoc removes a document’s chunks (rebuildable cache)', async () => {
    store = new VectorStore();
    await store.connect('mem://', 3);
    await store.upsertChunks(fixtures);
    await store.deleteDoc('cats');
    expect(await store.count()).toBe(2);
    const hits = await store.search([0, 1, 0], 3);
    expect(hits.map((h) => h.docId)).not.toContain('cats');
  });
});
