import { describe, it, expect, afterEach } from 'vitest';
import { VectorStore, type ChunkRecord } from '../../src/lib/db/store';
import { seedDocGraph, graphHash } from '../../src/lib/graph/ingest-graph';
import type { Extraction } from '../../src/lib/graph/entities';

// FR-GRAPH-001 — pre-built ("seeded") graph: a demo vault ships a ready-made knowledge graph so a
// first-run user sees entities + relations WITHOUT loading the chat model. seedDocGraph runs the same
// resolve + persist path as LLM extraction, but from a hand-authored Extraction. Real SurrealDB.

let store: VectorStore;
afterEach(async () => {
  await store?.close();
});

const KYOTO_TEXT = 'Priya booked a traditional ryokan called Sakura Inn in Kyoto.';
const BUDGET_TEXT = 'Maya already paid the Sakura Inn deposit of $150 for the group.';

const chunks: ChunkRecord[] = [
  {
    chunkId: 'kyoto#0',
    docId: 'trip/kyoto.md',
    text: KYOTO_TEXT,
    charStart: 0,
    charEnd: KYOTO_TEXT.length,
    embedding: [1, 0, 0]
  },
  {
    chunkId: 'budget#0',
    docId: 'trip/budget.md',
    text: BUDGET_TEXT,
    charStart: 0,
    charEnd: BUDGET_TEXT.length,
    embedding: [0, 1, 0]
  }
];

const KYOTO_EX: Extraction = {
  entities: [
    { name: 'Priya', type: 'person' },
    { name: 'Sakura Inn', type: 'org' },
    { name: 'Kyoto', type: 'place' }
  ],
  relations: [
    { source: 'Priya', target: 'Sakura Inn', type: 'booked', confidence: 0.95 },
    { source: 'Sakura Inn', target: 'Kyoto', type: 'located_in', confidence: 0.95 }
  ]
};
const BUDGET_EX: Extraction = {
  entities: [
    { name: 'Maya', type: 'person' },
    { name: 'Sakura Inn', type: 'org' }
  ],
  relations: [{ source: 'Maya', target: 'Sakura Inn', type: 'paid_deposit', confidence: 0.95 }]
};

describe('seedDocGraph — pre-built graph, no LLM', () => {
  it('persists entities, chunk-level mentions, and relations from an authored extraction', async () => {
    store = new VectorStore();
    await store.connect('mem://', 3);
    await store.upsertChunks([chunks[0]]); // chunks must exist first (mentions attach to them)

    const count = await seedDocGraph(store, 'trip/kyoto.md', KYOTO_TEXT, KYOTO_EX);
    expect(count).toBe(3);

    const entities = await store.allEntities();
    expect(entities.map((e) => e.id).sort()).toEqual(['kyoto', 'priya', 'sakura_inn']);

    // mentions attach only to chunks that NAME the entity (surface-form match)
    const sakuraNotes = await store.mentionsForEntity('sakura_inn');
    expect(sakuraNotes.map((m) => m.docId)).toEqual(['trip/kyoto.md']);

    const rels = await store.allRelations();
    expect(rels.map((r) => `${r.sourceId}-${r.type}-${r.targetId}`).sort()).toEqual([
      'priya-booked-sakura_inn',
      'sakura_inn-located_in-kyoto'
    ]);
  });

  it('records the content hash so the incremental guard SKIPS re-extraction', async () => {
    store = new VectorStore();
    await store.connect('mem://', 3);
    await store.upsertChunks([chunks[0]]);
    await seedDocGraph(store, 'trip/kyoto.md', KYOTO_TEXT, KYOTO_EX);
    expect(await store.getGraphHash('trip/kyoto.md')).toBe(graphHash(KYOTO_TEXT));
  });

  it('merges a shared entity across notes into ONE node that bridges them (the GraphRAG link)', async () => {
    store = new VectorStore();
    await store.connect('mem://', 3);
    await store.upsertChunks(chunks);
    await seedDocGraph(store, 'trip/kyoto.md', KYOTO_TEXT, KYOTO_EX);
    await seedDocGraph(store, 'trip/budget.md', BUDGET_TEXT, BUDGET_EX);

    // "Sakura Inn" is one node mentioned by BOTH notes → it links Kyoto ↔ budget.
    const sakuraNotes = (await store.mentionsForEntity('sakura_inn')).map((m) => m.docId).sort();
    expect(sakuraNotes).toEqual(['trip/budget.md', 'trip/kyoto.md']);
  });
});
