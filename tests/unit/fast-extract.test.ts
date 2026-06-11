import { describe, it, expect } from 'vitest';
import { extractHeuristic } from '../../src/lib/graph/fast-extract';
import {
  ingestVaultGraphFast,
  ingestVaultGraph,
  graphHash,
  HEURISTIC_HASH_PREFIX,
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
    relateEntityEdges: async () => {}
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
});
