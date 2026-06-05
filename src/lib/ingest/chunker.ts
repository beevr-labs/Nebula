// Recursive, separator-aware chunking — FR-ING-002/003 · ALGORITHMS §1.
//
// Pure & deterministic (ALGORITHMS §7): unit-testable without a GPU, DB, or network.
//
// TOKEN SIZING: chunks must be sized with the SAME tokenizer that embeds them
// (the bge-small tokenizer), or a "500-token" chunk could exceed the 512-token
// window and be silently truncated — the R-1 class bug (ADR-006). The real bge
// tokenizer needs the model (network/Worker), so it is INJECTED as `countTokens`
// and wired in the embedder slice. The default heuristic below is a placeholder
// for offline/unit use only; production passes the bge counter.

import { EMBEDDING_MAX_TOKENS } from '$lib/inference/provider';

export interface Chunk {
  seq: number;
  text: string;
  tokenCount: number;
  page?: number;
  charStart: number;
  charEnd: number;
}

export type TokenCounter = (text: string) => number;

export interface ChunkOptions {
  size?: number; // target tokens per chunk (default 500, FR-ING-003)
  overlap?: number; // overlap tokens carried across boundaries (default 50)
  maxTokens?: number; // embedding window; targetSize must be strictly below this
  countTokens?: TokenCounter; // inject the bge tokenizer in production
  pageForOffset?: (charStart: number) => number | undefined; // PDF page mapping (parser-supplied)
}

/** Placeholder offline counter (whitespace words). Production injects the bge tokenizer. */
export function approxTokenCount(text: string): number {
  const t = text.trim();
  return t.length === 0 ? 0 : t.split(/\s+/).length;
}

/**
 * Startup invariant (FR-ING-003 / ADR-006): targetSize MUST stay strictly below
 * the embedding model's context window, or the embedder truncates silently.
 * Throws with a clear, actionable message — never truncates.
 */
export function assertChunkWindow(size: number, maxTokens: number = EMBEDDING_MAX_TOKENS): void {
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`Invalid chunk targetSize ${size}: must be a positive integer.`);
  }
  if (size >= maxTokens) {
    throw new Error(
      `Invalid chunk targetSize ${size}: must be strictly below the embedding window (${maxTokens}). ` +
        `Reduce targetSize or change the embedding model (ADR-006). Refusing to run to avoid silent truncation.`
    );
  }
}

const SEPARATORS = ['\n## ', '\n\n', '\n', '. ', ' '];

interface Segment {
  text: string;
  charStart: number;
  charEnd: number;
}

/** Split on `sep`, keeping the separator attached to the left piece so offsets stay contiguous. */
function splitKeepSeparator(text: string, sep: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = text.indexOf(sep, i);
    if (idx === -1) {
      parts.push(text.slice(i));
      break;
    }
    parts.push(text.slice(i, idx + sep.length));
    i = idx + sep.length;
  }
  return parts.filter((p) => p.length > 0);
}

/** Recursively split into contiguous segments, escalating separators until each fits `size`. */
function recursiveSplit(
  text: string,
  startOffset: number,
  sepIndex: number,
  size: number,
  count: TokenCounter
): Segment[] {
  if (sepIndex >= SEPARATORS.length || count(text) <= size) {
    return [{ text, charStart: startOffset, charEnd: startOffset + text.length }];
  }
  const sep = SEPARATORS[sepIndex];
  if (!text.includes(sep)) {
    return recursiveSplit(text, startOffset, sepIndex + 1, size, count);
  }
  const out: Segment[] = [];
  let offset = startOffset;
  for (const part of splitKeepSeparator(text, sep)) {
    if (count(part) > size) {
      out.push(...recursiveSplit(part, offset, sepIndex + 1, size, count));
    } else {
      out.push({ text: part, charStart: offset, charEnd: offset + part.length });
    }
    offset += part.length;
  }
  return out;
}

/** Trailing segments whose token sum approximates `overlap`, to seed the next chunk. */
function overlapTail(segs: Segment[], overlap: number, count: TokenCounter): Segment[] {
  if (segs.length <= 1 || overlap <= 0) return []; // never repeat a lone (possibly huge) segment
  const tail: Segment[] = [];
  let t = 0;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (t >= overlap) break;
    tail.unshift(segs[i]);
    t += count(segs[i].text);
  }
  // Don't let the overlap swallow the entire chunk.
  if (tail.length >= segs.length) tail.shift();
  return tail;
}

/**
 * Split `text` into retrieval-sized chunks (default 500 tokens / 50 overlap).
 * Records charStart/charEnd (and page when a mapping is provided) so citations
 * can scroll/highlight the exact span (FR-CHAT-003).
 */
export function chunk(text: string, options: ChunkOptions = {}): Chunk[] {
  const size = options.size ?? 500;
  const overlap = options.overlap ?? 50;
  const maxTokens = options.maxTokens ?? EMBEDDING_MAX_TOKENS;
  // Memoize the tokenizer per chunk() call: recursiveSplit + overlap + emit re-count the SAME
  // substrings many times (≈10× the doc with the real bge tokenizer — a UI-freezing cost on long
  // notes). The cache makes repeats O(1); results are identical (pure), GC'd when chunk() returns.
  const raw = options.countTokens ?? approxTokenCount;
  const memo = new Map<string, number>();
  const count: TokenCounter = (t) => {
    let v = memo.get(t);
    if (v === undefined) {
      v = raw(t);
      memo.set(t, v);
    }
    return v;
  };

  assertChunkWindow(size, maxTokens);
  if (overlap >= size) {
    throw new Error(`Invalid overlap ${overlap}: must be smaller than targetSize ${size}.`);
  }
  if (text.length === 0) return [];

  const segments = recursiveSplit(text, 0, 0, size, count);

  const chunks: Chunk[] = [];
  let cur: Segment[] = [];
  let curTokens = 0;
  let seq = 0;

  const emit = () => {
    if (cur.length === 0) return;
    const charStart = cur[0].charStart;
    const charEnd = cur[cur.length - 1].charEnd;
    const chunkText = text.slice(charStart, charEnd);
    chunks.push({
      seq: seq++,
      text: chunkText,
      tokenCount: count(chunkText),
      page: options.pageForOffset?.(charStart),
      charStart,
      charEnd
    });
  };

  for (const seg of segments) {
    const segTokens = count(seg.text);
    if (curTokens + segTokens > size && cur.length > 0) {
      emit();
      cur = overlapTail(cur, overlap, count);
      curTokens = cur.reduce((s, x) => s + count(x.text), 0);
    }
    cur.push(seg);
    curTokens += segTokens;
  }
  emit();

  return chunks;
}
