import { describe, it, expect } from 'vitest';
import {
  buildEntityPrompt,
  parseEntityResponse,
  normalizeType,
  extractEntities,
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
