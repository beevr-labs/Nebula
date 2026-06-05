import { describe, it, expect } from 'vitest';
import {
  noteInScope,
  scopeDocIds,
  filterByScope,
  scopeLabel,
  type ScopeNote
} from '../../src/lib/retrieval/scope';

// FR-RET-004 · ALGORITHMS §19. Retrieval scope (folder / tag) — no cross-client bleed.

const NOTES: ScopeNote[] = [
  { docId: 'notes/acme/kickoff.md', tags: ['client/acme', 'meeting'] },
  { docId: 'notes/acme/pricing.md', tags: ['client/acme'] },
  { docId: 'notes/globex/sow.md', tags: ['client/globex'] },
  { docId: 'notes/personal.md', tags: [] }
];

describe('noteInScope', () => {
  it('matches a folder prefix', () => {
    expect(noteInScope(NOTES[0], { kind: 'folder', value: 'notes/acme/' })).toBe(true);
    expect(noteInScope(NOTES[2], { kind: 'folder', value: 'notes/acme/' })).toBe(false);
  });
  it('matches a tag, tolerant of # and case', () => {
    expect(noteInScope(NOTES[0], { kind: 'tag', value: '#Client/Acme' })).toBe(true);
    expect(noteInScope(NOTES[2], { kind: 'tag', value: 'client/acme' })).toBe(false);
  });
});

describe('scopeDocIds', () => {
  it('returns the in-scope docIds for a folder scope', () => {
    const ids = scopeDocIds(NOTES, { kind: 'folder', value: 'notes/acme/' });
    expect([...ids!].sort()).toEqual(['notes/acme/kickoff.md', 'notes/acme/pricing.md']);
  });
  it('returns null (whole vault) for no scope', () => {
    expect(scopeDocIds(NOTES, null)).toBeNull();
  });
});

describe('filterByScope', () => {
  const hits = [
    { docId: 'notes/acme/kickoff.md', score: 0.9 },
    { docId: 'notes/globex/sow.md', score: 0.8 }
  ];
  it('drops out-of-scope hits (no cross-client bleed)', () => {
    const ids = scopeDocIds(NOTES, { kind: 'tag', value: 'client/acme' });
    expect(filterByScope(hits, ids).map((h) => h.docId)).toEqual(['notes/acme/kickoff.md']);
  });
  it('passes everything through when scope is null', () => {
    expect(filterByScope(hits, null)).toHaveLength(2);
  });
});

describe('scopeLabel', () => {
  it('labels folder and tag scopes', () => {
    expect(scopeLabel({ kind: 'folder', value: 'notes/acme/' })).toBe('📁 notes/acme/');
    expect(scopeLabel({ kind: 'tag', value: '#Client/Acme' })).toBe('#client/acme');
  });
});
