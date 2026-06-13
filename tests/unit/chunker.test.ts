import { describe, it, expect } from 'vitest';
import {
  chunk,
  assertChunkWindow,
  approxTokenCount,
  approxSizingIsSafe,
  pickChunking,
  MAX_BGE_TOKENS_PER_WORD
} from '../../src/lib/ingest/chunker';
import { EMBEDDING_MAX_TOKENS } from '../../src/lib/inference/provider';

describe('pickChunking — adaptive sizing keeps the chunk count bounded for huge notes', () => {
  it('keeps the small high-precision default for a normal note', () => {
    expect(pickChunking(5_000)).toEqual({ size: 60, overlap: 12 });
    expect(pickChunking(30_000)).toEqual({ size: 60, overlap: 12 });
  });
  it('grows the chunk size with the document, monotonically', () => {
    const sizes = [10_000, 100_000, 400_000, 2_000_000].map((n) => pickChunking(n).size);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1]);
  });
  it('every tier stays a valid, window-safe chunk size (no silent truncation)', () => {
    for (const n of [1_000, 100_000, 500_000, 2_000_000, 50_000_000]) {
      const { size, overlap } = pickChunking(n);
      expect(() => assertChunkWindow(size)).not.toThrow(); // size < EMBEDDING_MAX_TOKENS
      expect(overlap).toBeLessThan(size);
    }
  });
  it('cuts the chunk count several-fold on a ~2 MB note vs the fixed small size', () => {
    // ~2 MB of repeated prose (whitespace-counter approximation of the real reduction ratio).
    const para =
      'Ghi chú dài về dự án và ngân sách quý này với nhiều chi tiết lặp lại để mô phỏng một tài liệu lớn. ';
    const big = para.repeat(20_000); // ≈ 2 MB
    expect(big.length).toBeGreaterThan(1_500_000);

    const fixed = chunk(big, { size: 60, overlap: 12 }).length;
    const { size, overlap } = pickChunking(big.length);
    const adaptive = chunk(big, { size, overlap }).length;

    expect(adaptive).toBeLessThan(fixed / 3); // at least ~3× fewer chunks → ~3× less embed + DB work
  });
});

// FR-ING-002/003 · ALGORITHMS §1. Sized with the injected/default token counter.

describe('approxSizingIsSafe — when whitespace sizing can skip the bge tokenizer (R-1 safety)', () => {
  it('is safe for the production chunk size (60 ≪ window)', () => {
    expect(approxSizingIsSafe(60)).toBe(true);
  });
  it('uses a conservative tokens-per-word factor against the real window', () => {
    // safe iff size × factor < window
    const justSafe = Math.floor(EMBEDDING_MAX_TOKENS / MAX_BGE_TOKENS_PER_WORD) - 1;
    const tooBig = Math.ceil(EMBEDDING_MAX_TOKENS / MAX_BGE_TOKENS_PER_WORD) + 1;
    expect(approxSizingIsSafe(justSafe)).toBe(true);
    expect(approxSizingIsSafe(tooBig)).toBe(false);
  });
  it('falls back to the precise counter for large chunks that could near the window', () => {
    expect(approxSizingIsSafe(EMBEDDING_MAX_TOKENS)).toBe(false); // a chunk as big as the window
    expect(approxSizingIsSafe(2000, 8192)).toBe(false); // 2000×6 = 12000 > 8192
    expect(approxSizingIsSafe(500, 8192)).toBe(true); // 500×6 = 3000 < 8192
  });
});

describe('assertChunkWindow — FR-ING-003 / ADR-006 invariant', () => {
  it('accepts the default 500 (< 512 window)', () => {
    expect(() => assertChunkWindow(500, EMBEDDING_MAX_TOKENS)).not.toThrow();
  });
  it('rejects targetSize equal to the window (must be STRICTLY below)', () => {
    expect(() => assertChunkWindow(512, 512)).toThrow(/strictly below/);
  });
  it('rejects targetSize above the window', () => {
    expect(() => assertChunkWindow(600, 512)).toThrow(/strictly below/);
  });
  it('rejects non-positive sizes', () => {
    expect(() => assertChunkWindow(0)).toThrow();
    expect(() => assertChunkWindow(-1)).toThrow();
  });
  it('chunk() refuses to run when the window invariant is violated', () => {
    expect(() => chunk('some text', { size: 512, maxTokens: 512 })).toThrow(/strictly below/);
  });
});

describe('chunk() — packing, overlap, offsets', () => {
  // 5 sentences, 3 "words" each, separated by '. '. Default counter = word count.
  const text = 'aa bb cc. dd ee ff. gg hh ii. jj kk ll. mm nn oo.';

  it('splits on sentence boundaries with overlap (size 7 / overlap 2)', () => {
    const chunks = chunk(text, { size: 7, overlap: 2 });
    expect(chunks.length).toBe(4);
    // seq is 0..n-1 in order
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2, 3]);
  });

  it('every chunk.text equals the original slice [charStart,charEnd]', () => {
    const chunks = chunk(text, { size: 7, overlap: 2 });
    for (const c of chunks) {
      expect(c.text).toBe(text.slice(c.charStart, c.charEnd));
    }
  });

  it('covers the whole document: first starts at 0, last ends at length', () => {
    const chunks = chunk(text, { size: 7, overlap: 2 });
    expect(chunks[0].charStart).toBe(0);
    expect(chunks[chunks.length - 1].charEnd).toBe(text.length);
  });

  it('consecutive chunks overlap in character space', () => {
    const chunks = chunk(text, { size: 7, overlap: 2 });
    // chunk[1] begins inside chunk[0] (carried tail sentence).
    expect(chunks[1].charStart).toBeLessThan(chunks[0].charEnd);
    expect(chunks[1].charStart).toBeGreaterThanOrEqual(chunks[0].charStart);
  });

  it('keeps each chunk within the target size (in counter units)', () => {
    const chunks = chunk(text, { size: 7, overlap: 2 });
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(7);
      expect(c.tokenCount).toBe(approxTokenCount(c.text));
    }
  });

  it('prefers paragraph (\\n\\n) separators over sentence splits', () => {
    const paras = ['alpha beta gamma', 'delta epsilon zeta', 'eta theta iota'].join('\n\n');
    const chunks = chunk(paras, { size: 3, overlap: 0 });
    expect(chunks.length).toBe(3);
    expect(chunks[0].text).toContain('alpha');
    expect(chunks[1].text).toContain('delta');
  });
});

describe('chunk() — page mapping + edge cases', () => {
  it('returns [] for empty input', () => {
    expect(chunk('', {})).toEqual([]);
  });

  it('annotates page via pageForOffset', () => {
    const text = 'aa bb cc. dd ee ff. gg hh ii.';
    const pageForOffset = (start: number) => (start < 10 ? 1 : 2);
    const chunks = chunk(text, { size: 7, overlap: 0, pageForOffset });
    expect(chunks[0].page).toBe(1);
    expect(chunks[chunks.length - 1].page).toBe(2);
  });

  it('respects an injected token counter (e.g. the real bge tokenizer)', () => {
    // Counter that treats every character as a token → forces tiny chunks.
    // (Splitting is separator-bounded per ALGORITHMS §1, so the input has spaces.)
    const charCounter = (s: string) => s.length;
    const chunks = chunk('aa bb cc dd ee', { size: 4, overlap: 0, countTokens: charCounter });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(4);
  });
});
