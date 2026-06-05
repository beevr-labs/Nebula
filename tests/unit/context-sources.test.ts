import { describe, it, expect } from 'vitest';
import { sourcesFromNotes, sourcesFromHits, parseRedactions } from '../../src/lib/context/sources';
import { compile } from '../../src/lib/context/compiler';

// FR-CTX-001 · ALGORITHMS §5. Assemble Compiler sources from notes / hits.

describe('sourcesFromNotes', () => {
  it('makes one source per note, whole body as a single chunk', () => {
    const s = sourcesFromNotes([{ docId: 'notes/a.md', text: 'Body A', hash: 'sha256:aa' }]);
    expect(s).toEqual([
      {
        docId: 'notes/a.md',
        path: 'notes/a.md',
        hash: 'sha256:aa',
        chunks: [{ seq: 0, text: 'Body A' }]
      }
    ]);
  });
});

describe('sourcesFromHits', () => {
  it('groups hits by doc and derives seq from chunkId', () => {
    const s = sourcesFromHits(
      [
        { chunkId: 'notes/a.md#1', docId: 'notes/a.md', text: 'chunk one', page: 2 },
        { chunkId: 'notes/a.md#0', docId: 'notes/a.md', text: 'chunk zero' },
        { chunkId: 'notes/b.md#0', docId: 'notes/b.md', text: 'b zero' }
      ],
      (doc) => (doc === 'notes/a.md' ? 'sha256:aa' : 'sha256:bb')
    );
    expect(s).toHaveLength(2);
    const a = s.find((x) => x.docId === 'notes/a.md')!;
    expect(a.hash).toBe('sha256:aa');
    expect(a.chunks.map((c) => c.seq).sort()).toEqual([0, 1]);
  });

  it('feeds the real compiler to produce a deterministic, token-counted payload', () => {
    const sources = sourcesFromHits([
      {
        chunkId: 'notes/acme/pricing.md#0',
        docId: 'notes/acme/pricing.md',
        text: 'Q3 price is $9k'
      }
    ]);
    const r = compile({ sources, targetModel: 'claude-sonnet' });
    expect(r.xml).toContain('<context');
    expect(r.xml).toContain('Q3 price is $9k');
    expect(r.manifest.tokenCount).toBeGreaterThan(0);
    expect(r.manifest.tokenizer).toBe('cl100k_base');
  });
});

describe('parseRedactions', () => {
  it('splits a comma/newline list into patterns; applied by the compiler', () => {
    expect(parseRedactions('Acme, John Doe\n555-1234')).toEqual([
      { pattern: 'Acme' },
      { pattern: 'John Doe' },
      { pattern: '555-1234' }
    ]);
    const r = compile({
      sources: sourcesFromNotes([{ docId: 'notes/x.md', text: 'Client Acme pays John Doe' }]),
      targetModel: 'gpt-4o',
      redactions: parseRedactions('Acme, John Doe')
    });
    expect(r.xml).not.toContain('Acme');
    expect(r.xml).not.toContain('John Doe');
    expect(r.xml).toContain('[REDACTED]');
  });
});
