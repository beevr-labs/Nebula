// Deterministic InferenceProvider mock (API-CONTRACTS §5). Lets retrieval/UI/chat
// tests run without a GPU — essential for CI. Streams a grounded, cited answer built
// from the provided context, honors AbortSignal, and returns parsed citations.

import type {
  InferenceProvider,
  GenerateRequest,
  GenerateResult,
  Backend
} from '$lib/inference/provider';
import { normalizeCitationMarkers, parseCitations, NO_RESULTS_MESSAGE } from '$lib/chat/prompt';

export class MockInferenceProvider implements InferenceProvider {
  readonly id = 'webllm' as const;
  private loaded = false;

  capabilities(): { chat: boolean; maxContextTokens: number; backend: Backend } {
    return { chat: true, maxContextTokens: 4096, backend: 'webgpu' };
  }

  async loadModel(_modelId: string, onProgress: (p: number) => void): Promise<void> {
    for (const p of [0, 0.5, 1]) onProgress(p);
    this.loaded = true;
  }

  async generate(
    req: GenerateRequest,
    onToken: (t: string) => void,
    signal: AbortSignal
  ): Promise<GenerateResult> {
    if (!this.loaded) throw new Error('Model not loaded');

    // Empty context should never reach here (no-results guard), but be safe.
    const text =
      req.context.length === 0
        ? NO_RESULTS_MESSAGE
        : `Based on the provided context [#1], here is a grounded answer to "${req.query}".`;

    // Stream token-by-token (space-delimited), honoring cancellation (AbortSignal).
    const tokens = text.split(/(\s+)/).filter((t) => t.length > 0);
    for (const tok of tokens) {
      if (signal.aborted) throw new DOMException('Generation aborted', 'AbortError');
      onToken(tok);
    }

    const contextOrder = req.context.map((c) => c.chunkId);
    const { citations } = parseCitations(normalizeCitationMarkers(text), contextOrder);

    return {
      requestId: req.requestId,
      text,
      citations,
      ttftMs: 12, // deterministic telemetry stand-ins
      tokensPerSec: 42
    };
  }

  /** Raw-completion seam (entity extraction / auto-tag). Deterministic empty graph — tests that
   * need real entities pass their own stub generator to extractEntities directly. */
  async complete(_prompt: string): Promise<string> {
    if (!this.loaded) throw new Error('Model not loaded');
    return '{"entities":[],"relations":[]}';
  }

  async unload(): Promise<void> {
    this.loaded = false;
  }
}
