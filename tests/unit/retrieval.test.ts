import { describe, it, expect } from 'vitest';
import {
  cosineSimilarity,
  rrfFuse,
  vectorSearch,
  queryTerms,
  hybridRerank,
  entityAnchorDocs,
  restrictToEntities,
  withLexicalChannel,
  wordTermScore,
  type IndexedChunk
} from '../../src/lib/retrieval/search';

// FR-RET-001 · ALGORITHMS §3 — pure ranking/fusion primitives.

describe('queryTerms', () => {
  it('keeps distinctive content words, drops stop words + short tokens', () => {
    expect(queryTerms('What is the budget blocker for Project Harmony?')).toEqual([
      'budget',
      'blocker',
      'project',
      'harmony'
    ]);
  });

  it('dedupes and is unicode-aware (Vietnamese content words survive)', () => {
    expect(queryTerms('Harmony harmony HARMONY')).toEqual(['harmony']);
    expect(queryTerms('rủi ro ngân sách')).toEqual(['rủi', 'ngân', 'sách']); // 'ro' < 3 chars dropped
  });
});

describe('hybridRerank (precision: demote topically-similar but term-irrelevant hits)', () => {
  // Simulates the live bug: an unrelated invoice note out-scores the real deal note on cosine for a
  // "budget" question, purely on money-topic similarity — but never names the deal.
  const hits = [
    {
      chunkId: 'invoice#0',
      docId: 'notes/beevr.md',
      text: 'invoices balance fee payment cash',
      score: 0.62
    },
    {
      chunkId: 'budget#0',
      docId: 'deals/harmony-budget.md',
      text: 'Project Harmony budget not approved',
      score: 0.55
    },
    {
      chunkId: 'comp#0',
      docId: 'deals/harmony-competition.md',
      text: 'Roland undercut Project Harmony',
      score: 0.5
    }
  ];

  it('moves the note that names the query subject above the higher-cosine but unrelated note', () => {
    const out = hybridRerank(hits, queryTerms('What is the Project Harmony budget blocker?'));
    expect(out[0].chunkId).toBe('budget#0'); // names "project","harmony","budget" → boosted past invoice
    expect(out[out.length - 1].chunkId).toBe('invoice#0'); // no query term → demoted to the bottom
  });

  it('preserves cosine scores (only the order changes)', () => {
    const out = hybridRerank(hits, queryTerms('Project Harmony budget'));
    expect(out.find((h) => h.chunkId === 'invoice#0')!.score).toBe(0.62);
  });

  it('is a no-op when no hit shares a query term (recall preserved)', () => {
    const out = hybridRerank(hits, queryTerms('quantum chromodynamics lattice'));
    expect(out.map((h) => h.chunkId)).toEqual(hits.map((h) => h.chunkId));
  });
});

describe('entityAnchorDocs (graph-native 2-hop subject cluster)', () => {
  const entities = [
    // "Project Harmony" is named in budget + competition; "Yamaha" co-occurs in competition and also
    // appears in the POC note (which never says "Project Harmony"); Globex is a separate deal.
    {
      name: 'Project Harmony',
      docIds: ['deals/harmony-budget.md', 'deals/harmony-competition.md']
    },
    { name: 'Yamaha', docIds: ['deals/harmony-competition.md', 'deals/harmony-poc.md'] },
    { name: 'Globex Industries', docIds: ['globex/globex-deal.md'] }
  ];

  it('seeds on the docs of an entity the query names by full name', () => {
    const docs = entityAnchorDocs('How do I de-risk the Project Harmony budget?', entities);
    expect(docs.has('deals/harmony-budget.md')).toBe(true);
    expect(docs.has('deals/harmony-competition.md')).toBe(true);
  });

  it('expands one hop: a co-occurring entity (Yamaha) pulls in its note (POC) — GraphRAG inclusion', () => {
    const docs = entityAnchorDocs('Project Harmony budget blocker', entities);
    expect(docs.has('deals/harmony-poc.md')).toBe(true); // reached via Yamaha co-occurring in competition
    expect(docs.has('globex/globex-deal.md')).toBe(false); // different deal, no cluster entity → excluded
  });

  it('anchors on a distinctive (≥4-char) word of the entity name (lowercase query)', () => {
    expect(
      entityAnchorDocs('what is the harmony budget', entities).has('deals/harmony-budget.md')
    ).toBe(true);
  });

  it('is empty when the query names no known entity (→ caller keeps everything)', () => {
    expect(entityAnchorDocs('summarize the open risks', entities).size).toBe(0);
  });

  it('does NOT cross-anchor on a generic shared name-word ("Project" in many deal names)', () => {
    const deals = [
      { name: 'Project Harmony', docIds: ['deals/harmony.md'] },
      { name: 'Project Falcon', docIds: ['acme/falcon.md'] },
      { name: 'Project Orion', docIds: ['globex/orion.md'] }
    ];
    const docs = entityAnchorDocs('how do I de-risk Project Harmony?', deals);
    expect(docs.has('deals/harmony.md')).toBe(true); // "harmony" is distinctive → anchors
    expect(docs.has('acme/falcon.md')).toBe(false); // shared "project" must NOT drag Falcon in
    expect(docs.has('globex/orion.md')).toBe(false);
  });
});

describe('restrictToEntities (exclude cross-subject noise, recall-safe)', () => {
  const hits = [
    { chunkId: 'invoice#0', docId: 'notes/beevr.md', score: 0.46 }, // another deal's invoice
    { chunkId: 'budget#0', docId: 'deals/harmony-budget.md', score: 0.58 }, // anchored
    { chunkId: 'poc#0', docId: 'deals/harmony-poc.md', score: 0.4 } // relevant but not anchored
  ];
  const anchor = new Set(['deals/harmony-budget.md', 'deals/harmony-status.md']);

  it('drops a hit whose doc is not anchored, not protected, and not a strong match', () => {
    expect(restrictToEntities(hits, anchor).map((h) => h.chunkId)).toEqual(['budget#0']);
  });

  it('protects graph-connected siblings even when their doc is not anchored', () => {
    const out = restrictToEntities(hits, anchor, { protect: new Set(['poc#0']) });
    expect(out.map((h) => h.chunkId)).toEqual(['budget#0', 'poc#0']);
  });

  it('keeps a strong standalone semantic match regardless of anchoring', () => {
    const strong = [{ chunkId: 'x#0', docId: 'notes/other.md', score: 0.72 }];
    expect(restrictToEntities(strong, anchor).map((h) => h.chunkId)).toEqual(['x#0']);
  });

  it('is a no-op when nothing anchored (query named no entity)', () => {
    expect(restrictToEntities(hits, new Set())).toHaveLength(hits.length);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical direction, 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0, 0], [2, 0, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 6);
  });
  it('returns 0 against a zero vector (no NaN)', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('rrfFuse — Σ 1/(k+rank)', () => {
  it('rewards items ranked high across lists', () => {
    const fused = rrfFuse(
      [
        ['a', 'b', 'c'],
        ['c', 'a']
      ],
      60
    );
    // a: 1/61 + 1/62 ; c: 1/63 + 1/61 ; c appears rank1 in list2 -> should beat b.
    expect(fused.get('c')!).toBeGreaterThan(fused.get('b')!);
  });
});

describe('vectorSearch — no-results relevance floor (FR-CHAT-002)', () => {
  const index: IndexedChunk[] = [
    { chunkId: 'x', docId: 'd', text: 't', charStart: 0, charEnd: 1, embedding: [0, 1] }
  ];
  it('returns [] when the best score is below the floor', () => {
    expect(vectorSearch([1, 0], index, { floor: 0.5 })).toEqual([]); // orthogonal -> 0 < 0.5
  });
  it('returns the hit when above the floor', () => {
    expect(vectorSearch([0, 1], index, { floor: 0.5 }).length).toBe(1);
  });
});

describe('wordTermScore — whole-word only (no substring false hits)', () => {
  it('counts query terms present as full words', () => {
    expect(wordTermScore('Project Harmony budget review', ['harmony', 'budget'])).toBe(2);
  });
  it('does not match inside other words ("end" must not hit "spend")', () => {
    expect(wordTermScore('we spend money', ['end'])).toBe(0);
  });
  it('is unicode-aware (Vietnamese syllables match as words)', () => {
    expect(wordTermScore('ngân sách chuyến đi', ['ngân', 'sách'])).toBe(2);
  });
});

describe('withLexicalChannel (exact-term recall top-up + rescue)', () => {
  const ctx = [
    { chunkId: 'a#0', docId: 'a.md' },
    { chunkId: 'b#0', docId: 'b.md' }
  ];
  const lex = [
    { chunkId: 'b#0', docId: 'b.md' }, // already in context → must not duplicate
    { chunkId: 'c#0', docId: 'c.md' },
    { chunkId: 'd#0', docId: 'd.md' },
    { chunkId: 'e#0', docId: 'e.md' },
    { chunkId: 'f#0', docId: 'f.md' },
    { chunkId: 'g#0', docId: 'g.md' }
  ];

  it('appends lexical hits not already present, after the existing context', () => {
    const out = withLexicalChannel(ctx, lex.slice(0, 2));
    expect(out.map((h) => h.chunkId)).toEqual(['a#0', 'b#0', 'c#0']);
  });

  it('caps the top-up so a generic term cannot flood the context', () => {
    const out = withLexicalChannel(ctx, lex, { maxAdd: 2 });
    expect(out.map((h) => h.chunkId)).toEqual(['a#0', 'b#0', 'c#0', 'd#0']);
  });

  it('RESCUES an empty context: lexical hits become the context (exact-ID case)', () => {
    const out = withLexicalChannel([], lex.slice(1, 3));
    expect(out.map((h) => h.chunkId)).toEqual(['c#0', 'd#0']);
  });

  it('is a no-op with no lexical hits (recall never regresses)', () => {
    expect(withLexicalChannel(ctx, [])).toBe(ctx);
    expect(withLexicalChannel([], [])).toEqual([]);
  });
});
