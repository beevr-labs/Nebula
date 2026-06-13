import { describe, it, expect } from 'vitest';
import {
  assemblePrompt,
  dedupeHits,
  buildChatMessages,
  normalizeCitationMarkers,
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

describe('normalizeCitationMarkers', () => {
  it('repairs a colon-prefixed marker the model emitted (the live [:#5] bug)', () => {
    expect(normalizeCitationMarkers('The CFO is the blocker [:#5].')).toBe(
      'The CFO is the blocker [#5].'
    );
  });

  it('repairs spaced / labeled markers but leaves canonical ones untouched', () => {
    expect(normalizeCitationMarkers('a [ #3] b [#4] c [ref #2]')).toBe('a [#3] b [#4] c [#2]');
  });

  it('then parses into real citations against the context order', () => {
    const order = ['k1', 'k2', 'k3', 'k4', 'k5'];
    const { citations } = parseCitations(normalizeCitationMarkers('See [:#3] and [:#5].'), order);
    expect(citations.map((c) => c.chunkId)).toEqual(['k3', 'k5']);
  });

  it('leaves a bare [3] alone (ambiguous with footnotes / list markers)', () => {
    expect(normalizeCitationMarkers('step [3] of the plan')).toBe('step [3] of the plan');
  });

  it('is idempotent', () => {
    const once = normalizeCitationMarkers('[:#1][#2]');
    expect(normalizeCitationMarkers(once)).toBe(once);
    expect(once).toBe('[#1][#2]');
  });
});

describe('buildChatMessages (FR-CHAT-006 multi-turn)', () => {
  it('is a plain single-turn pair when there is no history', () => {
    const msgs = buildChatMessages('SYS', 'USER');
    expect(msgs).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'USER' }
    ]);
  });

  it('replays prior turns as user/assistant pairs, then the current grounded user message', () => {
    const msgs = buildChatMessages('SYS', 'CURRENT', [
      { query: 'Q1', answer: 'A1' },
      { query: 'Q2', answer: 'A2' }
    ]);
    expect(msgs.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
      'assistant',
      'user'
    ]);
    expect(msgs.map((m) => m.content)).toEqual(['SYS', 'Q1', 'A1', 'Q2', 'A2', 'CURRENT']);
  });

  it('keeps the current grounded message last so retrieval context anchors the new answer', () => {
    const msgs = buildChatMessages('SYS', 'CURRENT', [{ query: 'Q1', answer: 'A1' }]);
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: 'CURRENT' });
  });
});

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

  it('answerLanguage pins the answer language without disturbing the default (UI-locale)', () => {
    const def = assemblePrompt('When does it ship?', hits);
    const vi = assemblePrompt('When does it ship?', hits, { answerLanguage: 'Vietnamese' });
    if (def.kind === 'grounded' && vi.kind === 'grounded') {
      expect(def.system).toBe(SYSTEM_PROMPT); // omitted → unchanged (and prompt-equality tests hold)
      expect(vi.system).toContain('Vietnamese'); // directive prepended to the system prompt
      expect(vi.system).toContain('overrides every other language instruction');
      expect(vi.system.endsWith(SYSTEM_PROMPT)).toBe(true); // base prompt preserved underneath
      // and the requirement is repeated in the user turn, right before the question
      expect(vi.user).toContain('written entirely in Vietnamese');
      expect(vi.user).toContain('When does it ship?');
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

  it('truncates a single oversized lead chunk to the budget instead of overflowing the window', () => {
    // The live blank-answer cause: one note far bigger than the budget (a long transcript read
    // whole / an unsplit note) was kept verbatim and overflowed the model's context window.
    const big: SearchHit = {
      chunkId: 'big',
      docId: 'notes/long.md',
      text: Array.from({ length: 400 }, (_, i) => `word${i}`).join(' '),
      charStart: 0,
      charEnd: 0,
      score: 0.9
    };
    const r = assemblePrompt('what is in the note?', [big], { maxContextTokens: 30 });
    if (r.kind !== 'grounded') throw new Error('expected grounded');
    const words = r.user.split(/\s+/).length;
    expect(words).toBeLessThan(60); // fits the budget (+ wrapper + directive), not 400 words
    expect(r.user).toContain('word0'); // kept the START of the note
    expect(r.user).toContain('…'); // truncation marker
    expect(r.user).not.toContain('word399'); // the tail was dropped
    expect(r.contextOrder).toEqual(['big']); // still cited as the source
  });

  it('collapses near-duplicate chunks so a repetitive note cannot crowd out diverse context', () => {
    // Mimics the live failure: a repetitive transcript returns many near-identical chunks (top
    // score) plus the ONE note that actually answers the question lower down.
    const mk = (id: string, doc: string, text: string, score: number): SearchHit => ({
      chunkId: id,
      docId: doc,
      text,
      charStart: 0,
      charEnd: text.length,
      score
    });
    const repetitive = [
      mk('t1', 'notes/standup.md', 'Hôm nay tôi tiếp tục dự án Orion và trao đổi với Linh.', 0.6),
      mk('t2', 'notes/standup.md', 'Hôm nay tôi tiếp tục dự án Atlas và trao đổi với Hùng.', 0.59),
      mk(
        't3',
        'notes/standup.md',
        'Hôm nay tôi tiếp tục dự án Nebula và trao đổi với Trang.',
        0.58
      ),
      mk('ans', 'notes/clients.md', 'Dự án Orion được phát triển cho khách hàng VinGroup.', 0.55)
    ];
    const r = assemblePrompt('Orion cho khách hàng nào?', repetitive);
    if (r.kind !== 'grounded') throw new Error('expected grounded');
    // one transcript representative survives; the answer note is NOT crowded out
    expect(r.contextOrder).toContain('ans');
    expect(r.contextOrder.filter((c) => c.startsWith('t')).length).toBe(1);
    expect(r.user).toContain('VinGroup');
  });
});

describe('dedupeHits', () => {
  const mk = (id: string, text: string): SearchHit => ({
    chunkId: id,
    docId: 'd',
    text,
    charStart: 0,
    charEnd: text.length,
    score: 1
  });

  it('drops a chunk that is ≥80% word-overlap with one already kept (keeps the first)', () => {
    const out = dedupeHits([
      mk('a', 'Hôm nay tôi tiếp tục dự án Orion và trao đổi với Linh về tích hợp'),
      mk('b', 'Hôm nay tôi tiếp tục dự án Atlas và trao đổi với Linh về tích hợp')
    ]);
    expect(out.map((h) => h.chunkId)).toEqual(['a']);
  });

  it('keeps genuinely different chunks', () => {
    const out = dedupeHits([
      mk('a', 'The project ships in Q3 next year'),
      mk('b', 'The marketing budget is two million dollars')
    ]);
    expect(out.map((h) => h.chunkId)).toEqual(['a', 'b']);
  });

  it('handles Vietnamese diacritics as whole words (not shredded into ASCII letters)', () => {
    // identical save for one word → must be treated as duplicates, proving NFKC/Unicode tokenizing
    const out = dedupeHits([
      mk('a', 'Cuộc họp hội đồng diễn ra tại Hà Nội vào buổi sáng'),
      mk('b', 'Cuộc họp hội đồng diễn ra tại Huế vào buổi sáng')
    ]);
    expect(out).toHaveLength(1);
  });

  it('preserves order and is a no-op on already-distinct input', () => {
    const input = [mk('a', 'alpha one two'), mk('b', 'beta three four'), mk('c', 'gamma five six')];
    expect(dedupeHits(input)).toEqual(input);
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
