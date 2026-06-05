// Grounded RAG prompt assembly + no-results guard + citation parsing.
// FR-CHAT-001/002/003 · PROMPTS §1 · ALGORITHMS §4. Pure/deterministic — no GPU.

import type { SearchHit } from '$lib/inference/provider';
import { approxTokenCount, type TokenCounter } from '$lib/ingest/chunker';

/** Exact system prompt (PROMPTS §1) — versioned; changing it must re-run citation tests. */
export const SYSTEM_PROMPT = `You are Nebula's local assistant. Answer the user's question using ONLY the numbered
context chunks provided. Rules:
- Cite every claim with the chunk number it came from, inline, like [#2] or [#1][#3].
- If the context does not contain the answer, reply exactly: "No relevant context found."
  Do not use outside knowledge and do not invent citations.
- Be concise. Do not repeat the context verbatim; synthesize.
- Never output a citation number that is not in the context list below.`;

export const NO_RESULTS_MESSAGE = 'No relevant context found.';

export type PromptResult =
  | { kind: 'grounded'; system: string; user: string; contextOrder: string[] }
  | { kind: 'no_results'; message: string };

export interface AssembleOptions {
  maxContextTokens?: number; // drop lowest-scoring chunks first if exceeded (never overflow)
  countTokens?: TokenCounter;
}

function chunkBlock(hit: SearchHit, n: number): string {
  const loc =
    hit.page === undefined ? `source: ${hit.docId}` : `source: ${hit.docId}, p.${hit.page}`;
  return `[#${n}] (${loc})\n${hit.text}`;
}

/**
 * Assemble the grounded prompt. NO-RESULTS GUARD (PROMPTS §1): if there are no hits
 * (the relevance floor already returned [] upstream), do NOT build a model call —
 * return the no-results result so the caller answers directly and never fabricates
 * citations. Applies the context budget by dropping lowest-scoring chunks first.
 */
export function assemblePrompt(
  query: string,
  hits: SearchHit[],
  opts: AssembleOptions = {}
): PromptResult {
  if (hits.length === 0) {
    return { kind: 'no_results', message: NO_RESULTS_MESSAGE };
  }

  const count = opts.countTokens ?? approxTokenCount;
  const budget = opts.maxContextTokens ?? Infinity;

  // hits are in descending score; include greedily until the budget is hit.
  const included: SearchHit[] = [];
  let used = 0;
  for (const hit of hits) {
    const cost = count(chunkBlock(hit, included.length + 1));
    if (included.length > 0 && used + cost > budget) break; // keep at least one
    included.push(hit);
    used += cost;
  }

  const contextOrder = included.map((h) => h.chunkId);
  const blocks = included.map((h, i) => chunkBlock(h, i + 1)).join('\n\n');
  const user = `# Context\n${blocks}\n\n# Question\n${query}`;

  return { kind: 'grounded', system: SYSTEM_PROMPT, user, contextOrder };
}

export interface ParsedCitation {
  chunkId: string;
  spanInAnswer: [number, number]; // char offsets of the [#n] marker in the answer
}

export interface CitationParse {
  citations: ParsedCitation[];
  dropped: number; // markers whose number had no matching context chunk (PROMPTS §1)
}

/**
 * Parse `[#n]` markers from a (possibly streamed) answer and map n → chunkId via
 * `contextOrder` (1-based). Markers with no matching chunk are dropped + counted —
 * they must never render as a live citation (FR-CHAT-002/003).
 */
export function parseCitations(answer: string, contextOrder: string[]): CitationParse {
  const citations: ParsedCitation[] = [];
  let dropped = 0;
  const re = /\[#(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    const n = Number(m[1]);
    const chunkId = contextOrder[n - 1];
    if (chunkId === undefined) {
      dropped += 1;
      continue;
    }
    citations.push({ chunkId, spanInAnswer: [m.index, m.index + m[0].length] });
  }
  return { citations, dropped };
}
