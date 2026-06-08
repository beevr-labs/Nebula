// Cost honesty for a compiled payload (CE5, FR-CTX-011) — what will this context actually cost, and
// will it even fit? Given a token count and a target cloud model, report the model's context window,
// whether the payload fits (and by how much it's over), and an estimated input cost. Pure data +
// pure functions — no network, no GPU — so the numbers are testable and deterministic. ALGORITHMS §5.
//
// Prices & windows are INDICATIVE and dated (see PRICED_AS_OF); they move, so the report flags whether
// the model was recognized. An unknown model falls back to a conservative window + no price (known:false)
// rather than guessing — honesty over false precision.

export type TokenizerName = 'cl100k_base' | 'o200k_base';

export interface ModelCost {
  id: string; // canonical id used in the picker / manifest
  family: 'claude' | 'gpt';
  label: string;
  contextWindow: number; // max input+output tokens the model accepts
  inputPricePerMTok: number; // USD per 1,000,000 input tokens
  tokenizer: TokenizerName;
}

export const PRICED_AS_OF = '2026-06'; // indicative; verify against the provider's current pricing page

// Current-ish Claude + GPT families. Windows are the documented context sizes; prices are input $/Mtok.
export const MODEL_COSTS: ModelCost[] = [
  { id: 'claude-opus-4', family: 'claude', label: 'Claude Opus 4', contextWindow: 200_000, inputPricePerMTok: 15, tokenizer: 'cl100k_base' }, // prettier-ignore
  { id: 'claude-sonnet-4', family: 'claude', label: 'Claude Sonnet 4', contextWindow: 200_000, inputPricePerMTok: 3, tokenizer: 'cl100k_base' }, // prettier-ignore
  { id: 'claude-3-5-sonnet', family: 'claude', label: 'Claude 3.5 Sonnet', contextWindow: 200_000, inputPricePerMTok: 3, tokenizer: 'cl100k_base' }, // prettier-ignore
  { id: 'claude-3-5-haiku', family: 'claude', label: 'Claude 3.5 Haiku', contextWindow: 200_000, inputPricePerMTok: 0.8, tokenizer: 'cl100k_base' }, // prettier-ignore
  { id: 'gpt-4o', family: 'gpt', label: 'GPT-4o', contextWindow: 128_000, inputPricePerMTok: 2.5, tokenizer: 'o200k_base' }, // prettier-ignore
  { id: 'gpt-4o-mini', family: 'gpt', label: 'GPT-4o mini', contextWindow: 128_000, inputPricePerMTok: 0.15, tokenizer: 'o200k_base' }, // prettier-ignore
  { id: 'gpt-4-turbo', family: 'gpt', label: 'GPT-4 Turbo', contextWindow: 128_000, inputPricePerMTok: 10, tokenizer: 'cl100k_base' }, // prettier-ignore
  { id: 'gpt-4', family: 'gpt', label: 'GPT-4', contextWindow: 8_192, inputPricePerMTok: 30, tokenizer: 'cl100k_base' }, // prettier-ignore
  { id: 'gpt-3.5-turbo', family: 'gpt', label: 'GPT-3.5 Turbo', contextWindow: 16_385, inputPricePerMTok: 0.5, tokenizer: 'cl100k_base' } // prettier-ignore
];

/** A conservative default for an unrecognized model: a common 128k window, cl100k tokenizer, no price. */
export const UNKNOWN_MODEL = {
  contextWindow: 128_000,
  tokenizer: 'cl100k_base' as TokenizerName
};

/** Resolve a target model string to a known cost profile (exact id, then a tolerant family/prefix match). */
export function resolveModelCost(targetModel: string): ModelCost | null {
  const key = targetModel.trim().toLowerCase();
  const exact = MODEL_COSTS.find((m) => m.id === key);
  if (exact) return exact;
  // Tolerant match: the longest known id that is a prefix of, or contained in, the requested name.
  const candidates = MODEL_COSTS.filter((m) => key.includes(m.id) || m.id.includes(key));
  if (candidates.length) return candidates.sort((a, b) => b.id.length - a.id.length)[0];
  return null;
}

export interface CostReport {
  targetModel: string;
  known: boolean; // false → the model wasn't recognized; window/tokenizer are conservative defaults, price omitted
  tokens: number;
  contextWindow: number;
  fitsWindow: boolean;
  overBy: number; // tokens above the window (0 when it fits) — drives the "⚠ over by N" warning
  utilization: number; // tokens / contextWindow, rounded to 3dp
  estInputCostUSD: number | null; // null when the price is unknown
  tokenizer: TokenizerName;
  pricedAsOf: string;
}

/**
 * Report token cost + context-window fit for a payload of `tokens` tokens aimed at `targetModel`.
 * Known model → real window + estimated input cost; unknown model → conservative window, no price,
 * `known:false` (so the UI can say "estimate, model not recognized"). Pure + deterministic.
 */
export function costReport(tokens: number, targetModel: string): CostReport {
  const m = resolveModelCost(targetModel);
  const contextWindow = m?.contextWindow ?? UNKNOWN_MODEL.contextWindow;
  const tokenizer = m?.tokenizer ?? UNKNOWN_MODEL.tokenizer;
  const overBy = Math.max(0, tokens - contextWindow);
  const estInputCostUSD = m
    ? Math.round((tokens / 1_000_000) * m.inputPricePerMTok * 1e6) / 1e6 // round to micro-dollars
    : null;
  return {
    targetModel,
    known: !!m,
    tokens,
    contextWindow,
    fitsWindow: overBy === 0,
    overBy,
    utilization: Math.round((tokens / contextWindow) * 1000) / 1000,
    estInputCostUSD,
    tokenizer,
    pricedAsOf: PRICED_AS_OF
  };
}

/** One-line human summary for the compile UI, e.g. "≈$0.0072 · 2,450 / 200,000 tok (1%)". */
export function formatCost(r: CostReport): string {
  const price = r.estInputCostUSD === null ? 'price n/a' : `≈$${r.estInputCostUSD.toFixed(4)}`;
  const fit = r.fitsWindow
    ? `${r.tokens.toLocaleString()} / ${r.contextWindow.toLocaleString()} tok (${Math.round(r.utilization * 100)}%)`
    : `⚠ over ${r.targetModel}'s window by ${r.overBy.toLocaleString()} tok`;
  return `${price} · ${fit}${r.known ? '' : ' · model not recognized (estimate)'}`;
}
