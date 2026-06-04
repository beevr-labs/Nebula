// The InferenceProvider abstraction (ADR-001) — product logic depends ONLY on this.
// WebLLM (Phase 1) and native-Rust (Phase 2) implement it identically.
// Wire shapes mirror API-CONTRACTS.md §2.5.

export interface SearchHit {
  chunkId: string;
  docId: string;
  text: string;
  page?: number;
  charStart: number;
  charEnd: number;
  score: number; // cosine similarity = 1 - distance (DATA-MODEL §4)
}

export interface GenerateRequest {
  requestId: string;
  query: string;
  context: SearchHit[]; // retrieved chunks that ground the answer
  modelId: string;
  maxTokens: number;
}

export interface GenerateResult {
  requestId: string;
  text: string;
  citations: { chunkId: string; spanInAnswer: [number, number] }[]; // FR-CHAT-002
  ttftMs: number;
  tokensPerSec: number; // NFR-PERF-002/003 telemetry
}

export type Backend = 'webgpu' | 'metal' | 'vulkan' | 'cuda';

export interface InferenceProvider {
  readonly id: 'webllm' | 'native-rust';
  capabilities(): { chat: boolean; maxContextTokens: number; backend: Backend };
  loadModel(modelId: string, onProgress: (p: number) => void): Promise<void>;
  // Streaming generation grounded in retrieved chunks. Cancellation via AbortSignal
  // (the worker transport maps signal.abort() -> a `cancel(requestId)` message).
  generate(
    req: GenerateRequest,
    onToken: (t: string) => void,
    signal: AbortSignal
  ): Promise<GenerateResult>;
  unload(): Promise<void>;
}

// Phase 1 default model IDs (DEPENDENCIES.lock §3 — confirm against webllm.prebuiltAppConfig).
export const DEFAULT_CHAT_MODEL = 'Phi-3-mini-4k-instruct-q4f16_1-MLC';
export const OPTIONAL_CHAT_MODEL = 'Llama-3-8B-Instruct-q4f16_1-MLC';
export const EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5'; // 384-dim, 512-token (ADR-006)
export const EMBEDDING_DIM = 384;
export const EMBEDDING_MAX_TOKENS = 512;
