// Real WebLLM InferenceProvider (ADR-001, FR-CHAT-001..004). Runs a quantized LLM on
// WebGPU via @mlc-ai/web-llm. Selected when the capability check reports tier 'full'
// with verified weights (chatStatus 'ready'); otherwise the app stays on the mock/
// degraded path. Verified end-to-end on a real NVIDIA GPU through the webllm-test route.

import * as webllm from '@mlc-ai/web-llm';
import type { InferenceProvider, GenerateRequest, GenerateResult, Backend } from './provider';
import { assemblePrompt, parseCitations, NO_RESULTS_MESSAGE } from '$lib/chat/prompt';

const MAX_CONTEXT_TOKENS = 4096;

export class WebLLMProvider implements InferenceProvider {
  readonly id = 'webllm' as const;
  private engine: webllm.MLCEngineInterface | null = null;

  capabilities(): { chat: boolean; maxContextTokens: number; backend: Backend } {
    return { chat: true, maxContextTokens: MAX_CONTEXT_TOKENS, backend: 'webgpu' };
  }

  async loadModel(modelId: string, onProgress: (p: number) => void): Promise<void> {
    this.engine = await webllm.CreateMLCEngine(modelId, {
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
      maxContextTokens: this.capabilities().maxContextTokens
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
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ]
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
    const { citations } = parseCitations(text, prompt.contextOrder);
    return { requestId: req.requestId, text, citations, ttftMs, tokensPerSec: tokens / seconds };
  }

  async unload(): Promise<void> {
    await this.engine?.unload();
    this.engine = null;
  }
}
