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
  answerMode?: 'grounded' | 'reason'; // strict RAG vs reason-with-the-notes (FR-CHAT-005)
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
  // Raw (ungrounded) completion seam for non-RAG tasks — auto-tagging (FR-ING-006) and entity/
  // relation extraction (knowledge graph). Optional: a provider that only does grounded generation
  // may omit it, and callers degrade gracefully (the graph/tags are best-effort, never a hard fail).
  complete?(prompt: string, opts?: { maxTokens?: number; signal?: AbortSignal }): Promise<string>;
  unload(): Promise<void>;
}

// Legacy RAM-baseline model ids — they feed the capability OOM-spec map (`capability.ts`) and the persisted
// `settings.activeModel` default. The LIVE chat picker, best-model recommendation, and OOM gating live in
// `inference/catalog.ts` (ADR-022/029/030); the app's start default is Llama-3.2-1B. Both ids below are real
// entries in that catalog. (Earlier ADR-007 framing: Phi-3-mini default / Llama-3.1-8B opt-in.)
export const DEFAULT_CHAT_MODEL = 'Phi-3-mini-4k-instruct-q4f16_1-MLC';
export const OPTIONAL_CHAT_MODEL = 'Llama-3.1-8B-Instruct-q4f16_1-MLC';
// Multilingual embedder (ADR-021): `bge-m3` (XLM-RoBERTa) embeds 100+ languages — incl. Vietnamese
// — into a shared space, so retrieval works on non-English notes where the old English-only
// `bge-small-en` scored poorly. Dense vectors are 1024-dim, CLS-pooled + L2-normalized. Quantized
// (q8) so the in-browser download stays reasonable. Everything reads EMBEDDING_DIM, so the swap is
// the three constants below + the store namespace bump.
export const EMBEDDING_MODEL = 'Xenova/bge-m3';
export const EMBEDDING_DIM = 1024;
export const EMBEDDING_MAX_TOKENS = 8192; // bge-m3 context (chunks stay far under this)
