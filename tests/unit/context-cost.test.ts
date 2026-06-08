import { describe, it, expect } from 'vitest';
import {
  costReport,
  resolveModelCost,
  formatCost,
  UNKNOWN_MODEL
} from '../../src/lib/context/cost';

// CE5 — cost honesty (FR-CTX-011 · ALGORITHMS §5). Token cost + context-window fit across Claude/GPT
// families, with a flagged fallback for unknown models. Pure + deterministic.

describe('resolveModelCost', () => {
  it('matches exact ids and tolerant family names', () => {
    expect(resolveModelCost('gpt-4o')?.id).toBe('gpt-4o');
    expect(resolveModelCost('Claude-3-5-Sonnet')?.id).toBe('claude-3-5-sonnet'); // case-insensitive
    expect(resolveModelCost('gpt-4o-2024-11-20')?.id).toBe('gpt-4o'); // dated suffix → base model
    expect(resolveModelCost('llama-3')).toBeNull();
  });
});

describe('costReport', () => {
  it('reports a known model with window fit + estimated input cost', () => {
    const r = costReport(2450, 'claude-3-5-sonnet');
    expect(r.known).toBe(true);
    expect(r.contextWindow).toBe(200_000);
    expect(r.fitsWindow).toBe(true);
    expect(r.overBy).toBe(0);
    expect(r.estInputCostUSD).toBeCloseTo((2450 / 1_000_000) * 3, 6); // $3/Mtok
    expect(r.tokenizer).toBe('cl100k_base');
  });

  it('warns (overBy > 0) when the payload exceeds the window', () => {
    const r = costReport(20_000, 'gpt-4'); // 8,192 window
    expect(r.fitsWindow).toBe(false);
    expect(r.overBy).toBe(20_000 - 8_192);
    expect(formatCost(r)).toContain('⚠ over');
  });

  it('falls back conservatively for an unknown model (no price, flagged)', () => {
    const r = costReport(1000, 'some-future-model');
    expect(r.known).toBe(false);
    expect(r.contextWindow).toBe(UNKNOWN_MODEL.contextWindow);
    expect(r.estInputCostUSD).toBeNull();
    expect(formatCost(r)).toContain('model not recognized');
  });

  it('is deterministic for a fixed input', () => {
    expect(costReport(1234, 'gpt-4o')).toEqual(costReport(1234, 'gpt-4o'));
  });
});
