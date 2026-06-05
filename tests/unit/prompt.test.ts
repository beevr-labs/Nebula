import { describe, it, expect } from 'vitest';
import {
  assemblePrompt,
  parseCitations,
  SYSTEM_PROMPT,
  NO_RESULTS_MESSAGE
} from '../../src/lib/chat/prompt';
import type { SearchHit } from '../../src/lib/inference/provider';

// FR-CHAT-002/003 · PROMPTS §1.

const hits: SearchHit[] = [
  {
    chunkId: 'k1',
    docId: 'notes/a.md',
    text: 'Project ships in Q3.',
    page: 1,
    charStart: 0,
    charEnd: 20,
    score: 0.9
  },
  {
    chunkId: 'k2',
    docId: 'notes/b.md',
    text: 'Budget is 2M.',
    page: 2,
    charStart: 0,
    charEnd: 13,
    score: 0.6
  }
];

describe('assemblePrompt', () => {
  it('builds a grounded prompt with numbered context and the question', () => {
    const r = assemblePrompt('When does it ship?', hits);
    expect(r.kind).toBe('grounded');
    if (r.kind === 'grounded') {
      expect(r.system).toBe(SYSTEM_PROMPT);
      expect(r.user).toContain('# Context');
      expect(r.user).toContain('[#1] (source: notes/a.md, p.1)');
      expect(r.user).toContain('# Question\nWhen does it ship?');
      expect(r.contextOrder).toEqual(['k1', 'k2']);
    }
  });

  it('no-results guard: empty hits → no model call (no fabrication)', () => {
    const r = assemblePrompt('anything', []);
    expect(r).toEqual({ kind: 'no_results', message: NO_RESULTS_MESSAGE });
  });

  it('context budget drops lowest-scoring chunks first, keeping at least one', () => {
    const r = assemblePrompt('q', hits, { maxContextTokens: 1, countTokens: (s) => s.length });
    if (r.kind === 'grounded') {
      expect(r.contextOrder).toEqual(['k1']); // highest-scoring kept; k2 dropped
    } else {
      throw new Error('expected grounded');
    }
  });
});

describe('parseCitations', () => {
  it('maps [#n] → chunkId with answer spans', () => {
    const answer = 'It ships in Q3 [#1] within budget [#2].';
    const { citations, dropped } = parseCitations(answer, ['k1', 'k2']);
    expect(dropped).toBe(0);
    expect(citations.map((c) => c.chunkId)).toEqual(['k1', 'k2']);
    // span points at the marker text
    const [s, e] = citations[0].spanInAnswer;
    expect(answer.slice(s, e)).toBe('[#1]');
  });

  it('drops markers with no matching context chunk (never a live citation)', () => {
    const { citations, dropped } = parseCitations('out of range [#5]', ['k1']);
    expect(citations).toEqual([]);
    expect(dropped).toBe(1);
  });
});
