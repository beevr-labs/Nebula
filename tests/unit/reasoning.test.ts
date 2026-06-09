import { describe, it, expect } from 'vitest';
import { splitReasoning } from '../../src/lib/chat/reasoning';

describe('splitReasoning', () => {
  it('returns the text unchanged when there is no reasoning block', () => {
    expect(splitReasoning('Just the answer.')).toEqual({
      reasoning: '',
      content: 'Just the answer.'
    });
  });

  it('extracts a closed <think> block and keeps only the answer as content', () => {
    const r = splitReasoning(
      '<think>Let me work it out: 700+500=1200.</think>\n\nThe total is **$1900**.'
    );
    expect(r.reasoning).toBe('Let me work it out: 700+500=1200.');
    expect(r.content).toBe('The total is **$1900**.');
  });

  it('treats an unterminated <think> as still-streaming reasoning (no content yet)', () => {
    const r = splitReasoning('<think>Okay, the user is asking for the budget');
    expect(r.reasoning).toBe('Okay, the user is asking for the budget');
    expect(r.content).toBe('');
  });

  it('tolerates the <thinking> variant', () => {
    const r = splitReasoning('<thinking>reasoning here</thinking>Answer.');
    expect(r.reasoning).toBe('reasoning here');
    expect(r.content).toBe('Answer.');
  });

  it('concatenates multiple closed blocks and strips them all from content', () => {
    const r = splitReasoning('<think>a</think>One. <think>b</think>Two.');
    expect(r.reasoning).toBe('ab');
    expect(r.content).toBe('One. Two.');
  });

  it('is empty-safe', () => {
    expect(splitReasoning('')).toEqual({ reasoning: '', content: '' });
  });
});
