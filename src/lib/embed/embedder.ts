// Real embedder — `paraphrase-multilingual-MiniLM-L12-v2` (multilingual) via @huggingface/transformers
// (FR-ING-004, ALGORITHMS §2). Produces 384-dim, MEAN-pooled, L2-normalized float vectors. Runs on the
// ONNX runtime: WebGPU when available, else WASM/CPU — which is why semantic search still works on the
// degraded tier (FR-CAP-002) and headless in Node (no GPU required). Switched from bge-m3 for ~1.9×
// faster embedding at matched Vietnamese retrieval quality (measured head-to-head).
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

/** The backend the embedder actually loaded on — surfaced in the UI so a user can SEE whether their
 *  machine is using the GPU (fast) or silently fell back to CPU (~15× slower). '' until first load. */
export const embedInfo: { device: '' | 'webgpu' | 'cpu' } = { device: '' };

/** True when this context (Worker or page) has a usable WebGPU adapter. WebGPU IS exposed in a
 *  DedicatedWorkerGlobalScope, which is where the embedder runs (embed.worker.ts). */
async function hasWebGPU(): Promise<boolean> {
  try {
    const gpu = (globalThis.navigator as Navigator | undefined)?.gpu;
    if (!gpu) return false;
    return !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

/**
 * Load the embedder. Prefer the WebGPU EP with fp16 weights — on a real GPU the embedding step runs
 * well above the CPU/WASM path (measured ~143 chunks/sec for MiniLM-L12 vs ~2–7 on CPU), the single
 * slowest part of indexing a long note. fp16 (not q8) is the win: GPUs accelerate fp16 matmul,
 * whereas int8 falls back and barely beats CPU on WebGPU.
 *
 * We keep a WASM/q8 fallback for machines with no GPU (FR-CAP-002 — semantic search must still work
 * there) and if the WebGPU pipeline fails to build. The header chip (embedClient.backendInfo) surfaces
 * which path loaded so a user can tell GPU from a silent CPU fallback. MiniLM-L12 is small (~118M),
 * so even the fp16 download is modest (~235MB) and the cold start is short.
 */
export function getEmbedder(): Promise<FeatureExtractionPipeline> {
  return (extractorPromise ??= (async () => {
    if (await hasWebGPU()) {
      try {
        const ext = (await pipeline('feature-extraction', EMBEDDING_MODEL, {
          device: 'webgpu',
          dtype: 'fp16'
        })) as unknown as FeatureExtractionPipeline;
        embedInfo.device = 'webgpu';
        return ext;
      } catch (e) {
        console.warn('Nebula: WebGPU embedder failed to load, falling back to CPU/q8:', e);
      }
    }
    const ext = (await pipeline('feature-extraction', EMBEDDING_MODEL, {
      dtype: 'q8'
    })) as unknown as FeatureExtractionPipeline;
    embedInfo.device = 'cpu';
    return ext;
  })());
}

export function getTokenizer(): Promise<PreTrainedTokenizer> {
  return (tokenizerPromise ??= AutoTokenizer.from_pretrained(EMBEDDING_MODEL));
}

/** Embed a single string → 384-dim mean-pooled, normalized vector (MiniLM-L12). */
export async function embed(text: string): Promise<number[]> {
  const extractor = await getEmbedder();
  const out = await extractor(text, { pooling: 'mean', normalize: true });
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
  const out = await extractor(texts, { pooling: 'mean', normalize: true });
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
 * Build the SYNC token counter the chunker needs (loads the embed model's tokenizer once).
 * Injecting this into `chunk()` makes chunk sizing use the SAME tokenizer that embeds,
 * which is what actually closes the R-1 silent-truncation risk (ADR-006). (Name kept for
 * call-site stability across the bge-m3 → MiniLM swap; it loads EMBEDDING_MODEL's tokenizer.)
 */
export async function makeBgeTokenCounter(): Promise<TokenCounter> {
  const tokenizer = await getTokenizer();
  return (text: string) => tokenizer.encode(text).length;
}

export { EMBEDDING_DIM, EMBEDDING_MAX_TOKENS };
