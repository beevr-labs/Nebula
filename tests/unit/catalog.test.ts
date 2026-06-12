import { describe, it, expect } from 'vitest';
import {
  CHAT_MODELS,
  BIG_MODEL_MB,
  RECOMMENDED_MODEL_ID,
  RECOMMENDED_LITE_MODEL_ID,
  modelById,
  formatSize,
  needsOomAck,
  recommendModel,
  isHighEndForChat
} from '../../src/lib/inference/catalog';

// FR-CAP-003/004. The curated chat-model picker + the OOM-risk gate for large models.

describe('CHAT_MODELS catalog', () => {
  it('is non-empty, uniquely keyed, and every model has a positive size', () => {
    expect(CHAT_MODELS.length).toBeGreaterThanOrEqual(5);
    const ids = CHAT_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length); // no dup ids
    expect(CHAT_MODELS.every((m) => m.sizeMB > 0 && m.label && m.params)).toBe(true);
  });

  it('offers at least one multilingual option (Vietnamese-capable)', () => {
    expect(CHAT_MODELS.some((m) => m.multilingual)).toBe(true);
  });
});

describe('modelById', () => {
  it('finds a known model and returns undefined otherwise', () => {
    expect(modelById('Llama-3.2-1B-Instruct-q4f16_1-MLC')?.params).toBe('1B');
    expect(modelById('nope')).toBeUndefined();
  });
});

describe('formatSize', () => {
  it('shows GB ≥ 1000 MB, else MB', () => {
    expect(formatSize(945)).toBe('945 MB');
    expect(formatSize(5107)).toBe('5.1 GB');
  });
});

describe('recommendModel', () => {
  it('no WebGPU → null (chat unsupported; semantic search still works)', () => {
    expect(recommendModel(false)).toBeNull();
    expect(recommendModel(false, { deviceMemoryGB: 32 })).toBeNull();
  });

  it('capable machine (≥8 GB RAM) → the newest multilingual 8B', () => {
    const r = recommendModel(true, { deviceMemoryGB: 16, maxBufferBytes: 2_000_000_000 });
    expect(r?.id).toBe(RECOMMENDED_MODEL_ID);
    expect(r?.multilingual).toBe(true);
    expect(r?.params).toBe('8B');
  });

  it('weaker / unknown machine → the lighter multilingual 3B fallback (ack-free, modest download)', () => {
    expect(recommendModel(true, { deviceMemoryGB: 4 })?.id).toBe(RECOMMENDED_LITE_MODEL_ID);
    expect(recommendModel(true)?.id).toBe(RECOMMENDED_LITE_MODEL_ID); // no hints → conservative
    expect(modelById(RECOMMENDED_LITE_MODEL_ID)?.multilingual).toBe(true);
    expect(needsOomAck(RECOMMENDED_LITE_MODEL_ID)).toBe(false); // the 3B fallback loads without an ack
  });

  it('a very weak GPU (tiny max buffer) vetoes the heavy default even with RAM', () => {
    expect(isHighEndForChat({ deviceMemoryGB: 32, maxBufferBytes: 128_000_000 })).toBe(false);
    expect(isHighEndForChat({ deviceMemoryGB: 8 })).toBe(true);
    expect(isHighEndForChat({ deviceMemoryGB: 4 })).toBe(false);
  });

  it('both recommended ids are real, multilingual catalog entries', () => {
    expect(modelById(RECOMMENDED_MODEL_ID)?.multilingual).toBe(true);
    expect(modelById(RECOMMENDED_LITE_MODEL_ID)?.multilingual).toBe(true);
  });
});

describe('needsOomAck', () => {
  it('flags models at/above the big-model threshold, not the small ones', () => {
    expect(needsOomAck('Llama-3.2-1B-Instruct-q4f16_1-MLC')).toBe(false); // 879 MB
    expect(needsOomAck('Llama-3.1-8B-Instruct-q4f16_1-MLC')).toBe(true); // 5001 MB
    expect(needsOomAck('unknown-model')).toBe(false);
  });

  it('agrees with the published threshold for every catalog entry', () => {
    for (const m of CHAT_MODELS) {
      expect(needsOomAck(m.id)).toBe(m.sizeMB >= BIG_MODEL_MB);
    }
  });
});
