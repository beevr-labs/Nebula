import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VectorStore, type ChunkRecord } from '../../src/lib/db/store';
import { ingestDocGraph } from '../../src/lib/graph/ingest-graph';
import type { TextGenerator } from '../../src/lib/ingest/autotag';

// End-to-end GraphRAG over a REAL SurrealDB (@surrealdb/wasm) mem:// store, driving the SAME
// ingestion glue the app uses (graph/ingest-graph.ts) with a STUBBED LLM (no GPU). Unlike
// entity-store.test.ts — which hand-feeds clean entities — this exercises the whole pipeline:
// LLM extraction → resolution (surface-form merge, confidence floor) → chunk-level provenance →
// persistence → vector-seed + graph-expand + RRF fuse, over a multi-client vault.
//
// The vault: a consultancy with two ISOLATED clients.
//   Acme:   Acme —hired→ Jane Smith —leads→ Project Atlas   (notes d1, d2; "ACME" review note d3)
//   Globex: Globex —retained→ Bob Lee —leads→ Project Zephyr (note d4)
// d1's chunk d1#0 names all three Acme entities; d1#1 names none (provenance probe). d2 names
// {Jane Smith, Project Atlas} (shares TWO entities with the seed); d3 names only ACME (shares one).

// One chunk per surface-bearing sentence; vectors are 3-dim. The Acme seed (d1#0) sits on axis 0;
// every sibling sits on a DIFFERENT axis, so a narrow vector pass (k=1) returns only the seed and
// would miss them — they can only come back through the graph.
const chunks: ChunkRecord[] = [
  { chunkId: 'd1#0', docId: 'd1', text: 'Acme Corp hired Jane Smith to lead Project Atlas.', charStart: 0, charEnd: 48, embedding: [1, 0, 0] }, // prettier-ignore
  { chunkId: 'd1#1', docId: 'd1', text: 'Kickoff is scheduled for Monday.', charStart: 0, charEnd: 32, embedding: [0.8, 0.2, 0] }, // prettier-ignore
  { chunkId: 'd2#0', docId: 'd2', text: 'Jane Smith approved the Project Atlas budget after review.', charStart: 0, charEnd: 57, embedding: [0, 1, 0] }, // prettier-ignore
  { chunkId: 'd3#0', docId: 'd3', text: "ACME's leadership reviewed the year.", charStart: 0, charEnd: 36, embedding: [0, 0.9, 0.1] }, // prettier-ignore
  { chunkId: 'd4#0', docId: 'd4', text: 'Globex retained Bob Lee for Project Zephyr.', charStart: 0, charEnd: 43, embedding: [0, 0, 1] } // prettier-ignore
];

// Stubbed extractor: branch on a unique phrase from each note and return strict-JSON extractions.
// d1 carries a low-confidence (0.3) "rumored_uses" relation that the floor MUST drop; d3 emits the
// SAME entity under two surface forms ("ACME"/"Acme") to exercise within-note alias merging.
const stubGen: TextGenerator = async (prompt: string) => {
  if (prompt.includes('hired Jane Smith')) {
    return JSON.stringify({
      entities: [
        { name: 'Acme', type: 'org' },
        { name: 'Jane Smith', type: 'person' },
        { name: 'Project Atlas', type: 'project' }
      ],
      relations: [
        { source: 'Acme', target: 'Jane Smith', type: 'hired', confidence: 0.95 },
        { source: 'Jane Smith', target: 'Project Atlas', type: 'leads', confidence: 0.9 },
        { source: 'Acme', target: 'Project Atlas', type: 'rumored_uses', confidence: 0.3 }
      ]
    });
  }
  if (prompt.includes('approved the Project Atlas budget')) {
    return JSON.stringify({
      entities: [
        { name: 'Jane Smith', type: 'person' },
        { name: 'Project Atlas', type: 'project' }
      ],
      relations: [{ source: 'Jane Smith', target: 'Project Atlas', type: 'funds', confidence: 0.8 }]
    });
  }
  if (prompt.includes('leadership reviewed the year')) {
    return JSON.stringify({
      entities: [
        { name: 'ACME', type: 'org' },
        { name: 'A.C.M.E.', type: 'org' } // distinct surface forms, SAME canonical id → alias union
      ],
      relations: []
    });
  }
  if (prompt.includes('retained Bob Lee')) {
    return JSON.stringify({
      entities: [
        { name: 'Globex', type: 'org' },
        { name: 'Bob Lee', type: 'person' },
        { name: 'Project Zephyr', type: 'project' }
      ],
      relations: [
        { source: 'Globex', target: 'Bob Lee', type: 'retained', confidence: 0.9 },
        { source: 'Bob Lee', target: 'Project Zephyr', type: 'leads', confidence: 0.9 }
      ]
    });
  }
  return '{"entities":[],"relations":[]}';
};

let store: VectorStore;

beforeEach(async () => {
  store = new VectorStore();
  await store.connect('mem://', 3);
  await store.upsertChunks(chunks); // chunks land first; extraction then attaches mentions to them
  for (const docId of ['d1', 'd2', 'd3', 'd4']) {
    const text = chunks
      .filter((c) => c.docId === docId)
      .map((c) => c.text)
      .join('\n');
    const res = await ingestDocGraph(store, docId, text, stubGen);
    expect(res.status).toBe('ingested');
  }
});

afterEach(async () => {
  await store?.close();
});

describe('extraction + resolution through the real ingest glue', () => {
  it('merges surface-form variants across and within notes into one entity node', async () => {
    const all = await store.allEntities();
    const acme = all.filter((e) => e.id === 'acme');
    expect(acme).toHaveLength(1); // "Acme" (d1) and "ACME"/"A.C.M.E." (d3) collapse to a single node
    // d3 was ingested last and emitted two distinct surface forms that resolve identically → both
    // survive as aliases (the resolver's alias-union path; pure case-variants would dedup at parse).
    expect(acme[0].aliases).toEqual(expect.arrayContaining(['ACME', 'A.C.M.E.']));
    // The whole vault resolves to exactly these canonical ids (no near-duplicate fragmentation).
    expect(all.map((e) => e.id).sort()).toEqual([
      'acme',
      'bob_lee',
      'globex',
      'jane_smith',
      'project_atlas',
      'project_zephyr'
    ]);
  });

  it('drops sub-floor relations and keeps the confident ones', async () => {
    const rels = await store.allRelations();
    expect(rels.find((r) => r.type === 'rumored_uses')).toBeUndefined(); // confidence 0.3 < 0.5
    expect(rels).toHaveLength(5); // hired, leads, funds, retained, leads (the 0.3 edge excluded)
  });

  it('attaches mentions only to the chunks that actually name the entity (provenance)', async () => {
    // d1#0 names all three Acme entities; d1#1 ("Kickoff…") names none.
    expect((await store.entityIdsForChunks(['d1#0'])).sort()).toEqual([
      'acme',
      'jane_smith',
      'project_atlas'
    ]);
    expect(await store.entityIdsForChunks(['d1#1'])).toEqual([]);
    // Acme is mentioned in d1 (Acme) and d3 (ACME) — the cross-note merge, visible as provenance.
    expect((await store.mentionsForEntity('acme')).map((m) => m.docId).sort()).toEqual([
      'd1',
      'd3'
    ]);
  });
});

describe('GraphRAG retrieval: structure beats lexical proximity', () => {
  it('pulls in siblings a narrow vector pass misses, ranked by shared-entity count', async () => {
    const query = [1, 0, 0]; // hugs d1#0 only

    // Baseline: plain vector search at k=1 returns ONLY the seed — d2#0/d3#0 are invisible to it.
    const vectorOnly = await store.search(query, 1);
    expect(vectorOnly.map((h) => h.chunkId)).toEqual(['d1#0']);

    const res = await store.graphRagSearch(query, { seedK: 1, expandK: 8, k: 8 });
    expect(res.seeds.map((h) => h.chunkId)).toEqual(['d1#0']);
    // Seed entities {acme, jane_smith, project_atlas} expand to d2#0 (shares 2) and d3#0 (shares 1),
    // ordered most-connected first. The empty d1#1 and the Globex chunk never appear.
    expect(res.expanded.map((h) => h.chunkId)).toEqual(['d2#0', 'd3#0']);
    expect(res.expanded[0].sharedCount).toBe(2);
    expect(res.expanded[0].sharedEntities.sort()).toEqual(['Jane Smith', 'Project Atlas']);
    expect(res.expanded[1].sharedCount).toBe(1);
    // The fused context carries the seed AND both graph-reached siblings.
    const fusedIds = res.fused.map((h) => h.chunkId);
    expect(fusedIds).toEqual(expect.arrayContaining(['d1#0', 'd2#0', 'd3#0']));
  });

  it('keeps clients isolated — an Acme query never reaches Globex', async () => {
    const res = await store.graphRagSearch([1, 0, 0], { seedK: 1, expandK: 8, k: 8 });
    expect(res.expanded.map((h) => h.chunkId)).not.toContain('d4#0');
    // And the persisted graphs are disconnected components: no path from Acme to Globex.
    const reach = (await store.entityNeighbors('acme', 3)).map((n) => n.id);
    expect(reach).not.toContain('globex');
    expect(reach).not.toContain('bob_lee');
  });
});

describe('incremental-extraction guard end to end', () => {
  it('skips an unchanged note and re-extracts an edited one', async () => {
    const text = chunks
      .filter((c) => c.docId === 'd1')
      .map((c) => c.text)
      .join('\n');
    // Same bytes as the beforeEach ingest → hash hit → no LLM pass.
    expect((await ingestDocGraph(store, 'd1', text, stubGen)).status).toBe('skipped');
    // Edited text still carries the d1 marker phrase → stub re-extracts → ingested again.
    expect((await ingestDocGraph(store, 'd1', text + '\nAddendum.', stubGen)).status).toBe(
      'ingested'
    );
  });

  it('is a no-op without a model (best-effort, never a hard failure)', async () => {
    expect((await ingestDocGraph(store, 'd1', 'anything', null)).status).toBe('no_model');
  });
});
