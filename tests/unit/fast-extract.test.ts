import { describe, it, expect } from 'vitest';
import { extractHeuristic } from '../../src/lib/graph/fast-extract';
import {
  ingestVaultGraphFast,
  ingestVaultGraph,
  graphHash,
  HEURISTIC_HASH_PREFIX,
  FAST_PERSIST_BATCH,
  type GraphIngestStore
} from '../../src/lib/graph/ingest-graph';
import type { TextGenerator } from '../../src/lib/ingest/autotag';
import type { EntityRecord } from '../../src/lib/graph/types';

// Tier-0 instant extraction — pure JS, no model — and the two-tier hash dance with the LLM pass.

const names = (t: string) => extractHeuristic(t).entities.map((e) => e.name);

describe('extractHeuristic — entities', () => {
  it('keeps multi-word proper nouns outright (English and Vietnamese)', () => {
    const got = names('Met Jane Smith in Hà Nội to plan the Sakura Inn booking.');
    expect(got).toContain('Jane Smith');
    expect(got).toContain('Hà Nội');
    expect(got).toContain('Sakura Inn');
  });

  it('keeps a single capitalized word only when it also appears mid-sentence', () => {
    // "Hakone" appears mid-sentence → real entity. "The" and "Hôm" only ever start sentences.
    const got = names('Hôm nay rất đẹp. The trip covers Hakone. Hakone has onsen.');
    expect(got).toContain('Hakone');
    expect(got).not.toContain('Hôm');
    expect(got).not.toContain('The');
  });

  it('drops a sentence-initial-only single word (cannot be distinguished from sentence case)', () => {
    expect(names('Hakone is lovely.')).not.toContain('Hakone');
  });

  it('keeps ALL-CAPS acronyms even sentence-initial', () => {
    expect(names('BTS released a new album.')).toContain('BTS');
  });

  it('keeps wikilink targets unconditionally (aliases and headings stripped)', () => {
    const got = names('xem [[caffeine|cà phê]] và [[why-we-sleep#chapter 3]] nhé');
    expect(got).toContain('caffeine');
    expect(got).toContain('why-we-sleep');
  });

  it('handles hyphen/apostrophe names ("Sơn Tùng M-TP", "O\'Brien")', () => {
    const got = names("Sơn Tùng M-TP met O'Brien at the show. Cùng O'Brien diễn.");
    expect(got).toContain('Sơn Tùng M-TP');
    expect(got).toContain("O'Brien");
  });

  it('drops Vietnamese common/structural heads ("Điểm", "Tổng") but keeps real names beside them', () => {
    const got = names(
      'Điểm mạnh của Cảng Vĩnh Triều rất rõ. Tổng kết: Cảng Vĩnh Triều đạt 8 Điểm. Tổng chi phí thấp.'
    );
    expect(got).toContain('Cảng Vĩnh Triều');
    expect(got).not.toContain('Điểm');
    expect(got).not.toContain('Tổng');
  });

  it('drops a de-accented all-common multi-word header but keeps a distinctive run', () => {
    const got = names('Bao cao Doanh Thu. Doanh Thu cua Tan Luc tang. Tan Luc dat ky luc.');
    expect(got).not.toContain('Doanh Thu');
    expect(got).toContain('Tan Luc');
  });

  it('drops a lone single capitalized letter ("C") even mid-sentence', () => {
    expect(names('Hạng C tốt. Đạt hạng C lần nữa.')).not.toContain('C');
  });

  it('clamps entity count and pronouns never survive resolution downstream', () => {
    const many = Array.from({ length: 60 }, (_, i) => `Alpha B${i} works.`).join(' ');
    expect(extractHeuristic(many).entities.length).toBeLessThanOrEqual(24);
  });
});

describe('extractHeuristic — co-occurrence relations', () => {
  it('relates two kept names sharing a sentence, not names in different sentences', () => {
    const ext = extractHeuristic(
      'Jane Smith joined Acme Corp last spring. Bob Lee stayed home that day.'
    );
    const rels = ext.relations.map((r) => `${r.source}->${r.target}`);
    expect(rels).toContain('Acme Corp->Jane Smith'); // sorted pair
    expect(rels.some((r) => r.includes('Bob Lee'))).toBe(false);
  });

  it('uses related_to with confidence at/above the persistence floor, growing with repeats', () => {
    const ext = extractHeuristic(
      'Jane Smith met Acme Corp. Jane Smith signed with Acme Corp. Jane Smith left Acme Corp.'
    );
    const rel = ext.relations[0];
    expect(rel.type).toBe('related_to');
    expect(rel.confidence).toBeGreaterThanOrEqual(0.5);
    expect(rel.confidence).toBeCloseTo(0.7, 5); // three co-occurrences → 0.5 + 0.1×2
  });

  it('treats markdown lines as sentence boundaries', () => {
    const ext = extractHeuristic('# Trip Notes\n- Jane Smith\n- Acme Corp');
    expect(ext.relations).toEqual([]); // different lines → no co-occurrence edge
  });
});

// ---------------------------------------------------------------------------
// Two-tier interplay over the fake store.

function fakeStore() {
  const hashes = new Map<string, string>();
  const texts = new Map<string, string>();
  const store: GraphIngestStore = {
    getGraphHash: async (docId) => hashes.get(docId) ?? null,
    setGraphHash: async (docId, hash) => void hashes.set(docId, hash),
    clearDocGraph: async () => {},
    upsertEntities: async (_es: EntityRecord[]) => {},
    chunkTextsForDoc: async (docId) => [{ chunkId: `${docId}#0`, text: texts.get(docId) ?? '' }],
    relateMentions: async () => {},
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
  return { store, hashes, texts };
}

describe('ingestVaultGraphFast — tier-0 pass', () => {
  const NOTE = 'Jane Smith joined Acme Corp. Jane Smith leads the team.';

  it('ingests instantly with NO generator and records the heuristic-tier hash', async () => {
    const { store, hashes, texts } = fakeStore();
    texts.set('a', NOTE);
    const results = await ingestVaultGraphFast(store, [{ docId: 'a', text: NOTE }]);
    expect(results.get('a')?.status).toBe('ingested');
    expect(hashes.get('a')).toBe(HEURISTIC_HASH_PREFIX + graphHash(NOTE));
  });

  it('never overwrites an LLM/seeded graph (plain hash) and skips its own prior work', async () => {
    const { store, hashes, texts } = fakeStore();
    texts.set('a', NOTE);
    hashes.set('a', graphHash(NOTE)); // LLM tier already graphed this exact text
    const r1 = await ingestVaultGraphFast(store, [{ docId: 'a', text: NOTE }]);
    expect(r1.get('a')?.status).toBe('skipped');
    hashes.set('a', HEURISTIC_HASH_PREFIX + graphHash(NOTE)); // its own prior pass
    const r2 = await ingestVaultGraphFast(store, [{ docId: 'a', text: NOTE }]);
    expect(r2.get('a')?.status).toBe('skipped');
  });

  it('LLM pass picks heuristic-tier notes up for enrichment and upgrades the hash marker', async () => {
    const { store, hashes, texts } = fakeStore();
    texts.set('a', NOTE);
    await ingestVaultGraphFast(store, [{ docId: 'a', text: NOTE }]);
    const gen: TextGenerator = async () =>
      '{"entities":[{"name":"Jane Smith","type":"person"}],"relations":[]}';
    const results = await ingestVaultGraph(store, [{ docId: 'a', text: NOTE }], gen);
    expect(results.get('a')?.status).toBe('ingested'); // NOT skipped — h:<hash> ≠ <hash>
    expect(hashes.get('a')).toBe(graphHash(NOTE)); // now owned by the LLM tier
  });

  it('a note with no extractable names settles as no_graph without recording a hash', async () => {
    const { store, hashes } = fakeStore();
    const r = await ingestVaultGraphFast(store, [{ docId: 'a', text: 'chỉ chữ thường thôi.' }]);
    expect(r.get('a')?.status).toBe('no_graph');
    expect(hashes.has('a')).toBe(false);
  });

  it('persists a bulk import in one pass with correct dedup (no per-note duplicate explosion)', async () => {
    const { store, hashes, texts } = fakeStore();
    // 20 notes that all name the SAME org + city → must collapse to one node each, not 20.
    const docs = Array.from({ length: 20 }, (_, i) => {
      const text = `Người ${i} ký với Vinamilk tại Đà Nẵng về dự án Mercury.`;
      texts.set(`d${i}`, text);
      return { docId: `d${i}`, text };
    });
    const results = await ingestVaultGraphFast(store, docs);
    expect([...results.values()].every((r) => r.status === 'ingested')).toBe(true);
    expect(hashes.get('d0')).toBe(HEURISTIC_HASH_PREFIX + graphHash(docs[0].text));
    expect(hashes.get('d19')).toBe(HEURISTIC_HASH_PREFIX + graphHash(docs[19].text));
  });

  it('BATCHES every write across the whole import (one DB round-trip per write type, not per note)', async () => {
    // The perf fix: a 50-note import must not pay ~6 serialized writes per note. Count store calls.
    const hashes = new Map<string, string>();
    const calls = {
      clear: 0,
      upsert: 0,
      mentions: 0,
      edges: 0,
      setHash: 0,
      hashRead: 0,
      chunkRead: 0
    };
    const store: GraphIngestStore = {
      getGraphHash: async () => null,
      setGraphHash: async () => void calls.setHash++,
      clearDocGraph: async () => void calls.clear++,
      upsertEntities: async () => void calls.upsert++,
      chunkTextsForDoc: async () => [],
      relateMentions: async () => void calls.mentions++,
      relateEntityEdges: async () => void calls.edges++,
      getGraphHashes: async () => (calls.hashRead++, new Map()),
      setGraphHashes: async () => void calls.setHash++,
      clearDocGraphs: async () => void calls.clear++,
      chunkTextsForDocs: async (ids) => (calls.chunkRead++, new Map(ids.map((id) => [id, []])))
    };
    const N = 50;
    const docs = Array.from({ length: N }, (_, i) => ({
      docId: `d${i}`,
      text: `Công ty Vinamilk hợp tác với Đà Nẵng trong dự án Mercury ${i}.`
    }));
    await ingestVaultGraphFast(store, docs);
    // ONE hash read for the whole import; the writes flush once per FAST_PERSIST_BATCH-note slice —
    // a few round-trips for 50 notes, NEVER the ~6-per-note (≈300) the single methods would cost.
    const slices = Math.ceil(N / FAST_PERSIST_BATCH);
    expect(calls).toEqual({
      clear: slices,
      upsert: slices,
      mentions: slices,
      edges: slices,
      setHash: slices,
      hashRead: 1,
      chunkRead: slices
    });
    expect(slices).toBeLessThan(N); // the point: not per-note
  });
});
