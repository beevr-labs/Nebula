import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VectorStore, type ChunkRecord } from '../../src/lib/db/store';
import { ingestDocGraph } from '../../src/lib/graph/ingest-graph';
import type { TextGenerator } from '../../src/lib/ingest/autotag';
import { assemblePrompt, parseCitations, SYSTEM_PROMPT_REASON } from '../../src/lib/chat/prompt';

// A REALISTIC sales scenario end-to-end: closing "Project Harmony", a deal to sell the SynthCloud
// platform to Yamaha. The vault is the kind of scattered note pile a real AE keeps — a status note,
// a budget note, a competitive note, a POC note, an org-map note, a channel note — plus an unrelated
// Bose deal that MUST stay isolated. Driven through the real ingest glue (graph/ingest-graph.ts) with
// a stubbed LLM, persisted to a real SurrealDB mem:// store. The point: the answer to "what's
// blocking this deal?" (the CFO's budget hold, the Roland counter-bid) lives in notes that share NO
// query words with the status note — only ENTITIES. Plain vector search misses them; GraphRAG, walking
// the shared-entity graph, pulls them in. This test proves that on a deliberately tangled relationship
// web (12 entities, ~16 relations, a Yamaha→Steinberg subsidiary edge, a 3-hop champion→SE path).
//
//   People:   Akira Tanaka (Yamaha VP Procurement, champion) · Yuki Sato (Yamaha CFO, budget blocker)
//             Maria Lopez (our AE) · David Chen (our SE, ran the POC)
//   Orgs:     Yamaha (customer) · Steinberg (Yamaha subsidiary, did the eval) · Roland (competitor)
//             TechDist (channel partner) · Bose (a SEPARATE deal — isolation probe)
//   Things:   Project Harmony (the deal) · SynthCloud (the product)

// 4-dim hand-built vectors. The deal-status chunk (d1#0) sits alone on axis 0 (the query hugs it);
// every other chunk leans on a DIFFERENT axis, so a narrow vector pass returns only d1#0 and is blind
// to the budget/competitor/POC notes. Small axis-0 leaks give a deterministic tie-break order.
const chunks: ChunkRecord[] = [
  { chunkId: 'd1#0', docId: 'd1', text: 'Project Harmony with Yamaha is in final negotiation; Maria Lopez expects signature this quarter.', charStart: 0, charEnd: 96, embedding: [1, 0, 0, 0] }, // prettier-ignore
  { chunkId: 'd2#0', docId: 'd2', text: "Yuki Sato, Yamaha's CFO, has not approved the Project Harmony budget; this is the main risk.", charStart: 0, charEnd: 91, embedding: [0.2, 0.9, 0, 0] }, // prettier-ignore
  { chunkId: 'd3#0', docId: 'd3', text: 'Roland submitted a lower bid for the same scope as SynthCloud on Project Harmony.', charStart: 0, charEnd: 80, embedding: [0.15, 0, 0.9, 0] }, // prettier-ignore
  { chunkId: 'd4#0', docId: 'd4', text: 'Steinberg, a Yamaha subsidiary, ran the SynthCloud POC and validated performance.', charStart: 0, charEnd: 80, embedding: [0.1, 0, 0, 0.9] }, // prettier-ignore
  { chunkId: 'd4#1', docId: 'd4', text: 'David Chen led the technical evaluation.', charStart: 0, charEnd: 40, embedding: [0.05, 0, 0, 0.95] }, // prettier-ignore
  { chunkId: 'd5#0', docId: 'd5', text: "Akira Tanaka, Yamaha's VP of Procurement, champions Project Harmony and pushed it internally.", charStart: 0, charEnd: 92, embedding: [0.3, 0.6, 0.6, 0] }, // prettier-ignore
  { chunkId: 'd6#0', docId: 'd6', text: 'TechDist will distribute SynthCloud to Yamaha under the partner agreement.', charStart: 0, charEnd: 73, embedding: [0.05, 0, 0.3, 0.7] }, // prettier-ignore
  { chunkId: 'd7#0', docId: 'd7', text: 'The Bose renewal is on track; Tom Baker owns it.', charStart: 0, charEnd: 48, embedding: [-1, 0, 0, 0] } // prettier-ignore
];

// Stubbed extractor — branch on a unique phrase per note. d1 carries a speculative 0.3 edge the floor
// must drop. Confidences are realistic (clear facts ~0.9; the "maybe knows" guess 0.3).
const stubGen: TextGenerator = async (prompt: string) => {
  if (prompt.includes('final negotiation')) {
    return JSON.stringify({
      entities: [
        { name: 'Project Harmony', type: 'project' },
        { name: 'Yamaha', type: 'org' },
        { name: 'Maria Lopez', type: 'person' }
      ],
      relations: [
        { source: 'Maria Lopez', target: 'Project Harmony', type: 'owns', confidence: 0.95 },
        { source: 'Project Harmony', target: 'Yamaha', type: 'for_customer', confidence: 0.9 },
        { source: 'Maria Lopez', target: 'Yamaha', type: 'personally_knows', confidence: 0.3 }
      ]
    });
  }
  if (prompt.includes('has not approved the Project Harmony budget')) {
    return JSON.stringify({
      entities: [
        { name: 'Yuki Sato', type: 'person' },
        { name: 'Yamaha', type: 'org' },
        { name: 'Project Harmony', type: 'project' }
      ],
      relations: [
        {
          source: 'Yuki Sato',
          target: 'Project Harmony',
          type: 'controls_budget',
          confidence: 0.9
        },
        { source: 'Yamaha', target: 'Yuki Sato', type: 'employs', confidence: 0.95 }
      ]
    });
  }
  if (prompt.includes('submitted a lower bid')) {
    return JSON.stringify({
      entities: [
        { name: 'Roland', type: 'org' },
        { name: 'SynthCloud', type: 'product' },
        { name: 'Project Harmony', type: 'project' }
      ],
      relations: [
        { source: 'Roland', target: 'SynthCloud', type: 'competes_with', confidence: 0.9 },
        { source: 'Roland', target: 'Project Harmony', type: 'bids_on', confidence: 0.85 }
      ]
    });
  }
  if (prompt.includes('ran the SynthCloud POC')) {
    return JSON.stringify({
      entities: [
        { name: 'Steinberg', type: 'org' },
        { name: 'Yamaha', type: 'org' },
        { name: 'SynthCloud', type: 'product' },
        { name: 'David Chen', type: 'person' }
      ],
      relations: [
        { source: 'Steinberg', target: 'SynthCloud', type: 'evaluated', confidence: 0.9 },
        { source: 'Yamaha', target: 'Steinberg', type: 'owns', confidence: 0.95 },
        { source: 'David Chen', target: 'Steinberg', type: 'ran_poc_at', confidence: 0.8 }
      ]
    });
  }
  if (prompt.includes('champions Project Harmony')) {
    return JSON.stringify({
      entities: [
        { name: 'Akira Tanaka', type: 'person' },
        { name: 'Yamaha', type: 'org' },
        { name: 'Project Harmony', type: 'project' }
      ],
      relations: [
        { source: 'Akira Tanaka', target: 'Project Harmony', type: 'champions', confidence: 0.9 },
        { source: 'Yamaha', target: 'Akira Tanaka', type: 'employs', confidence: 0.95 }
      ]
    });
  }
  if (prompt.includes('distribute SynthCloud to Yamaha')) {
    return JSON.stringify({
      entities: [
        { name: 'TechDist', type: 'org' },
        { name: 'SynthCloud', type: 'product' },
        { name: 'Yamaha', type: 'org' }
      ],
      relations: [
        { source: 'TechDist', target: 'SynthCloud', type: 'distributes', confidence: 0.9 },
        { source: 'TechDist', target: 'Yamaha', type: 'sells_to', confidence: 0.85 }
      ]
    });
  }
  if (prompt.includes('Bose renewal')) {
    return JSON.stringify({
      entities: [
        { name: 'Bose', type: 'org' },
        { name: 'Tom Baker', type: 'person' }
      ],
      relations: [{ source: 'Tom Baker', target: 'Bose', type: 'owns', confidence: 0.9 }]
    });
  }
  return '{"entities":[],"relations":[]}';
};

let store: VectorStore;

beforeEach(async () => {
  store = new VectorStore();
  await store.connect('mem://', 4);
  await store.upsertChunks(chunks);
  for (const docId of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']) {
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

describe('the deal graph persists with the right shape', () => {
  it('resolves every named thing to a single canonical node (no fragmentation)', async () => {
    const ids = (await store.allEntities()).map((e) => e.id).sort();
    expect(ids).toEqual([
      'akira_tanaka',
      'bose',
      'david_chen',
      'maria_lopez',
      'project_harmony',
      'roland',
      'steinberg',
      'synthcloud',
      'techdist',
      'tom_baker',
      'yamaha',
      'yuki_sato'
    ]);
  });

  it('drops the speculative edge but keeps the firm ones', async () => {
    const rels = await store.allRelations();
    expect(rels.find((r) => r.type === 'personally_knows')).toBeUndefined(); // 0.3 < floor
    // The deal's spine survived: who owns it, who it's for, who controls the budget, who champions it.
    const has = (s: string, t: string, ty: string) =>
      rels.some((r) => r.sourceId === s && r.targetId === t && r.type === ty);
    expect(has('maria_lopez', 'project_harmony', 'owns')).toBe(true);
    expect(has('yuki_sato', 'project_harmony', 'controls_budget')).toBe(true);
    expect(has('akira_tanaka', 'project_harmony', 'champions')).toBe(true);
    expect(has('yamaha', 'steinberg', 'owns')).toBe(true); // the subsidiary relationship
  });

  it('tracks Yamaha across the whole vault via mention provenance', async () => {
    const docs = (await store.mentionsForEntity('yamaha')).map((m) => m.docId);
    expect([...new Set(docs)].sort()).toEqual(['d1', 'd2', 'd4', 'd5', 'd6']);
    // The "David Chen" line names no deal entity → it carries no Yamaha/Harmony provenance.
    expect(await store.entityIdsForChunks(['d4#1'])).toEqual(['david_chen']);
  });
});

describe('multi-hop traversal answers "how is X connected to the deal?"', () => {
  it('walks champion → deal → CFO and reaches the SE only at 3 hops', async () => {
    const within1 = await store.entityNeighbors('akira_tanaka', 1);
    expect(within1.map((n) => n.id).sort()).toEqual(['project_harmony', 'yamaha']);

    const within2 = new Map(
      (await store.entityNeighbors('akira_tanaka', 2)).map((n) => [n.id, n.hop])
    );
    // The CFO who's blocking the budget is 2 hops from the champion — via the deal AND via Yamaha.
    expect(within2.get('yuki_sato')).toBe(2);
    expect(within2.get('roland')).toBe(2); // the competitor, reachable through the deal
    expect(within2.get('steinberg')).toBe(2); // the subsidiary, reachable through Yamaha
    expect(within2.has('david_chen')).toBe(false); // our SE is deeper

    const within3 = new Map(
      (await store.entityNeighbors('akira_tanaka', 3)).map((n) => [n.id, n.hop])
    );
    expect(within3.get('david_chen')).toBe(3);
    expect(within3.get('synthcloud')).toBe(3);
    // The Bose deal is a disconnected component — never reachable at any depth.
    expect(within3.has('bose')).toBe(false);
    expect(within3.has('tom_baker')).toBe(false);
  });

  it('renders a tight sub-graph among a chosen set of entities', async () => {
    const among = await store.relationsAmong(['yamaha', 'akira_tanaka', 'project_harmony']);
    const edges = among.map((r) => `${r.sourceId}->${r.targetId}:${r.type}`).sort();
    expect(edges).toEqual([
      'akira_tanaka->project_harmony:champions',
      'project_harmony->yamaha:for_customer',
      'yamaha->akira_tanaka:employs'
    ]);
  });
});

describe('GraphRAG surfaces the blockers a keyword search would miss', () => {
  it('answers "where does the Yamaha deal stand?" with the budget hold and the counter-bid', async () => {
    const query = [1, 0, 0, 0]; // hugs only the deal-status note d1#0

    // A plain top-1 vector search sees ONLY the status note — the CFO/budget and Roland notes use
    // none of its words, so they're invisible. This is the failure GraphRAG exists to fix.
    expect((await store.search(query, 1)).map((h) => h.chunkId)).toEqual(['d1#0']);

    const res = await store.graphRagSearch(query, { seedK: 1, expandK: 10, k: 10 });
    expect(res.seeds.map((h) => h.chunkId)).toEqual(['d1#0']);

    // The seed's entities {Project Harmony, Yamaha, Maria Lopez} expand to every note that shares one,
    // ranked most-connected first: the champion note and the CFO/budget note (share TWO) lead, then
    // the competitor, POC, and channel notes (share one). The empty SE line and the Bose deal never appear.
    expect(res.expanded.map((h) => h.chunkId)).toEqual(['d5#0', 'd2#0', 'd3#0', 'd4#0', 'd6#0']);
    expect(res.expanded[0].sharedCount).toBe(2);
    expect(res.expanded[1].sharedCount).toBe(2);
    expect(res.expanded[2].sharedCount).toBe(1);
    expect(res.expanded.map((h) => h.chunkId)).not.toContain('d4#1');
    expect(res.expanded.map((h) => h.chunkId)).not.toContain('d7#0'); // Bose stays out

    // The CFO/budget note explains itself: it's here because it shares Project Harmony + Yamaha.
    const budget = res.expanded.find((h) => h.chunkId === 'd2#0')!;
    expect(budget.sharedEntities.sort()).toEqual(['Project Harmony', 'Yamaha']);

    // The fused answer context therefore carries the status note AND the real blockers/threats.
    const fused = res.fused.map((h) => h.chunkId);
    expect(fused).toEqual(expect.arrayContaining(['d1#0', 'd2#0', 'd3#0', 'd5#0']));
  });
});

// Retrieval is only half the job; the win is the ANSWER. These tests prove the Ask pipeline hands the
// model everything a winning strategy needs (in REASON mode, so it synthesizes rather than quotes),
// and that a cited plan is faithfully traced back to the notes it stands on. The model's actual
// reasoning is GPU/human-gated (a real WebLLM run) — see the live-verification report — but the
// system's job (retrieve the right facts → assemble the right prompt → honor the answer's citations)
// is fully deterministic and asserted here.
describe('Ask: the model is set up to analyze the deal and propose a winning strategy', () => {
  async function strategyContext() {
    // What the app feeds the model: GraphRAG fused context for the strategy question.
    const res = await store.graphRagSearch([1, 0, 0, 0], { seedK: 1, expandK: 10, k: 10 });
    return res.fused;
  }
  const QUESTION = 'How do we win the Yamaha deal — what is blocking it and what should we do?';

  it('assembles a REASON-mode prompt carrying every blocker and lever the plan needs', async () => {
    const prompt = assemblePrompt(QUESTION, await strategyContext(), { mode: 'reason' });
    expect(prompt.kind).toBe('grounded');
    if (prompt.kind !== 'grounded') return;

    // Strategy mode: the model is told to REASON and apply knowledge, not just quote.
    expect(prompt.system).toBe(SYSTEM_PROMPT_REASON);
    expect(prompt.user).toContain('reason and apply your knowledge');

    // The decisive facts are all in front of the model — the two blockers AND the two levers:
    expect(prompt.user).toContain('has not approved the Project Harmony budget'); // blocker: CFO budget
    expect(prompt.user).toContain('Roland submitted a lower bid'); // blocker: competitor undercut
    expect(prompt.user).toContain('champions Project Harmony'); // lever: internal champion
    expect(prompt.user).toContain('validated performance'); // lever: a proven POC to counter Roland
    // …and the irrelevant Bose deal is NOT — it never entered retrieval, so it can't derail the answer.
    expect(prompt.user).not.toContain('Bose');

    // Each context block is numbered so the model can cite it; the map is exact.
    expect(prompt.contextOrder).toEqual(
      expect.arrayContaining(['d1#0', 'd2#0', 'd3#0', 'd4#0', 'd5#0'])
    );
  });

  it('traces a cited strategy back to the exact source notes (0 fabricated citations)', async () => {
    const prompt = assemblePrompt(QUESTION, await strategyContext(), { mode: 'reason' });
    if (prompt.kind !== 'grounded') throw new Error('expected grounded prompt');
    const n = (chunkId: string) => prompt.contextOrder.indexOf(chunkId) + 1;

    // The shape of a correct answer: clear the CFO budget hold, neutralize Roland with the validated
    // POC, and mobilize the champion — each claim cited to the note it rests on. (A real model writes
    // the prose; here we assert the system maps those citations back to the right sources.)
    const plan =
      `Three moves to close Project Harmony: (1) unblock the budget with CFO Yuki Sato [#${n('d2#0')}]; ` +
      `(2) neutralize Roland's lower bid [#${n('d3#0')}] by leaning on Steinberg's validated POC [#${n('d4#0')}]; ` +
      `(3) mobilize champion Akira Tanaka [#${n('d5#0')}] to push internally.`;

    const { citations, dropped } = parseCitations(plan, prompt.contextOrder);
    expect(dropped).toBe(0); // no citation points outside the retrieved context (no hallucinated source)
    expect([...new Set(citations.map((c) => c.chunkId))].sort()).toEqual([
      'd2#0', // budget blocker
      'd3#0', // competitor
      'd4#0', // POC proof
      'd5#0' // champion
    ]);
  });

  it('refuses to invent a plan when retrieval is empty (no notes → no fabricated strategy)', () => {
    const prompt = assemblePrompt(QUESTION, [], { mode: 'reason' });
    expect(prompt.kind).toBe('no_results'); // the no-results guard fires instead of hallucinating
  });
});
