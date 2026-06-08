// Capability classifier — FR-CAP-001/002/004. Pure decision logic over a hardware
// probe; the actual probe (WebGPU/RAM/disk) is the Rust `capability` command (T-040/049).
// Separating the decision from the probe makes it unit-testable without hardware.

import { DEFAULT_CHAT_MODEL, OPTIONAL_CHAT_MODEL } from '$lib/inference/provider';

export interface CapabilityProbe {
  webgpu: boolean;
  ramGB: number;
  vramGB?: number;
  freeDiskGB: number;
  hasVerifiedWeights: boolean; // a model is downloaded AND hash-verified (FR-MDL-002)
  hasNativeProvider?: boolean; // Phase 2 native-Rust inference (ADR-001)
  activeModelId?: string;
}

export type Tier = 'full' | 'degraded';
export type Provider = 'webllm' | 'native-rust' | 'none';
export type ChatStatus = 'ready' | 'needs_model' | 'unsupported';

export interface Capabilities {
  tier: Tier; // hardware tier (FR-CAP-001/002)
  selectedProvider: Provider;
  chatStatus: ChatStatus; // chat-readiness, distinct from tier (FR-CAP-004)
  semanticSearch: boolean; // ALWAYS true — WASM/CPU fallback (FR-CAP-002)
  activeModelId?: string;
}

/**
 * Derive capabilities from a probe.
 * - tier: `full` iff WebGPU is present (drives chat-capable hardware).
 * - chatStatus (FR-CAP-004): `ready` (WebGPU + verified weights), `needs_model`
 *   (chat-capable hardware but no weights yet), `unsupported` (no WebGPU + no native).
 * - semanticSearch is always available (embeddings fall back to WASM/CPU) — FR-CAP-002.
 */
export function classifyCapabilities(p: CapabilityProbe): Capabilities {
  const tier: Tier = p.webgpu ? 'full' : 'degraded';
  const selectedProvider: Provider = p.webgpu
    ? 'webllm'
    : p.hasNativeProvider
      ? 'native-rust'
      : 'none';

  let chatStatus: ChatStatus;
  if (p.webgpu) {
    chatStatus = p.hasVerifiedWeights ? 'ready' : 'needs_model';
  } else if (p.hasNativeProvider) {
    chatStatus = p.hasVerifiedWeights ? 'ready' : 'needs_model';
  } else {
    chatStatus = 'unsupported';
  }

  return {
    tier,
    selectedProvider,
    chatStatus,
    semanticSearch: true,
    activeModelId: p.activeModelId
  };
}

export interface ModelSpec {
  id: string;
  minRamGB: number;
  is8bPlus: boolean;
}

// RAM-baseline specs for the two legacy reference models. NOTE: the live picker gates OOM by download
// SIZE via `catalog.needsOomAck` (ADR-022); this map + `requiresOomAck` are the RAM-based baseline.
export const MODEL_SPECS: Record<string, ModelSpec> = {
  [DEFAULT_CHAT_MODEL]: { id: DEFAULT_CHAT_MODEL, minRamGB: 8, is8bPlus: false }, // Phi-3-mini
  [OPTIONAL_CHAT_MODEL]: { id: OPTIONAL_CHAT_MODEL, minRamGB: 16, is8bPlus: true } // Llama-3.1-8B
};

/**
 * Whether selecting `modelId` on a machine with `ramGB` must show the distinct
 * OOM-risk warning + require explicit acknowledgement before download/load (FR-CAP-003).
 */
export function requiresOomAck(modelId: string, ramGB: number): boolean {
  const spec = MODEL_SPECS[modelId];
  if (!spec) return false;
  return ramGB < spec.minRamGB;
}
