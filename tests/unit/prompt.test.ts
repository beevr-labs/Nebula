import { describe, it, expect } from 'vitest';
import {
  assemblePrompt,
  parseCitations,
  stripPromptEcho,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_REASON,
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
      expect(r.user).toContain('Notes:');
      expect(r.user).toContain('[#1] (source: notes/a.md, p.1)');
      // question is embedded in a directive sentence (no `# Question` header → no echo)
      expect(r.user).toContain('answer this question in plain language');
      expect(r.user).toContain('When does it ship?');
      expect(r.user).not.toContain('# Question');
      expect(r.contextOrder).toEqual(['k1', 'k2']);
    }
  });

  it('reason mode swaps in the reasoning system prompt + directive (FR-CHAT-005)', () => {
    const grounded = assemblePrompt('How should we plan Q3?', hits); // default
    const reason = assemblePrompt('How should we plan Q3?', hits, { mode: 'reason' });
    if (grounded.kind === 'grounded' && reason.kind === 'grounded') {
      expect(grounded.system).toBe(SYSTEM_PROMPT);
      expect(reason.system).toBe(SYSTEM_PROMPT_REASON);
      expect(reason.user).toContain('reason and apply your knowledge');
      expect(reason.user).not.toContain('Using only these notes');
      // both still carry the same numbered context + cite the same chunks
      expect(reason.contextOrder).toEqual(['k1', 'k2']);
      expect(reason.user).toContain('[#1] (source: notes/a.md, p.1)');
    }
  });

  it('no-results guard: grounded + empty hits → no model call (no fabrication)', () => {
    const r = assemblePrompt('anything', [], { mode: 'grounded' });
    expect(r).toEqual({ kind: 'no_results', message: NO_RESULTS_MESSAGE });
    expect(assemblePrompt('anything', [])).toEqual(r); // grounded is the default
  });

  it('reason + empty hits → answers from general knowledge, no notes scaffold (FR-CHAT-005)', () => {
    const r = assemblePrompt('how many stars are in the solar system?', [], { mode: 'reason' });
    expect(r.kind).toBe('grounded'); // a real model call, NOT a no-results refusal
    if (r.kind === 'grounded') {
      expect(r.system).toBe(SYSTEM_PROMPT_REASON);
      expect(r.user).not.toContain('Notes:'); // no empty notes scaffold
      expect(r.user).toContain('using your own knowledge');
      expect(r.user).toContain('how many stars are in the solar system?');
      expect(r.contextOrder).toEqual([]);
    }
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

describe('stripPromptEcho', () => {
  it('strips an echoed "# Question … # Answer …" lead-in (the small-model echo bug)', () => {
    const echoed = '# Question\nhôm nay có gì không\n# Answer\nHôm nay khách đã gửi mail. [#1]';
    expect(stripPromptEcho(echoed)).toBe('Hôm nay khách đã gửi mail. [#1]');
  });

  it('strips a leading "Question:" / "Notes:" echo', () => {
    expect(stripPromptEcho('Question: when ships?\nIt ships in Q3 [#1]')).toBe(
      'It ships in Q3 [#1]'
    );
  });

  it('leaves a clean answer untouched (idempotent)', () => {
    const clean = 'It ships in Q3 [#1].';
    expect(stripPromptEcho(clean)).toBe(clean);
    expect(stripPromptEcho(stripPromptEcho(clean))).toBe(clean);
  });
});
