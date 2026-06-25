/// <reference lib="webworker" />
// Embedding Worker (NFR-PERF-004, ADR-023) — owns the tokenizer + embedder and does ALL chunking
// and embedding off the main thread, so indexing a long note never freezes the UI. The main thread
// only sends text and upserts the returned vectors into SurrealDB. Messages are correlated by `id`;
// `indexText` streams `progress` then a final `ok` result.

import { chunk, approxSizingIsSafe, type Chunk } from '../ingest/chunker';
import { headingIndex, sectionAt, docTitleOf, buildEmbedText } from '../ingest/embed-text';
import { embed, embedBatch, makeBgeTokenCounter, getEmbedder, embedInfo } from './embedder';

type Req =
  | { id: number; type: 'embedQuery'; payload: { text: string } }
  | {
      id: number;
      type: 'indexText';
      payload: { text: string; size: number; overlap: number };
    }
  | { id: number; type: 'embedInfo'; payload: Record<string, never> };

export interface EmbedBackendInfo {
  device: '' | 'webgpu' | 'cpu';
  chunksPerSec: number; // measured on a small warm batch — the real per-machine embedding speed
}

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
    // Report the embedder backend + a measured throughput, so the UI can tell the user whether their
    // machine is on the GPU (fast) or silently fell back to CPU (~15× slower). Cheap: 32 short chunks.
    if (type === 'embedInfo') {
      await getEmbedder();
      // ~60-token probe chunks (so chunksPerSec reflects REAL indexing speed — embedding cost scales
      // with tokens). 96 chunks past a 16-chunk warm amortizes per-call overhead for a steady number.
      const N = 96;
      const probe = Array.from({ length: N + 16 }, (_, i) =>
        Array.from({ length: 60 }, (_, j) => `nội${(i + j) % 9} word${j}`).join(' ')
      );
      await embedBatch(probe.slice(0, 16)); // warm
      const t0 = performance.now();
      for (let i = 16; i < probe.length; i += 16) await embedBatch(probe.slice(i, i + 16));
      const chunksPerSec = Math.round(N / ((performance.now() - t0) / 1000));
      const result: EmbedBackendInfo = { device: embedInfo.device, chunksPerSec };
      ctx.postMessage({ id, ok: true, result });
      return;
    }
    if (type === 'embedQuery') {
      const result = await embed(payload.text);
      ctx.postMessage({ id, ok: true, result });
      return;
    }
    // indexText: chunk → embed in batches, streaming progress.
    // Size with the cheap whitespace counter when the target size is far below the embed window
    // (approxSizingIsSafe) — that skips LOADING the bge tokenizer AND the hundreds of per-segment
    // WASM encode() calls a long note triggers, which (now that embedding runs on the GPU) were a
    // big share of long-note indexing time. The precise bge tokenizer is only loaded for large
    // chunks that could near the window (R-1 truncation safety, ADR-006).
    let sizer: ((t: string) => number) | undefined;
    if (!approxSizingIsSafe(payload.size)) {
      if (!countTokens) countTokens = await makeBgeTokenCounter();
      sizer = countTokens;
    }
    const cs = chunk(payload.text, {
      size: payload.size,
      overlap: payload.overlap,
      countTokens: sizer // undefined → chunker's whitespace approxTokenCount (no tokenizer needed)
    });
    ctx.postMessage({ id, progress: { done: 0, total: cs.length } });
    // Embed a CONTEXTUALIZED, structure-stripped view of each chunk (embed-text.ts): "Note title ›
    // Section" prefix + markdown/table noise removed. The chunk's stored `.text` stays verbatim, so
    // citations (charStart/charEnd) and the lexical channel are untouched — only the vector changes.
    const headings = headingIndex(payload.text);
    const docTitle = docTitleOf(headings);
    const out: EmbeddedChunk[] = [];
    for (let i = 0; i < cs.length; i += EMBED_BATCH) {
      const slice = cs.slice(i, i + EMBED_BATCH);
      const vecs = await embedBatch(
        slice.map((c) =>
          buildEmbedText({ docTitle, section: sectionAt(headings, c.charStart), body: c.text })
        )
      );
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
