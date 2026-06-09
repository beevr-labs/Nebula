// Real WebLLM InferenceProvider (ADR-001, FR-CHAT-001..004). Runs a quantized LLM on
// WebGPU via @mlc-ai/web-llm. Selected when the capability check reports tier 'full'
// with verified weights (chatStatus 'ready'); otherwise the app stays on the mock/
// degraded path. Verified end-to-end on a real NVIDIA GPU through the webllm-test route.

import * as webllm from '@mlc-ai/web-llm';
import type { InferenceProvider, GenerateRequest, GenerateResult, Backend } from './provider';
import {
  assemblePrompt,
  buildChatMessages,
  normalizeCitationMarkers,
  parseCitations,
  stripPromptEcho,
  NO_RESULTS_MESSAGE
} from '$lib/chat/prompt';

const MAX_CONTEXT_TOKENS = 4096;

// Persist model weights via WebLLM's IndexedDB cache backend, NOT the default Cache Storage API
// (supersedes ADR-025). ROOT CAUSE (isolated by live diagnosis): the app is crossOriginIsolated
// (COEP), and HuggingFace now serves model shards through its xet CDN WITHOUT a
// `Cross-Origin-Resource-Policy` header. Under COEP a cross-origin response lacking CORP can be
// fetched+read (verified: GET 200, 155 MB body readable) but CANNOT be stored via the Cache API —
// `Cache.add()/put()` throw "encountered a network error". WebLLM's default "cache" backend uses
// exactly that path, so EVERY model download failed. The "indexeddb" backend instead stores the
// fetched ArrayBuffers itself (no Response object hits the Cache API), sidestepping the CORP check
// entirely. Persistence is equivalent (IndexedDB on the stable strictPort origin).
const APP_CONFIG: webllm.AppConfig = { ...webllm.prebuiltAppConfig, cacheBackend: 'indexeddb' };

export class WebLLMProvider implements InferenceProvider {
  readonly id = 'webllm' as const;
  private engine: webllm.MLCEngineInterface | null = null;

  capabilities(): { chat: boolean; maxContextTokens: number; backend: Backend } {
    return { chat: true, maxContextTokens: MAX_CONTEXT_TOKENS, backend: 'webgpu' };
  }

  /** True if this model's weights are already cached locally — no download needed (FR-MDL). */
  async isCached(modelId: string): Promise<boolean> {
    try {
      return await webllm.hasModelInCache(modelId, APP_CONFIG);
    } catch {
      return false;
    }
  }

  /**
   * Remove ALL of this model's cached data (weights + wasm + chat config) from the browser, freeing
   * the disk it occupied (FR-MDL). Re-downloadable anytime. Uses the SAME `indexeddb` cacheBackend
   * the weights were stored under, so it actually clears them (the default Cache backend would miss).
   */
  async deleteModel(modelId: string): Promise<void> {
    await webllm.deleteModelAllInfoInCache(modelId, APP_CONFIG);
  }

  async loadModel(modelId: string, onProgress: (p: number) => void): Promise<void> {
    this.engine = await webllm.CreateMLCEngine(modelId, {
      appConfig: APP_CONFIG,
      initProgressCallback: (r: webllm.InitProgressReport) => onProgress(r.progress ?? 0)
    });
  }

  /**
   * Grounded, streamed, cited generation. Assembles the RAG prompt from the retrieved
   * context (no-results guard short-circuits before the model — FR-CHAT-002), streams
   * tokens (FR-CHAT-004) honoring AbortSignal, and maps [#n] markers → chunkId (FR-CHAT-003).
   */
  async generate(
    req: GenerateRequest,
    onToken: (t: string) => void,
    signal: AbortSignal
  ): Promise<GenerateResult> {
    if (!this.engine) throw new Error('Model not loaded');

    const prompt = assemblePrompt(req.query, req.context, {
      maxContextTokens: this.capabilities().maxContextTokens,
      mode: req.answerMode
    });
    if (prompt.kind === 'no_results') {
      return {
        requestId: req.requestId,
        text: NO_RESULTS_MESSAGE,
        citations: [],
        ttftMs: 0,
        tokensPerSec: 0
      };
    }

    const start = performance.now();
    let ttftMs = 0;
    let tokens = 0;
    let text = '';

    const stream = await this.engine.chat.completions.create({
      stream: true,
      // Low temperature → grounded, reproducible answers (RAG should not be creative).
      temperature: 0.2,
      top_p: 0.9,
      // Replay prior turns before this turn's grounded message so a follow-up keeps the thread.
      messages: buildChatMessages(prompt.system, prompt.user, req.history)
    });

    for await (const part of stream) {
      if (signal.aborted) {
        await this.engine.interruptGenerate();
        throw new DOMException('Generation aborted', 'AbortError');
      }
      const delta = part.choices[0]?.delta?.content ?? '';
      if (delta) {
        if (ttftMs === 0) ttftMs = Math.round(performance.now() - start);
        text += delta;
        tokens += 1;
        onToken(delta);
      }
    }

    const seconds = Math.max((performance.now() - start) / 1000, 1e-3);
    // Defensive: strip any echoed prompt scaffolding the small model emitted, then parse
    // citations against the CLEANED text so spans line up with what the user sees.
    const cleaned = normalizeCitationMarkers(stripPromptEcho(text));
    const { citations } = parseCitations(cleaned, prompt.contextOrder);
    return {
      requestId: req.requestId,
      text: cleaned,
      citations,
      ttftMs,
      tokensPerSec: tokens / seconds
    };
  }

  /**
   * Raw, non-streamed completion (TextGenerator seam) for auto-tagging + entity extraction. Not
   * grounded and not cited — these are background "archivist" tasks, so temperature is 0 for stable,
   * parseable JSON. Throws if no model is loaded; callers treat that as "skip, try later".
   */
  async complete(prompt: string, opts: { maxTokens?: number } = {}): Promise<string> {
    if (!this.engine) throw new Error('Model not loaded');
    const res = await this.engine.chat.completions.create({
      stream: false,
      temperature: 0,
      max_tokens: opts.maxTokens ?? 512,
      messages: [{ role: 'user', content: prompt }]
    });
    return res.choices[0]?.message?.content ?? '';
  }

  async unload(): Promise<void> {
    await this.engine?.unload();
    this.engine = null;
  }
}
