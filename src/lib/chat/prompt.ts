// Grounded RAG prompt assembly + no-results guard + citation parsing.
// FR-CHAT-001/002/003 · PROMPTS §1 · ALGORITHMS §4. Pure/deterministic — no GPU.

import type { SearchHit } from '$lib/inference/provider';
import { approxTokenCount, type TokenCounter } from '$lib/ingest/chunker';

/** Exact system prompt (PROMPTS §1) — versioned; changing it must re-run citation tests. */
export const SYSTEM_PROMPT = `You are Nebula's helpful local assistant. Answer the user's question in clear, natural language that an ordinary person understands, grounded in the numbered context chunks from their notes. Rules:
- Treat the context as your source of truth. Give a direct, useful answer — synthesize, don't quote verbatim, don't pad.
- After a claim, cite the chunk number it came from, inline, like [#2] or [#1][#3]. Never cite a number that is not in the list below.
- If the notes only partly cover the question, answer what you reasonably can from them and briefly note what's missing — do NOT refuse outright.
- Only if the notes contain nothing at all related to the question, say so in one plain, friendly sentence. Never use outside knowledge or invent citations.
- Respond with the ANSWER ONLY. Never repeat the question and never print headers or labels like "Notes:", "Question:", "# Question", or "# Answer".`;

// Friendly, human no-results line (only used when retrieval returns zero chunks).
export const NO_RESULTS_MESSAGE = "I couldn't find anything about that in your notes.";

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
  // The question is embedded in a directive SENTENCE (not under a `# Question` header) so a
  // small model answers it instead of "completing the template" by echoing Question/Answer
  // headers (PROMPTS §1, the echo bug). `stripPromptEcho` is the defensive backstop.
  const user = `Notes:\n${blocks}\n\nUsing only these notes, answer this question in plain language and cite the chunk numbers you used: ${query}`;

  return { kind: 'grounded', system: SYSTEM_PROMPT, user, contextOrder };
}

/**
 * Defensive cleanup of a model answer (PROMPTS §1): small on-device models sometimes echo the
 * prompt scaffolding ("# Question … # Answer …"). Strip any echoed Question/Notes/Context lead-in
 * and keep only what follows the last Answer marker. Idempotent; a clean answer passes through.
 */
export function stripPromptEcho(text: string): string {
  let t = text;
  const answerMarkers = [...t.matchAll(/(?:^|\n)\s*#*\s*answer\s*:?[ \t]*\n?/gi)];
  if (answerMarkers.length) {
    const last = answerMarkers[answerMarkers.length - 1];
    t = t.slice((last.index ?? 0) + last[0].length);
  }
  // Drop a leading echoed "Question:" / "# Question …" / "Notes:" / "# Context …" line.
  t = t.replace(/^\s*(?:#+\s*)?(?:question|notes|context)\b[^\n]*\n?/gi, '');
  return t.trim();
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
