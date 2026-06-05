// Real embedder — `bge-m3` (multilingual, ADR-021) via @huggingface/transformers (FR-ING-004,
// ALGORITHMS §2). Produces 1024-dim, CLS-pooled, L2-normalized float vectors. Runs on the ONNX
// runtime: WebGPU when available, else WASM/CPU — which is why semantic search still works on the
// degraded tier (FR-CAP-002) and headless in Node (no GPU required). The model is downloaded q8-
// quantized to keep the in-browser fetch reasonable.
//
// In the app this runs in a Worker (NFR-PERF-004); the logic is identical in Node tests.

import {
  pipeline,
  AutoTokenizer,
  type FeatureExtractionPipeline,
  type PreTrainedTokenizer
} from '@huggingface/transformers';
import { EMBEDDING_MODEL, EMBEDDING_DIM, EMBEDDING_MAX_TOKENS } from '$lib/inference/provider';
import type { TokenCounter } from '$lib/ingest/chunker';

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;
let tokenizerPromise: Promise<PreTrainedTokenizer> | null = null;

export function getEmbedder(): Promise<FeatureExtractionPipeline> {
  // WASM/CPU q8. We tried the WebGPU EP for bge-m3 (XLM-RoBERTa) but its first inference hung
  // (shader-compile pathology on this op set), so the UI is kept off the embed thread via the
  // embed Worker (embed.worker.ts) instead — that fixes the freeze without the GPU hang (ADR-023).
  return (extractorPromise ??= pipeline('feature-extraction', EMBEDDING_MODEL, {
    dtype: 'q8'
  }) as unknown as Promise<FeatureExtractionPipeline>);
}

export function getTokenizer(): Promise<PreTrainedTokenizer> {
  return (tokenizerPromise ??= AutoTokenizer.from_pretrained(EMBEDDING_MODEL));
}

/** Embed a single string → 1024-dim CLS-pooled, normalized vector (bge-m3). */
export async function embed(text: string): Promise<number[]> {
  const extractor = await getEmbedder();
  const out = await extractor(text, { pooling: 'cls', normalize: true });
  const vec = Array.from(out.data as Float32Array);
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(`Embedding dim mismatch: expected ${EMBEDDING_DIM}, got ${vec.length}`);
  }
  return vec;
}

/** Embed many strings in one pass (amortizes model overhead, FR-CAP-003 batch guard). */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getEmbedder();
  const out = await extractor(texts, { pooling: 'cls', normalize: true });
  const dims = out.dims;
  const dim = dims[dims.length - 1];
  const data = out.data as Float32Array;
  const rows: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    rows.push(Array.from(data.subarray(i * dim, (i + 1) * dim)));
  }
  return rows;
}

/**
 * Build the SYNC bge token counter the chunker needs (loads the tokenizer once).
 * Injecting this into `chunk()` makes chunk sizing use the SAME tokenizer that embeds,
 * which is what actually closes the R-1 silent-truncation risk (ADR-006).
 */
export async function makeBgeTokenCounter(): Promise<TokenCounter> {
  const tokenizer = await getTokenizer();
  return (text: string) => tokenizer.encode(text).length;
}

export { EMBEDDING_DIM, EMBEDDING_MAX_TOKENS };
