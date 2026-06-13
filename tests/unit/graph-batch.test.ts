import { describe, it, expect } from 'vitest';
import {
  buildBatchEntityPrompt,
  parseBatchEntityResponse,
  planBatches,
  BATCH_ENTITY_INSTRUCTION,
  ENTITY_INSTRUCTION
} from '../../src/lib/graph/entities';
import {
  ingestVaultGraph,
  graphHash,
  type GraphIngestStore,
  type VaultGraphProgress
} from '../../src/lib/graph/ingest-graph';
import type { TextGenerator } from '../../src/lib/ingest/autotag';
import type { EntityRecord } from '../../src/lib/graph/types';

// Batched vault extraction — the "build graph on a many-note vault" path. Pure + fake store, no GPU.

describe('planBatches', () => {
  it('packs in order under the token budget', () => {
    expect(planBatches([5, 5, 5], 10, 6)).toEqual([[0, 1], [2]]);
  });

  it('caps a batch at maxDocs even when the budget has room', () => {
    expect(planBatches([1, 1, 1, 1, 1], 100, 2)).toEqual([[0, 1], [2, 3], [4]]);
  });

  it('gives an oversized item its own group instead of dropping it', () => {
    expect(planBatches([50, 3, 3], 10, 6)).toEqual([[0], [1, 2]]);
  });

  it('returns [] for no items', () => {
    expect(planBatches([], 10, 6)).toEqual([]);
  });
});

describe('buildBatchEntityPrompt', () => {
  it('numbers the documents from 1 and embeds the batch instruction', () => {
    const p = buildBatchEntityPrompt(['alpha beta', 'gamma']);
    expect(p).toContain(BATCH_ENTITY_INSTRUCTION);
    expect(p).toContain('# Document 1\nalpha beta');
    expect(p).toContain('# Document 2\ngamma');
  });

  it('skims each document to the token window', () => {
    const long = Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ');
    const p = buildBatchEntityPrompt([long], { skimTokens: 3 });
    expect(p).toContain('# Document 1\nw0 w1 w2');
    expect(p).not.toContain('w3');
  });
});

describe('parseBatchEntityResponse', () => {
  const twoDocs = JSON.stringify({
    docs: [
      {
        id: 1,
        entities: [
          { name: 'Acme', type: 'org' },
          { name: 'Jane', type: 'person' }
        ],
        relations: [{ source: 'Jane', target: 'Acme', type: 'works at', confidence: 0.9 }]
      },
      { id: 2, entities: [{ name: 'Hanoi', type: 'place' }], relations: [] }
    ]
  });

  it('routes each docs item to its slot and normalizes like the single parser', () => {
    const slots = parseBatchEntityResponse(twoDocs, 2);
    expect(slots[0]).toEqual({
      entities: [
        { name: 'Acme', type: 'org' },
        { name: 'Jane', type: 'person' }
      ],
      relations: [{ source: 'Jane', target: 'Acme', type: 'works_at', confidence: 0.9 }]
    });
    expect(slots[1]).toEqual({ entities: [{ name: 'Hanoi', type: 'place' }], relations: [] });
  });

  it('tolerates code fences and prose around the object', () => {
    const slots = parseBatchEntityResponse('Sure!\n```json\n' + twoDocs + '\n```\nDone.', 2);
    expect(slots[0]?.entities[0].name).toBe('Acme');
  });

  it('leaves a dropped document as null (and only that one)', () => {
    const slots = parseBatchEntityResponse(
      '{"docs":[{"id":2,"entities":[{"name":"X","type":"concept"}],"relations":[]}]}',
      2
    );
    expect(slots[0]).toBeNull();
    expect(slots[1]?.entities[0].name).toBe('X');
  });

  it('ignores out-of-range and duplicate ids (first item per id wins)', () => {
    const slots = parseBatchEntityResponse(
      JSON.stringify({
        docs: [
          { id: 0, entities: [{ name: 'Zero', type: 'concept' }], relations: [] },
          { id: 3, entities: [{ name: 'Three', type: 'concept' }], relations: [] },
          { id: 1, entities: [{ name: 'First', type: 'concept' }], relations: [] },
          { id: 1, entities: [{ name: 'Second', type: 'concept' }], relations: [] }
        ]
      }),
      2
    );
    expect(slots[0]?.entities[0].name).toBe('First');
    expect(slots[1]).toBeNull();
  });

  it('drops relations whose endpoints are not entities of the SAME document', () => {
    const slots = parseBatchEntityResponse(
      JSON.stringify({
        docs: [
          {
            id: 1,
            entities: [{ name: 'Acme', type: 'org' }],
            relations: [{ source: 'Acme', target: 'Hanoi', type: 'located_in' }] // Hanoi is doc 2's
          },
          { id: 2, entities: [{ name: 'Hanoi', type: 'place' }], relations: [] }
        ]
      }),
      2
    );
    expect(slots[0]?.relations).toEqual([]);
  });

  it('returns all-null for unparseable output', () => {
    expect(parseBatchEntityResponse('no json here', 3)).toEqual([null, null, null]);
  });
});

// ---------------------------------------------------------------------------
// ingestVaultGraph against a fake structural store + scripted generator.

function fakeStore() {
  const hashes = new Map<string, string>();
  const entities = new Map<string, EntityRecord[]>(); // per upsert call
  const mentions: { chunkId: string; docId: string; entityId: string }[] = [];
  const store: GraphIngestStore = {
    getGraphHash: async (docId) => hashes.get(docId) ?? null,
    setGraphHash: async (docId, hash) => void hashes.set(docId, hash),
    clearDocGraph: async () => {},
    upsertEntities: async (es) => void entities.set(`call${entities.size}`, es),
    chunkTextsForDoc: async (docId) => [{ chunkId: `${docId}#0`, text: texts.get(docId) ?? '' }],
    relateMentions: async (edges) => void mentions.push(...edges),
    relateEntityEdges: async () => {},
    getGraphHashes: async (ids) =>
      new Map(
        ids.flatMap((id) => (hashes.has(id) ? [[id, hashes.get(id)!] as [string, string]] : []))
      ),
    setGraphHashes: async (ps) => ps.forEach((p) => hashes.set(p.docId, p.hash)),
    clearDocGraphs: async () => {},
    chunkTextsForDocs: async (ids) =>
      new Map(ids.map((id) => [id, [{ chunkId: `${id}#0`, text: texts.get(id) ?? '' }]]))
  };
  const texts = new Map<string, string>();
  return { store, hashes, mentions, texts };
}

/** Generator that records every prompt and replies via the supplied script. */
function scripted(script: (prompt: string, call: number) => string) {
  const prompts: string[] = [];
  const gen: TextGenerator = async (p) => {
    prompts.push(p);
    return script(p, prompts.length - 1);
  };
  return { gen, prompts };
}

const batchReply = (items: { id: number; name: string; type?: string }[]) =>
  JSON.stringify({
    docs: items.map((i) => ({
      id: i.id,
      entities: [{ name: i.name, type: i.type ?? 'concept' }],
      relations: []
    }))
  });

describe('ingestVaultGraph', () => {
  it('extracts several short notes with ONE generation and persists each', async () => {
    const { store, hashes, mentions, texts } = fakeStore();
    const docs = [
      { docId: 'a', text: 'Acme hired Jane.' },
      { docId: 'b', text: 'Globex retained Bob.' },
      { docId: 'c', text: 'Hanoi office opened.' }
    ];
    docs.forEach((d) => texts.set(d.docId, d.text));
    const { gen, prompts } = scripted(() =>
      batchReply([
        { id: 1, name: 'Acme', type: 'org' },
        { id: 2, name: 'Globex', type: 'org' },
        { id: 3, name: 'Hanoi', type: 'place' }
      ])
    );

    const results = await ingestVaultGraph(store, docs, gen);

    expect(prompts).toHaveLength(1); // the whole vault cost ONE LLM call
    expect(prompts[0]).toContain(BATCH_ENTITY_INSTRUCTION);
    expect(results.get('a')).toEqual({ status: 'ingested', entityCount: 1 });
    expect(results.get('b')).toEqual({ status: 'ingested', entityCount: 1 });
    expect(results.get('c')).toEqual({ status: 'ingested', entityCount: 1 });
    // each note recorded its hash (next rebuild skips) and attached its mention provenance
    expect(hashes.get('a')).toBe(graphHash(docs[0].text));
    expect(mentions.some((m) => m.docId === 'a' && m.chunkId === 'a#0')).toBe(true);
  });

  it('skips hash-unchanged notes with zero LLM calls', async () => {
    const { store, hashes } = fakeStore();
    const docs = [{ docId: 'a', text: 'Unchanged note.' }];
    hashes.set('a', graphHash(docs[0].text));
    const { gen, prompts } = scripted(() => batchReply([{ id: 1, name: 'X' }]));

    const results = await ingestVaultGraph(store, docs, gen);

    expect(prompts).toHaveLength(0);
    expect(results.get('a')).toEqual({ status: 'skipped' });
  });

  it('falls back to single-doc extraction ONLY for a slot the model dropped', async () => {
    const { store, texts } = fakeStore();
    const docs = [
      { docId: 'a', text: 'Acme hired Jane.' },
      { docId: 'b', text: 'Globex retained Bob.' }
    ];
    docs.forEach((d) => texts.set(d.docId, d.text));
    const { gen, prompts } = scripted((p, call) =>
      call === 0
        ? batchReply([{ id: 1, name: 'Acme', type: 'org' }]) // doc 2 dropped
        : '{"entities":[{"name":"Globex","type":"org"}],"relations":[]}'
    );

    const results = await ingestVaultGraph(store, docs, gen);

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(ENTITY_INSTRUCTION); // the retry is the proven SINGLE-doc prompt
    expect(prompts[1]).not.toContain(BATCH_ENTITY_INSTRUCTION);
    expect(results.get('a')).toEqual({ status: 'ingested', entityCount: 1 });
    expect(results.get('b')).toEqual({ status: 'ingested', entityCount: 1 });
  });

  it('settles a thrown batch generation as no_graph WITHOUT per-doc retries', async () => {
    const { store } = fakeStore();
    const docs = [
      { docId: 'a', text: 'Acme hired Jane.' },
      { docId: 'b', text: 'Globex retained Bob.' }
    ];
    const { gen, prompts } = scripted(() => {
      throw new Error('model gone');
    });

    const results = await ingestVaultGraph(store, docs, gen);

    expect(prompts).toHaveLength(1); // no pointless retries against a dead model
    expect(results.get('a')).toEqual({ status: 'no_graph' });
    expect(results.get('b')).toEqual({ status: 'no_graph' });
  });

  it('routes notes longer than the skim window to the segmented solo path', async () => {
    const { store, texts } = fakeStore();
    const long = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    const docs = [
      { docId: 'short', text: 'Acme hired Jane.' },
      { docId: 'long', text: long }
    ];
    docs.forEach((d) => texts.set(d.docId, d.text));
    const { gen, prompts } = scripted((p) =>
      p.includes(BATCH_ENTITY_INSTRUCTION) || !p.includes('word')
        ? '{"entities":[{"name":"Acme","type":"org"}],"relations":[]}'
        : '{"entities":[{"name":"LongTopic","type":"concept"}],"relations":[]}'
    );

    const results = await ingestVaultGraph(store, docs, gen, { skimTokens: 8, maxSegments: 2 });

    // short (3 tokens ≤ 8) went alone → single-doc prompt; long (20 tokens) → 2 solo segments
    expect(results.get('short')?.status).toBe('ingested');
    expect(results.get('long')?.status).toBe('ingested');
    const soloLongCalls = prompts.filter((p) => p.includes('word0') || p.includes('word8'));
    expect(soloLongCalls.length).toBe(2); // segmented — covers the tail past one skim window
    expect(prompts.every((p) => !p.includes(BATCH_ENTITY_INSTRUCTION))).toBe(true); // nothing to pack with
  });

  it('respects maxBatchDocs and reports cumulative progress per batch', async () => {
    const { store, texts } = fakeStore();
    const docs = Array.from({ length: 5 }, (_, i) => ({
      docId: `d${i}`,
      text: `Note ${i} mentions Topic${i}.`
    }));
    docs.forEach((d) => texts.set(d.docId, d.text));
    const { gen, prompts } = scripted((p) =>
      p.includes(BATCH_ENTITY_INSTRUCTION)
        ? batchReply([
            { id: 1, name: 'T1' },
            { id: 2, name: 'T2' }
          ])
        : '{"entities":[{"name":"Solo","type":"concept"}],"relations":[]}'
    );
    const ticks: VaultGraphProgress[] = [];

    await ingestVaultGraph(store, docs, gen, {
      maxBatchDocs: 2,
      onBatch: (p) => void ticks.push({ ...p })
    });

    expect(prompts).toHaveLength(3); // 2+2 batched, last one solo
    expect(ticks.map((t) => t.done)).toEqual([2, 4, 5]); // cumulative, one tick per batch
    expect(ticks.at(-1)).toMatchObject({ done: 5, total: 5, extracted: 5, skipped: 0 });
  });

  it('returns no_model for every note when no generator is loaded', async () => {
    const { store } = fakeStore();
    const results = await ingestVaultGraph(store, [{ docId: 'a', text: 'x' }], null);
    expect(results.get('a')).toEqual({ status: 'no_model' });
  });
});
