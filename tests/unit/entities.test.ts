import { describe, it, expect } from 'vitest';
import {
  buildEntityPrompt,
  parseEntityResponse,
  normalizeType,
  extractEntities,
  segmentTokens,
  mergeExtractions,
  ENTITY_INSTRUCTION
} from '../../src/lib/graph/entities';

// Entity/relation extraction via the injected generator seam — pure, no GPU.

describe('buildEntityPrompt', () => {
  it('skims only the first ~N tokens and embeds the instruction', () => {
    const text = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(' ');
    const prompt = buildEntityPrompt(text, { skimTokens: 4 });
    expect(prompt).toContain(ENTITY_INSTRUCTION);
    expect(prompt).toContain('# Document excerpt\nw0 w1 w2 w3');
    expect(prompt).not.toContain('w4');
  });
});

describe('normalizeType', () => {
  it('keeps known kinds and collapses everything else to other', () => {
    expect(normalizeType('person')).toBe('person');
    expect(normalizeType('ORG')).toBe('org');
    expect(normalizeType('Organization')).toBe('other'); // not in the fixed set
    expect(normalizeType(42)).toBe('other');
    expect(normalizeType(undefined)).toBe('other');
  });
});

describe('parseEntityResponse', () => {
  it('parses a clean object and normalizes types', () => {
    const ext = parseEntityResponse(
      '{"entities":[{"name":"John Doe","type":"Person"},{"name":"Acme","type":"org"}],"relations":[{"source":"John Doe","target":"Acme","type":"works at"}]}'
    );
    expect(ext).toEqual({
      entities: [
        { name: 'John Doe', type: 'person' },
        { name: 'Acme', type: 'org' }
      ],
      relations: [{ source: 'John Doe', target: 'Acme', type: 'works_at' }]
    });
  });

  it('tolerates code fences and surrounding prose', () => {
    const raw =
      'Sure!\n```json\n{"entities":[{"name":"X","type":"concept"}],"relations":[]}\n```\ndone';
    expect(parseEntityResponse(raw)).toEqual({
      entities: [{ name: 'X', type: 'concept' }],
      relations: []
    });
  });

  it('dedupes entities case-insensitively and drops empty names', () => {
    const ext = parseEntityResponse(
      '{"entities":[{"name":"Acme","type":"org"},{"name":"acme","type":"org"},{"name":"  ","type":"org"}],"relations":[]}'
    );
    expect(ext?.entities).toEqual([{ name: 'Acme', type: 'org' }]);
  });

  it('drops relations whose endpoints are not extracted entities, and self-loops', () => {
    const ext = parseEntityResponse(
      '{"entities":[{"name":"Acme","type":"org"},{"name":"John","type":"person"}],"relations":[{"source":"John","target":"Acme","type":"works_at"},{"source":"John","target":"Ghost","type":"knows"},{"source":"Acme","target":"Acme","type":"is"}]}'
    );
    expect(ext?.relations).toEqual([{ source: 'John', target: 'Acme', type: 'works_at' }]);
  });

  it('clamps entity and relation counts', () => {
    const entities = Array.from({ length: 50 }, (_, i) => `{"name":"E${i}","type":"concept"}`).join(
      ','
    );
    const ext = parseEntityResponse(`{"entities":[${entities}],"relations":[]}`, {
      maxEntities: 5
    });
    expect(ext?.entities).toHaveLength(5);
  });

  it('parses + clamps a relation confidence when present, omits it when absent', () => {
    const ext = parseEntityResponse(
      '{"entities":[{"name":"A","type":"org"},{"name":"B","type":"org"},{"name":"C","type":"org"}],"relations":[{"source":"A","target":"B","type":"acquired","confidence":1.4},{"source":"B","target":"C","type":"uses"}]}'
    );
    expect(ext?.relations[0]).toEqual({
      source: 'A',
      target: 'B',
      type: 'acquired',
      confidence: 1
    });
    expect(ext?.relations[1]).toEqual({ source: 'B', target: 'C', type: 'uses' }); // no confidence key
  });

  it('returns null when no JSON object can be recovered', () => {
    expect(parseEntityResponse('no json here')).toBeNull();
  });
});

describe('extractEntities', () => {
  it('degrades to no_model when no generator is wired', async () => {
    const res = await extractEntities('text', null);
    expect(res).toEqual({ ok: false, reason: 'no_model' });
  });

  it('returns the parsed extraction from a stub generator', async () => {
    const gen = async () => '{"entities":[{"name":"Acme","type":"org"}],"relations":[]}';
    const res = await extractEntities('Acme signed a deal.', gen);
    expect(res).toEqual({
      ok: true,
      extraction: { entities: [{ name: 'Acme', type: 'org' }], relations: [] }
    });
  });

  it('reports unparseable when the model returns junk', async () => {
    const res = await extractEntities('x', async () => 'I cannot do that');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unparseable');
  });

  it('reports error when the generator throws', async () => {
    const res = await extractEntities('x', async () => {
      throw new Error('boom');
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('error');
      expect(res.detail).toBe('boom');
    }
  });
});

describe('segmentTokens', () => {
  it('splits into consecutive n-token windows, capped at maxSegments', () => {
    const text = Array.from({ length: 10 }, (_, i) => `w${i}`).join(' ');
    expect(segmentTokens(text, 4, 4)).toEqual(['w0 w1 w2 w3', 'w4 w5 w6 w7', 'w8 w9']);
    expect(segmentTokens(text, 4, 2)).toEqual(['w0 w1 w2 w3', 'w4 w5 w6 w7']); // tail dropped by cap
    expect(segmentTokens('one two', 4, 4)).toEqual(['one two']); // short doc → single segment
    expect(segmentTokens('   ', 4, 4)).toEqual([]); // blank
  });
});

describe('mergeExtractions', () => {
  it('dedupes entities case-insensitively (first seen wins) and relations by triple', () => {
    const merged = mergeExtractions([
      {
        entities: [{ name: 'Acme', type: 'org' }],
        relations: [{ source: 'Acme', target: 'Beta', type: 'acquired' }]
      },
      {
        entities: [
          { name: 'acme', type: 'org' },
          { name: 'Beta', type: 'org' }
        ],
        relations: [
          { source: 'acme', target: 'beta', type: 'acquired' }, // dup triple (case-insensitive)
          { source: 'Beta', target: 'Acme', type: 'supplies' }
        ]
      }
    ]);
    expect(merged.entities).toEqual([
      { name: 'Acme', type: 'org' },
      { name: 'Beta', type: 'org' }
    ]);
    expect(merged.relations).toEqual([
      { source: 'Acme', target: 'Beta', type: 'acquired' },
      { source: 'Beta', target: 'Acme', type: 'supplies' }
    ]);
  });
});

describe('extractEntities — segmented long-doc extraction (graph recall)', () => {
  // The recall blind spot this fixes: the old single-skim pass only ever read the first
  // `skimTokens` words, so an entity introduced past that point never got a graph node and
  // GraphRAG could never expand into the note's tail.
  it('extracts entities introduced BEYOND the first skim window', async () => {
    const filler = Array.from({ length: 6 }, (_, i) => `word${i}`).join(' ');
    const text = `Acme leads here. ${filler} Zenith appears only in the tail.`;
    const prompts: string[] = [];
    const gen = async (p: string) => {
      prompts.push(p);
      // Key on the EXCERPT (after the marker), not the whole prompt — the instruction's worked
      // example literally contains "Acme", so matching the full prompt would always hit segment 1.
      const excerpt = p.slice(p.indexOf('# Document excerpt'));
      if (excerpt.includes('Zenith'))
        return '{"entities":[{"name":"Zenith","type":"org"}],"relations":[]}';
      return '{"entities":[{"name":"Acme","type":"org"}],"relations":[]}';
    };
    const res = await extractEntities(text, gen, { skimTokens: 6, maxSegments: 4 });
    expect(prompts.length).toBeGreaterThan(1); // really read more than one window
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.extraction.entities).toEqual(
        expect.arrayContaining([
          { name: 'Acme', type: 'org' },
          { name: 'Zenith', type: 'org' }
        ])
      );
    }
  });

  it('caps the number of segments (bounded LLM cost on huge docs)', async () => {
    const text = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
    let calls = 0;
    const gen = async () => {
      calls++;
      return '{"entities":[{"name":"X","type":"concept"}],"relations":[]}';
    };
    await extractEntities(text, gen, { skimTokens: 10, maxSegments: 3 });
    expect(calls).toBe(3);
  });

  it('makes a single call for a short doc (unchanged fast path)', async () => {
    let calls = 0;
    const gen = async () => {
      calls++;
      return '{"entities":[{"name":"Acme","type":"org"}],"relations":[]}';
    };
    await extractEntities('Acme signed a deal.', gen);
    expect(calls).toBe(1);
  });

  it('is best-effort per segment: one unparseable segment does not discard the others', async () => {
    const text = Array.from({ length: 12 }, (_, i) => `w${i}`).join(' ');
    let call = 0;
    const gen = async () => {
      call++;
      if (call === 1) return 'I cannot do that';
      return '{"entities":[{"name":"Tail","type":"concept"}],"relations":[]}';
    };
    const res = await extractEntities(text, gen, { skimTokens: 6, maxSegments: 2 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.extraction.entities).toEqual([{ name: 'Tail', type: 'concept' }]);
  });

  it('returns the first failure when EVERY segment fails', async () => {
    const text = Array.from({ length: 12 }, (_, i) => `w${i}`).join(' ');
    const res = await extractEntities(text, async () => 'junk', { skimTokens: 6, maxSegments: 2 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unparseable');
  });
});
