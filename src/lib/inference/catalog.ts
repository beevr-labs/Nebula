// Chat-model catalog (FR-CAP-003/004, ADR-022) — the curated subset of WebLLM's prebuilt models the picker
// offers, from tiny/fast to large/accurate. `sizeMB` is WebLLM's `vram_required_MB` for the
// q4f16_1 build (the in-VRAM footprint ≈ the one-time download), used to label each option and to
// gate the large ones behind an explicit OOM-risk acknowledgment. Pure data + helpers — no GPU, so
// the picker logic is unit-testable. All ids are verified present in `prebuiltAppConfig.model_list`.

export interface ChatModel {
  id: string; // WebLLM model_id
  label: string; // picker label
  params: string; // parameter count, e.g. "3B"
  sizeMB: number; // VRAM/download footprint (WebLLM vram_required_MB, q4f16_1)
  multilingual?: boolean; // notably strong on non-English (incl. Vietnamese)
}

// Ordered by parameter count (a speed↔accuracy ladder). Note `sizeMB` is NOT monotonic with params
// — e.g. Qwen2.5-0.5B's vocab makes it heavier than Llama-3.2-1B — so the picker shows each size.
export const CHAT_MODELS: ChatModel[] = [
  {
    id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    label: 'Qwen2.5-0.5B (tiny)',
    params: '0.5B',
    sizeMB: 945,
    multilingual: true
  },
  {
    id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    label: 'Llama-3.2-1B (fast)',
    params: '1B',
    sizeMB: 879
  },
  {
    id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    label: 'Qwen2.5-1.5B',
    params: '1.5B',
    sizeMB: 1630,
    multilingual: true
  },
  { id: 'gemma-2-2b-it-q4f16_1-MLC', label: 'Gemma-2-2B', params: '2B', sizeMB: 1895 },
  {
    id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
    label: 'Llama-3.2-3B (balanced)',
    params: '3B',
    sizeMB: 2264
  },
  {
    id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC',
    label: 'Qwen2.5-3B (multilingual)',
    params: '3B',
    sizeMB: 2505,
    multilingual: true
  },
  { id: 'Phi-3-mini-4k-instruct-q4f16_1-MLC', label: 'Phi-3-mini', params: '3.8B', sizeMB: 3672 },
  {
    id: 'Mistral-7B-Instruct-v0.3-q4f16_1-MLC',
    label: 'Mistral-7B (accurate)',
    params: '7B',
    sizeMB: 4573
  },
  {
    id: 'Llama-3.1-8B-Instruct-q4f16_1-MLC',
    label: 'Llama-3.1-8B (accurate)',
    params: '8B',
    sizeMB: 5001
  },
  {
    id: 'Qwen2.5-7B-Instruct-q4f16_1-MLC',
    label: 'Qwen2.5-7B (multilingual, accurate)',
    params: '7B',
    sizeMB: 5107,
    multilingual: true
  },
  {
    id: 'DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC',
    label: 'DeepSeek-R1 7B (reasoning)',
    params: '7B',
    sizeMB: 5107
  },
  {
    id: 'Qwen3-8B-q4f16_1-MLC',
    label: 'Qwen3-8B (multilingual, newest)',
    params: '8B',
    sizeMB: 5696,
    multilingual: true
  },
  { id: 'gemma-2-9b-it-q4f16_1-MLC', label: 'Gemma-2-9B (accurate)', params: '9B', sizeMB: 6422 },
  {
    id: 'Llama-3.1-70B-Instruct-q3f16_1-MLC',
    label: 'Llama-3.1-70B (flagship · needs ~32 GB GPU)',
    params: '70B',
    sizeMB: 31153
  }
];

// Models at/above this footprint get a one-time "large download" confirm (FR-CAP-003): a 3.5 GB+
// model is a big one-time download and a heavier VRAM footprint, so we let the user opt in rather
// than silently pulling gigabytes. This is purely a download/VRAM heads-up — NOT a hard load limit:
// modern WebGPU shards weights into multiple buffers, so large models (7–8 B) load fine on capable
// GPUs (verified: Qwen2.5-7B runs in the browser). The ack just prevents a surprise multi-GB pull.
export const BIG_MODEL_MB = 3500;

/** The id we recommend on a CAPABLE machine — the newest multilingual model, strongest on Vietnamese
 *  and far better than a 3 B at extracting a fact buried in a long note (the small-model weakness that
 *  drove this default). It's a ~5.7 GB download, so the OOM-ack + the picker remain the escape hatches. */
export const RECOMMENDED_MODEL_ID = 'Qwen3-8B-q4f16_1-MLC';

/** The fallback default for a WEAKER machine — the multilingual 3 B (quality/size sweet spot, modest
 *  download). Still a real catalog entry the picker offers. */
export const RECOMMENDED_LITE_MODEL_ID = 'Qwen2.5-3B-Instruct-q4f16_1-MLC';

/** Coarse hardware signals the browser actually exposes (no VRAM API exists). */
export interface HardwareHint {
  deviceMemoryGB?: number; // navigator.deviceMemory — capped at 8 in most browsers, so "≥8" ≈ "8 GB+ RAM"
  maxBufferBytes?: number; // WebGPU adapter.limits.maxBufferSize (a weak/old GPU may report a small one)
}

/**
 * Is this machine capable enough to default to the heavy 8 B model? The browser exposes neither total
 * VRAM nor a reliable proxy (maxBufferSize caps at ~2 GB on both 6 GB and 24 GB GPUs), so we key on
 * deviceMemory — the one meaningful signal — and treat ≥8 GB RAM as "capable". A small reported GPU
 * buffer (<256 MB, i.e. a very weak/old adapter) vetoes it. Weak/unknown machines fall back to the 3 B.
 */
export function isHighEndForChat(hw: HardwareHint): boolean {
  if (hw.maxBufferBytes !== undefined && hw.maxBufferBytes < 256_000_000) return false;
  return (hw.deviceMemoryGB ?? 0) >= 8;
}

/**
 * Recommend the best model for the detected hardware (FR-CAP-001). With WebGPU: the newest multilingual
 * 8 B on a capable machine, else the lighter multilingual 3 B. No WebGPU → null (chat unsupported;
 * semantic search still works). `hw` omitted → conservative (the 3 B fallback).
 */
export function recommendModel(webgpu: boolean, hw: HardwareHint = {}): ChatModel | null {
  if (!webgpu) return null;
  const id = isHighEndForChat(hw) ? RECOMMENDED_MODEL_ID : RECOMMENDED_LITE_MODEL_ID;
  return modelById(id) ?? CHAT_MODELS[0];
}

export function modelById(id: string): ChatModel | undefined {
  return CHAT_MODELS.find((m) => m.id === id);
}

/** Human-readable size: GB for ≥1000 MB, else MB. */
export function formatSize(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}

/** True if this model is large enough to warrant the OOM-risk acknowledgment (FR-CAP-003). */
export function needsOomAck(modelId: string): boolean {
  const m = modelById(modelId);
  return !!m && m.sizeMB >= BIG_MODEL_MB;
}
