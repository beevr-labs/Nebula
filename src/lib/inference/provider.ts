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
  // Force the answer's language (e.g. 'Vietnamese') regardless of the note/question language — driven
  // by the UI locale. Omitted → the model replies in the language of the question.
  answerLanguage?: string;
  // Localized "no relevant notes" line (UI-locale). Omitted → the English default.
  noResultsMessage?: string;
  // Localized fallback shown when the model returns an empty answer. Omitted → the English default.
  emptyAnswerMessage?: string;
  // Prior Q→A turns of this Ask conversation, replayed so a follow-up keeps the thread (FR-CHAT-006).
  // Empty/omitted for the first question. Each turn's grounding context is NOT re-sent — only the
  // running dialogue — while THIS turn carries its own freshly-retrieved context.
  history?: { query: string; answer: string }[];
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
  // Model-cache management (FR-MDL): is this model already on disk, and remove it to free space.
  // Optional — a provider whose weights aren't browser-cached (e.g. native-Rust) omits both.
  isCached?(modelId: string): Promise<boolean>;
  deleteModel?(modelId: string): Promise<void>;
  unload(): Promise<void>;
}

// Legacy RAM-baseline model ids — they feed the capability OOM-spec map (`capability.ts`) and the persisted
// `settings.activeModel` default. The LIVE chat picker, best-model recommendation, and OOM gating live in
// `inference/catalog.ts` (ADR-022/029/030); the app's start default is Llama-3.2-1B. Both ids below are real
// entries in that catalog. (Earlier ADR-007 framing: Phi-3-mini default / Llama-3.1-8B opt-in.)
export const DEFAULT_CHAT_MODEL = 'Phi-3-mini-4k-instruct-q4f16_1-MLC';
export const OPTIONAL_CHAT_MODEL = 'Llama-3.1-8B-Instruct-q4f16_1-MLC';
// Multilingual embedder: `paraphrase-multilingual-MiniLM-L12-v2` (118M) embeds 50+ languages — incl.
// Vietnamese — into a shared space. Switched from bge-m3 (568M) for SPEED: on a real GPU it embeds
// ~1.9× faster, and on a head-to-head Vietnamese cross-lingual eval it MATCHED bge-m3's retrieval
// (9/10 each on hard semantic queries; MiniLM had the higher separation margins). Dense vectors are
// 384-dim, MEAN-pooled + L2-normalized. Everything reads EMBEDDING_DIM, so the swap is the three
// constants below + the store namespace bump (the 384-dim index must not collide with the old
// 1024-dim bge-m3 store). bge-m3 stays the higher-ceiling option if quality ever needs it.
export const EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
export const EMBEDDING_DIM = 384;
export const EMBEDDING_MAX_TOKENS = 512; // MiniLM-L12 position window (chunks are ~60 tokens, far under)
