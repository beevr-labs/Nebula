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
  NO_RESULTS_MESSAGE,
  EMPTY_ANSWER_MESSAGE
} from '$lib/chat/prompt';

const MAX_CONTEXT_TOKENS = 4096;

// assemblePrompt budgets context in WHITESPACE WORDS (approxTokenCount), but the model enforces its
// window in real TOKENS — and real tokens run well above words (~1.3× English, ~1.5–2× Vietnamese
// split per syllable, more for code). Sizing the word budget at the raw 4096 let a long/Vietnamese
// note assemble to 5000+ real tokens and overflow the window — WebLLM throws
// ContextWindowSizeExceededError, which surfaced as a BLANK answer. So derive the WORD budget from
// the window after reserving the system prompt + the answer, then divide by a conservative
// word→token blowup. ~1700 words for a 256-token grounded answer; comfortably inside 4096 tokens.
const WORD_TO_TOKEN = 2; // conservative upper bound (Vietnamese-safe)
const SYSTEM_RESERVE_TOKENS = 420; // the (largest) system prompt + the question/structure overhead

function contextWordBudget(outputTokens: number): number {
  const tokenRoom = MAX_CONTEXT_TOKENS - SYSTEM_RESERVE_TOKENS - outputTokens;
  return Math.max(256, Math.floor(tokenRoom / WORD_TO_TOKEN));
}

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

// JSON-mode (grammar-constrained) generation for the archivist tasks (auto-tag, entity extraction):
// the model emits ONLY a valid JSON object and STOPS at its closing brace, instead of small models
// rambling on to max_tokens — faster decode AND always parseable (no wasted "unparseable" segments).
// Disabled for the rest of the session if it doesn't work here, so a save never hard-fails over a
// missing feature.
//
// LIVE-DIAGNOSED (preview e2e, NVIDIA Lovelace): in some environments the grammar-constrained
// request neither resolves NOR rejects — plain decode on the same engine returns in <1s while the
// json_object request hangs forever (likely the grammar backend failing to initialize silently).
// A never-settling promise is worse than a rejection, because it wedges the engine's SERIALIZED
// request queue: every later generation (auto-tag, extraction, even Ask) waits behind it — the
// "building graph… forever" symptom. interruptGenerate() does NOT free a request stuck before
// token generation starts, so the only reliable recovery is rebuilding the engine. Hence:
// loadModel() PROBES json mode once with a tiny request; on timeout it recreates the engine
// (clean queue) and pins the session to plain decode. Real requests then never hit the hang.
let jsonModeOK = true;
// A working probe answers in <1s, so 8s is ample; a broken one hangs forever, so failing faster
// just shortens the one-time penalty.
const JSON_PROBE_TIMEOUT_MS = 8_000;

// Persist the "JSON mode is broken on this browser" verdict so the costly probe (timeout + engine
// rebuild) is paid ONCE per browser, not on every model load. The breakage is environmental (the
// grammar/WebGPU backend under COEP — see above), i.e. stable per origin, so caching is safe: a
// false "broken" only pins to plain decode, which works fine. Version-scoped so a WebLLM upgrade
// that fixes grammar re-probes. localStorage is guarded for non-browser (SSR/test) contexts.
const JSON_BROKEN_KEY = 'nebula:json-mode-broken:v1';

function jsonModeKnownBroken(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(JSON_BROKEN_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberJsonModeBroken(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(JSON_BROKEN_KEY, '1');
  } catch {
    /* private mode / quota — fine, we just re-probe next load */
  }
}

class DeadlineError extends Error {
  constructor(ms: number) {
    super(`generation did not settle within ${ms}ms`);
  }
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new DeadlineError(ms)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e))
    );
  });
}

export class WebLLMProvider implements InferenceProvider {
  readonly id = 'webllm' as const;
  private engine: webllm.MLCEngineInterface | null = null;
  private modelId: string | null = null;

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
    this.modelId = modelId;
    this.engine = await webllm.CreateMLCEngine(modelId, {
      appConfig: APP_CONFIG,
      initProgressCallback: (r: webllm.InitProgressReport) => onProgress(r.progress ?? 0)
    });
    await this.probeJsonMode();
  }

  /**
   * Interrupt a hung request; if it STILL doesn't settle, rebuild the engine — the hung request
   * wedges the serialized queue and interruptGenerate() can't free one stuck before its first
   * token, so a fresh engine is the only reliable way to make later generations run at all.
   * Weights are cached, so the rebuild is load-from-disk, not a re-download.
   */
  private async unwedge(hung: Promise<unknown>): Promise<void> {
    if (!this.engine) return;
    try {
      await this.engine.interruptGenerate();
    } catch {
      /* best-effort */
    }
    const settled = await Promise.race([
      hung.then(
        () => true,
        () => true
      ),
      new Promise<boolean>((r) => setTimeout(() => r(false), 3000))
    ]);
    if (!settled && this.modelId) {
      try {
        await this.engine.unload();
      } catch {
        /* dropping the reference is enough — a fresh engine replaces it below */
      }
      this.engine = await webllm.CreateMLCEngine(this.modelId, { appConfig: APP_CONFIG });
    }
  }

  /**
   * Decide jsonModeOK for this session with a TINY grammar-constrained request, so the hang (see
   * top of file) is paid ONCE here — never inside a user-visible save/build. When it works this
   * doubles as a warm-up (grammar + decode pipeline compiled before the first real archivist
   * call). On timeout the session pins to plain decode and the queue is unwedged.
   */
  private async probeJsonMode(): Promise<void> {
    if (!jsonModeOK || !this.engine) return; // a previous engine already proved it broken here
    // Already known broken on this browser → skip the probe entirely (no timeout, no rebuild).
    if (jsonModeKnownBroken()) {
      jsonModeOK = false;
      return;
    }
    const probe = this.engine.chat.completions.create({
      stream: false,
      temperature: 0,
      max_tokens: 16,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user' as const, content: 'Return exactly {"ok":true}' }]
    });
    try {
      await withDeadline(probe, JSON_PROBE_TIMEOUT_MS);
    } catch (e) {
      jsonModeOK = false;
      rememberJsonModeBroken(); // never pay the probe + rebuild again on this browser
      console.warn('Nebula: JSON-mode generation unavailable here — plain decode this session:', e);
      if (e instanceof DeadlineError) await this.unwedge(probe);
    }
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
      // WORD budget sized to fit the model's real-token window after the system prompt + answer.
      maxContextTokens: contextWordBudget(req.maxTokens),
      mode: req.answerMode,
      answerLanguage: req.answerLanguage // pin the answer to the UI language when set
    });
    if (prompt.kind === 'no_results') {
      return {
        requestId: req.requestId,
        text: req.noResultsMessage ?? NO_RESULTS_MESSAGE, // localized line passed by the UI
        citations: [],
        ttftMs: 0,
        tokensPerSec: 0
      };
    }

    const messages = buildChatMessages(prompt.system, prompt.user, req.history);
    const start = performance.now();
    let ttftMs = 0;
    let tokens = 0;
    let text = '';

    try {
      const stream = await this.engine.chat.completions.create({
        stream: true,
        // Low temperature → grounded, reproducible answers (RAG should not be creative).
        temperature: 0.2,
        top_p: 0.9,
        // Bound the answer length (the caller sizes it per mode) AND reserve decode room — without
        // an explicit cap the engine was left to its default.
        max_tokens: req.maxTokens,
        // Replay prior turns before this turn's grounded message so a follow-up keeps the thread.
        messages
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
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e; // user cancelled — propagate
      // Any other generation failure (e.g. a residual ContextWindowSizeExceededError if token
      // estimation under-counted) must not blank the answer — degrade to the friendly fallback.
      console.warn('Nebula: generation failed, showing fallback:', e);
      text = '';
    }

    // EMPTY-ANSWER RECOVERY. A blank answer is the worst outcome (the notes WERE retrieved), so:
    //   1. if stripPromptEcho/splitReasoning emptied a non-blank raw answer → keep the raw text;
    //   2. if nothing survived (genuine empty, or the generation threw above) → a friendly line
    //      that points at the cited sources instead of showing nothing.
    let cleaned = normalizeCitationMarkers(stripPromptEcho(text));
    if (!cleaned.trim() && text.trim()) cleaned = text.trim();
    if (!cleaned.trim()) {
      cleaned = req.emptyAnswerMessage ?? EMPTY_ANSWER_MESSAGE; // localized fallback from the UI
      onToken(cleaned);
    }

    const seconds = Math.max((performance.now() - start) / 1000, 1e-3);
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
    const max_tokens = opts.maxTokens ?? 512;
    const messages = [{ role: 'user' as const, content: prompt }];
    if (jsonModeOK) {
      const attempt = this.engine.chat.completions.create({
        stream: false,
        temperature: 0,
        max_tokens,
        response_format: { type: 'json_object' },
        messages
      });
      try {
        // Defense-in-depth: the load-time probe should have caught a broken grammar backend, but
        // a real request must still never wedge a save/build forever. Deadline scales with the
        // output budget so a long (batched) decode isn't mistaken for a hang.
        const res = await withDeadline(attempt, 15_000 + max_tokens * 50);
        return res.choices[0]?.message?.content ?? '';
      } catch (e) {
        jsonModeOK = false; // fall back once; stay on plain decode for the session
        if (e instanceof DeadlineError) await this.unwedge(attempt);
        console.warn('Nebula: JSON-mode generation unavailable here — using plain decode:', e);
      }
    }
    const res = await this.engine.chat.completions.create({
      stream: false,
      temperature: 0,
      max_tokens,
      messages
    });
    return res.choices[0]?.message?.content ?? '';
  }

  async unload(): Promise<void> {
    await this.engine?.unload();
    this.engine = null;
  }
}
