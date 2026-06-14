// Grounded RAG prompt assembly + no-results guard + citation parsing.
// FR-CHAT-001/002/003 · PROMPTS §1 · ALGORITHMS §4. Pure/deterministic — no GPU.

import type { SearchHit } from '$lib/inference/provider';
import { approxTokenCount, type TokenCounter } from '$lib/ingest/chunker';

export type AnswerMode = 'grounded' | 'reason';

/**
 * GROUNDED mode (PROMPTS §1) — strict RAG: answer ONLY from the notes, cite everything, never use
 * outside knowledge. Best when the user needs a verifiable, no-hallucination answer. Versioned —
 * changing it must re-run citation tests.
 */
export const SYSTEM_PROMPT = `You are Nebula's helpful local assistant. Answer the user's question in clear, natural language that an ordinary person understands, grounded in the numbered context chunks from their notes. Rules:
- ALWAYS reply in the SAME language as the user's question. If they ask in Vietnamese, answer entirely in Vietnamese; if in English, answer in English. Match their language even when the notes are written in a different one.
- Treat the context as your source of truth. Give a direct, useful answer — synthesize, don't quote verbatim, don't pad.
- When SEVERAL notes are relevant, combine them into one coherent answer and cite each — don't rely on just one note.
- After a claim, cite the chunk number it came from, inline, like [#2] or [#1][#3]. Never cite a number that is not in the list below.
- If the notes only partly cover the question, answer what you reasonably can from them and briefly note what's missing — do NOT refuse outright.
- Only if the notes contain nothing at all related to the question, say so in one plain, friendly sentence. Never use outside knowledge or invent citations.
- If the question is about a specific named person, project, or term that does NOT appear in the context, say you can't find that name in the notes — never attribute another person's or another project's details to it.
- If you think privately before answering, you MUST still write the full answer out afterward as ordinary text — never stop after thinking and never leave the final answer empty.
- Respond with the ANSWER ONLY. Never repeat the question and never print headers or labels like "Notes:", "Question:", "# Question", or "# Answer".`;

/**
 * REASON mode — the notes are the PRIMARY source, but the model is asked to think with them:
 * synthesize, infer, and apply its own knowledge to give a genuinely helpful, problem-solving
 * answer (not just quote). Note-derived claims are still cited; added reasoning must not contradict
 * the notes. Best when the user wants the assistant to actually work the problem using their notes.
 */
export const SYSTEM_PROMPT_REASON = `You are Nebula's local knowledge assistant. The user's notes are your primary, authoritative source — but your job is to genuinely HELP and solve the problem, not just quote. Rules:
- ALWAYS reply in the SAME language as the user's question. If they ask in Vietnamese, answer entirely in Vietnamese; if in English, answer in English. Match their language even when the notes are written in a different one.
- Ground your answer in the numbered context from their notes, and REASON with it: connect ideas across notes, draw sensible inferences, work through the question step by step, and apply relevant general knowledge to give a complete, practical answer.
- Cite the chunk number after any fact taken FROM the notes, inline like [#2] or [#1][#3]. Reasoning or general knowledge you add yourself does not need a citation, but it must stay consistent with the notes and never contradict them. Never cite a number not in the list below.
- Use the notes as far as they go, then reason about the rest. Prefer a real, useful answer over "the notes don't say." Be clear about anything you are inferring rather than reading directly from the notes.
- But if the question asks about a specific named person, project, or term that is not in the notes, say it isn't in your notes — never attribute another note's person or project details to a name that isn't there.
- If you think privately before answering, you MUST still write the full answer out afterward as ordinary text — never stop after thinking and never leave the final answer empty.
- Respond with the ANSWER ONLY. Never repeat the question and never print headers or labels like "Notes:", "Question:", "# Question", or "# Answer".`;

// Friendly, human no-results line (only used when retrieval returns zero chunks).
export const NO_RESULTS_MESSAGE = "I couldn't find anything about that in your notes.";

// Last-resort line when retrieval DID find relevant notes but the model produced an empty answer
// even after a retry (a degenerate generation). Points the user at the cited notes + a rephrase,
// instead of showing a blank answer.
export const EMPTY_ANSWER_MESSAGE =
  "I found relevant notes but couldn't compose an answer this time — see the sources below, or try rephrasing the question.";

export type PromptResult =
  | { kind: 'grounded'; system: string; user: string; contextOrder: string[] }
  | { kind: 'no_results'; message: string };

export interface AssembleOptions {
  maxContextTokens?: number; // drop lowest-scoring chunks first if exceeded (never overflow)
  countTokens?: TokenCounter;
  mode?: AnswerMode; // 'grounded' (default, strict RAG) | 'reason' (apply knowledge with the notes)
  // Force the answer language (e.g. 'Vietnamese'), from the UI locale. When set, a strong directive is
  // prepended to the system prompt that OVERRIDES the default "match the question's language" rule —
  // so a Vietnamese UI always gets a Vietnamese answer even for English notes/questions. Omitted →
  // the system prompt's default behavior (reply in the question's language) is unchanged.
  answerLanguage?: string;
  // Named subjects the question asks about that appear NOWHERE in the user's notes. When set, a
  // turn-specific GROUNDING NOTE is appended to the system prompt so the model won't fabricate a role
  // for them or confuse them with a real note-subject — used by REASON mode (which doesn't hard-stop).
  absentSubjects?: string[];
}

/** Turn-specific grounding hint: names the question asks about that aren't in the notes, so the model
 *  states that plainly instead of borrowing a different note-subject's details (anti-hallucination). */
export function groundingHint(absentSubjects: string[]): string {
  const names = absentSubjects.map((s) => `"${s}"`).join(', ');
  return (
    `GROUNDING NOTE: the following name(s) do NOT appear anywhere in the user's notes: ${names}. ` +
    `Do not claim or imply they have any role, task, or attribute from the notes, and never confuse ` +
    `them with a different person or project that IS in the notes. If the question is about such a ` +
    `name, say plainly it isn't in the notes — you may then reason from general knowledge if it helps.`
  );
}

/** The system-prompt override that pins the answer to one language (UI-locale driven). */
export function languageDirective(language: string): string {
  return (
    `Write your ENTIRE response in ${language}. Use only ${language} — this overrides every other ` +
    `language instruction below: answer in ${language} even if the notes or the question are written ` +
    `in a different language. Keep proper nouns and code as-is.`
  );
}

/**
 * Final language reminder, written IN the target language, appended as the LAST line of the user turn
 * (the position a model weights most as it starts generating). A reminder in the target language
 * anchors output far better than an English "answer in Vietnamese" instruction, which small on-device
 * models leak past — especially on "this isn't in your notes" answers, where the model's meta/reasoning
 * register otherwise defaults to English (the EN/VI mix bug). Falls back to an English line for a
 * language without a native reminder here. Keyed by the SUPPORTED `label` the UI passes as answerLanguage.
 */
const LANG_REMINDER: Record<string, string> = {
  Vietnamese: 'Viết toàn bộ câu trả lời bằng tiếng Việt, không chèn tiếng Anh.',
  English: 'Write your entire answer in English.'
};
export function languageReminder(language: string): string {
  return LANG_REMINDER[language] ?? `Write your entire answer in ${language}.`;
}

function chunkBlock(hit: SearchHit, n: number): string {
  const loc =
    hit.page === undefined ? `source: ${hit.docId}` : `source: ${hit.docId}, p.${hit.page}`;
  return `[#${n}] (${loc})\n${hit.text}`;
}

// Two chunks counting as "the same content" at/above this word-set Jaccard. 0.65 = ~two-thirds of
// the combined vocabulary shared. Template-repetitive lines that differ only in a few entities land
// here ("…tiếp tục dự án Orion. Trao đổi với Linh…" vs "…dự án Atlas. Trao đổi với Hùng…" measures
// ~0.73), while genuinely different chunks share little more than stopwords (~0.1) and are kept.
// Set by the live repro: a 90-line standup transcript collapsed generation; its near-clone lines
// sit at 0.7–0.8, so the threshold must be below that to break the wall.
const DEDUP_JACCARD = 0.65;

/** Unicode-aware word set of a chunk: lowercased, NFKC, split on non-letter/digit so Vietnamese
 *  diacritics stay intact (ASCII `\w` would shred "Hôm" into "H"/"m"). 1-char tokens dropped as noise. */
function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize('NFKC')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Drop near-duplicate chunks BEFORE the context is assembled. Retrieval over a repetitive note (a
 * 90-line standup transcript, a tabular CSV) returns dozens of near-identical chunks; left alone
 * they fill the whole token budget with the same sentence repeated, crowd out the diverse notes
 * that actually answer the question, AND make small models emit an EMPTY answer (reproduced live on
 * both 1.5B and 3B — a wall of repetition collapses generation). Walks hits in score order, keeping
 * each only if it isn't ≥DEDUP_JACCARD similar to one already kept, so the highest-scoring
 * representative of each duplicate cluster survives and the budget fills with VARIED context.
 * Pure/deterministic; preserves input order. O(n·k) over kept set k — n is the retrieved fan-out.
 */
export function dedupeHits(hits: SearchHit[], threshold = DEDUP_JACCARD): SearchHit[] {
  const kept: SearchHit[] = [];
  const keptSets: Set<string>[] = [];
  for (const hit of hits) {
    const ws = wordSet(hit.text);
    if (keptSets.some((s) => jaccard(ws, s) >= threshold)) continue;
    kept.push(hit);
    keptSets.push(ws);
  }
  return kept;
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
  const mode: AnswerMode = opts.mode ?? 'grounded';

  // NO-RESULTS GUARD (PROMPTS §1): only GROUNDED refuses when retrieval is empty — strict RAG must
  // never answer from outside knowledge, so with no context it returns the no-results line. REASON
  // deliberately falls through and answers from general knowledge when the notes have nothing —
  // that's its whole point (an assistant, not a search box; see SYSTEM_PROMPT_REASON).
  if (hits.length === 0 && mode !== 'reason') {
    return { kind: 'no_results', message: NO_RESULTS_MESSAGE };
  }

  const count = opts.countTokens ?? approxTokenCount;
  const budget = opts.maxContextTokens ?? Infinity;

  // Collapse near-duplicate chunks first so a repetitive note can't fill the budget with the same
  // line over and over (which both starves diverse context and empties small-model output).
  const deduped = dedupeHits(hits);

  // hits are in descending score; include greedily until the budget is hit.
  const included: SearchHit[] = [];
  let used = 0;
  for (const hit of deduped) {
    const cost = count(chunkBlock(hit, included.length + 1));
    if (included.length > 0 && used + cost > budget) break;
    if (included.length === 0 && cost > budget) {
      // A single lead chunk bigger than the whole budget — a long note read whole (reason mode) or
      // an unsplit note. The old "keep at least one" included it verbatim, overflowing the model's
      // context window (WebLLM throws → blank answer). TRUNCATE it to fit instead so the highest-
      // scoring source still grounds the answer. Text only — chunkId/citation mapping is unchanged.
      const overhead = count(chunkBlock({ ...hit, text: '' }, 1));
      const room = Math.max(1, budget - overhead);
      const words = hit.text.split(/\s+/);
      const text = words.slice(0, room).join(' ') + (words.length > room ? ' …' : '');
      const truncated = { ...hit, text };
      included.push(truncated);
      used += count(chunkBlock(truncated, 1));
      continue;
    }
    included.push(hit);
    used += cost;
  }

  const contextOrder = included.map((h) => h.chunkId);
  const blocks = included.map((h, i) => chunkBlock(h, i + 1)).join('\n\n');
  const hasContext = included.length > 0;
  // The question is embedded in a directive SENTENCE (not under a `# Question` header) so a
  // small model answers it instead of "completing the template" by echoing Question/Answer
  // headers (PROMPTS §1, the echo bug). `stripPromptEcho` is the defensive backstop.
  let directive: string;
  if (mode === 'reason') {
    directive = hasContext
      ? `Using these notes as your main source, reason and apply your knowledge to give a genuinely helpful answer, citing the chunk numbers for anything taken from the notes`
      : // Reason + no relevant notes: answer purely from general knowledge (no context to cite).
        `Answer this question helpfully and accurately using your own knowledge`;
  } else {
    directive = `Using only these notes, answer this question in plain language and cite the chunk numbers you used`;
  }
  // Repeat the language requirement INSIDE the user turn, right before the question — the spot a model
  // weights most. The system override alone slipped to English on number/list-heavy answers whose notes
  // were English; this in-turn reminder makes the UI language stick.
  if (opts.answerLanguage) directive += `, written entirely in ${opts.answerLanguage}`;
  // Omit the empty "Notes:" scaffold when there is no context, so the model isn't told to read notes that aren't there.
  let user = hasContext
    ? `Notes:\n${blocks}\n\n${directive}: ${query}`
    : `${directive}: ${query}`;
  // Append the language reminder IN the target language as the final line — the strongest anchor against
  // the EN/VI mix (the English language-directive alone leaks on meta/"not in notes" reason answers).
  if (opts.answerLanguage) user += `\n\n${languageReminder(opts.answerLanguage)}`;
  const base = mode === 'reason' ? SYSTEM_PROMPT_REASON : SYSTEM_PROMPT;
  // Pin the answer language (UI locale) by prepending a strong override; left untouched when omitted so
  // the default "reply in the question's language" rule (and the prompt-equality tests) still hold.
  let system = opts.answerLanguage
    ? `${languageDirective(opts.answerLanguage)}\n\n${base}`
    : base;
  // Append the turn-specific grounding hint (reason mode's soft anti-hallucination): names the question
  // asks about that aren't in the notes, so the model states that instead of fabricating a role.
  if (opts.absentSubjects && opts.absentSubjects.length > 0)
    system = `${system}\n\n${groundingHint(opts.absentSubjects)}`;

  return { kind: 'grounded', system, user, contextOrder };
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

/** One completed Q→A exchange, replayed into the prompt so a follow-up keeps the thread (FR-CHAT-006). */
export interface ChatTurn {
  query: string;
  answer: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Build the model's message list for one turn: system prompt, then the prior turns replayed as
 * user/assistant pairs, then THIS turn's grounded user message (which already carries the retrieved
 * Notes + directive + question). Prior turns are replayed verbatim (no re-injected context) — the
 * running thread is what gives a follow-up like "and the second one?" its referent, while the
 * current turn's freshly-retrieved context grounds the new answer. Pure/deterministic.
 */
export function buildChatMessages(
  system: string,
  user: string,
  history: ChatTurn[] = []
): ChatMessage[] {
  return [
    { role: 'system', content: system },
    ...history.flatMap((t): ChatMessage[] => [
      { role: 'user', content: t.query },
      { role: 'assistant', content: t.answer }
    ]),
    { role: 'user', content: user }
  ];
}

/**
 * Normalize near-miss citation markers a small model emits — `[:#3]`, `[ #3]`, `[ref #3]`, `[#3 ]` —
 * to the canonical `[#3]` so they parse + render as real, clickable citations instead of leaking into
 * the answer as broken text (observed live: a 7B model wrote `[:#5]`). Only rewrites brackets that
 * ALREADY contain `#<digits>`, so a bare `[3]` (ambiguous with footnotes / list markers / array
 * indices in note text) is deliberately left alone. Idempotent — canonical markers pass through.
 */
export function normalizeCitationMarkers(text: string): string {
  return text.replace(/\[[^\]\d#]*#\s*(\d+)\s*\]/g, '[#$1]');
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
