import { describe, it, expect } from 'vitest';
import { canonicalId, resolveExtraction } from '../../src/lib/graph/resolve';
import type { Extraction } from '../../src/lib/graph/entities';

describe('canonicalId', () => {
  it('normalizes casing, whitespace, and punctuation to a stable record-id-safe key', () => {
    expect(canonicalId('John Doe')).toBe('john_doe');
    expect(canonicalId('  ACME,  Inc. ')).toBe('acme_inc');
    expect(canonicalId('Q3 Renewal!')).toBe('q3_renewal');
  });

  it('preserves Unicode letters (Vietnamese names keep diacritics, not ASCII-mangled)', () => {
    expect(canonicalId('Nguyễn Văn A')).toBe('nguyễn_văn_a');
  });

  it('returns empty when nothing survives normalization', () => {
    expect(canonicalId('  ...  ')).toBe('');
  });
});

describe('resolveExtraction', () => {
  it('merges surface-form duplicates into one node with unioned aliases', () => {
    const ext: Extraction = {
      entities: [
        { name: 'Acme', type: 'org' },
        { name: 'ACME', type: 'org' },
        { name: 'acme', type: 'org' }
      ],
      relations: []
    };
    const g = resolveExtraction(ext);
    expect(g.entities).toHaveLength(1);
    expect(g.entities[0].id).toBe('acme');
    expect(g.entities[0].name).toBe('ACME'); // prefers the form with more capitalization
    expect(g.entities[0].aliases.sort()).toEqual(['ACME', 'Acme', 'acme']);
  });

  it('drops pronoun / generic-referent "entities" and any relation touching them (graph-bridge noise)', () => {
    const ext: Extraction = {
      entities: [
        { name: 'I', type: 'person' }, // pronoun the model wrongly emitted
        { name: 'we', type: 'org' },
        { name: 'Akira Tanaka', type: 'person' },
        { name: 'Project Harmony', type: 'project' }
      ],
      relations: [
        { source: 'I', target: 'Project Harmony', type: 'mentions' }, // junk endpoint → dropped
        { source: 'Akira Tanaka', target: 'Project Harmony', type: 'champions' }
      ]
    };
    const g = resolveExtraction(ext);
    expect(g.entities.map((e) => e.id).sort()).toEqual(['akira_tanaka', 'project_harmony']);
    expect(g.relations).toEqual([
      { sourceId: 'akira_tanaka', targetId: 'project_harmony', type: 'champions' }
    ]);
  });

  it('rewrites relation endpoints to canonical ids', () => {
    const ext: Extraction = {
      entities: [
        { name: 'John Doe', type: 'person' },
        { name: 'Acme', type: 'org' }
      ],
      relations: [{ source: 'john doe', target: 'ACME', type: 'works_at' }]
    };
    const g = resolveExtraction(ext);
    expect(g.relations).toEqual([{ sourceId: 'john_doe', targetId: 'acme', type: 'works_at' }]);
  });

  it('drops relations to unknown entities and self-loops after normalization', () => {
    const ext: Extraction = {
      entities: [
        { name: 'Acme', type: 'org' },
        { name: 'ACME', type: 'org' }
      ],
      relations: [
        { source: 'Acme', target: 'ACME', type: 'is' }, // same canonical id → self-loop
        { source: 'Acme', target: 'Ghost', type: 'knows' } // unknown endpoint
      ]
    };
    const g = resolveExtraction(ext);
    expect(g.relations).toEqual([]);
  });

  it('dedupes identical relations', () => {
    const ext: Extraction = {
      entities: [
        { name: 'A', type: 'concept' },
        { name: 'B', type: 'concept' }
      ],
      relations: [
        { source: 'A', target: 'B', type: 'rel' },
        { source: 'A', target: 'B', type: 'rel' }
      ]
    };
    expect(resolveExtraction(ext).relations).toHaveLength(1);
  });
});
