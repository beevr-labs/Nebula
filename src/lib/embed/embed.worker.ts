/// <reference lib="webworker" />
// Embedding Worker (NFR-PERF-004, ADR-023) — owns the tokenizer + embedder and does ALL chunking
// and embedding off the main thread, so indexing a long note never freezes the UI. The main thread
// only sends text and upserts the returned vectors into SurrealDB. Messages are correlated by `id`;
// `indexText` streams `progress` then a final `ok` result.

import { chunk, type Chunk } from '../ingest/chunker';
import { embed, embedBatch, makeBgeTokenCounter } from './embedder';

type Req =
  | { id: number; type: 'embedQuery'; payload: { text: string } }
  | {
      id: number;
      type: 'indexText';
      payload: { text: string; size: number; overlap: number };
    };

export interface EmbeddedChunk {
  chunk: Chunk;
  embedding: number[];
}

const EMBED_BATCH = 16;
let countTokens: ((t: string) => number) | null = null;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (e: MessageEvent<Req>) => {
  const { id, type, payload } = e.data;
  try {
    if (type === 'embedQuery') {
      const result = await embed(payload.text);
      ctx.postMessage({ id, ok: true, result });
      return;
    }
    // indexText: chunk (in-worker tokenizer) → embed in batches, streaming progress.
    if (!countTokens) countTokens = await makeBgeTokenCounter();
    const cs = chunk(payload.text, {
      size: payload.size,
      overlap: payload.overlap,
      countTokens
    });
    ctx.postMessage({ id, progress: { done: 0, total: cs.length } });
    const out: EmbeddedChunk[] = [];
    for (let i = 0; i < cs.length; i += EMBED_BATCH) {
      const slice = cs.slice(i, i + EMBED_BATCH);
      const vecs = await embedBatch(slice.map((c) => c.text));
      for (let j = 0; j < slice.length; j++) out.push({ chunk: slice[j], embedding: vecs[j] });
      ctx.postMessage({
        id,
        progress: { done: Math.min(i + EMBED_BATCH, cs.length), total: cs.length }
      });
    }
    ctx.postMessage({ id, ok: true, result: out });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
