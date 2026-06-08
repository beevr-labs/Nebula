import { describe, it, expect } from 'vitest';
import { parseRefs, resolveRefs, resolvePastedAnswer } from '../../src/lib/context/roundtrip';

// CE4 — round-trip (FR-CTX-010 · ALGORITHMS §5). Resolve a pasted frontier-model answer's
// [path#seq] / [#n] citations back to vault chunkIds for Magic Jump. Pure.

const known = ['notes/budget.md', 'deals/atlas.md'];

describe('parseRefs', () => {
  it('parses [path#seq] markers with path, seq, and span', () => {
    const refs = parseRefs('The budget is blocked [notes/budget.md#0] per finance.');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: 'path', path: 'notes/budget.md', seq: 0 });
    expect('[notes/budget.md#0]').toBe(
      'The budget is blocked [notes/budget.md#0] per finance.'.slice(
        refs[0].span[0],
        refs[0].span[1]
      )
    );
  });

  it('distinguishes [#n] index markers from [path#seq]', () => {
    const refs = parseRefs('See [#2] and [deals/atlas.md#3].');
    expect(refs.map((r) => r.kind)).toEqual(['index', 'path']); // sorted by position
    expect(refs[0].index).toBe(2);
    expect(refs[1]).toMatchObject({ path: 'deals/atlas.md', seq: 3 });
  });

  it('returns refs in document order', () => {
    const refs = parseRefs('a [deals/atlas.md#1] b [notes/budget.md#0] c');
    expect(refs.map((r) => r.path)).toEqual(['deals/atlas.md', 'notes/budget.md']);
  });
});

describe('resolveRefs', () => {
  it('resolves a known path#seq to its chunkId', () => {
    const [r] = resolveRefs(parseRefs('[notes/budget.md#2]'), known);
    expect(r.resolved).toBe(true);
    expect(r.chunkId).toBe('notes/budget.md#2');
    expect(r.docId).toBe('notes/budget.md');
  });

  it('keeps an unknown path as unresolved (not silently dropped)', () => {
    const [r] = resolveRefs(parseRefs('[ghost/missing.md#0]'), known);
    expect(r.resolved).toBe(false);
    expect(r.chunkId).toBeNull();
  });

  it('resolves [#n] via contextOrder, like local-chat citations', () => {
    const order = ['notes/budget.md#0', 'deals/atlas.md#1'];
    const [r] = resolveRefs(parseRefs('per the note [#2]'), known, order);
    expect(r.chunkId).toBe('deals/atlas.md#1');
    expect(r.docId).toBe('deals/atlas.md');
  });
});

describe('resolvePastedAnswer', () => {
  it('returns distinct resolved chunkIds in document order', () => {
    const answer =
      'Budget blocked [notes/budget.md#0]; rival undercut [deals/atlas.md#1]; budget again [notes/budget.md#0].';
    const { chunkIds } = resolvePastedAnswer(answer, known);
    expect(chunkIds).toEqual(['notes/budget.md#0', 'deals/atlas.md#1']); // deduped
  });
});
