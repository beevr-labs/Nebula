// Retrieval — cosine top-K (FR-RET-001) + Reciprocal Rank Fusion (FR-RET-003, Phase 2)
// + the no-results relevance floor (ALGORITHMS §3, FR-CHAT-002).
//
// Pure & deterministic over an in-memory index of embedded chunks — unit/integration
// testable with fixtures, no GPU/DB. In production the index + cosine KNN run in the
// SurrealDB HNSW worker; this module is the ranking/fusion logic that the worker and
// tests share. Vectors are L2-normalized at write time (ALGORITHMS §2); we still
// divide by norms here so non-normalized fixtures score correctly.

import type { SearchHit } from '$lib/inference/provider';

export interface IndexedChunk {
  chunkId: string;
  docId: string;
  text: string;
  page?: number;
  charStart: number;
  charEnd: number;
  embedding: number[];
}

export interface SearchOptions {
  k?: number; // top-K, default 8 (FR-RET-001)
  floor?: number; // relevance floor; if max score is below it, return [] (no-results rule)
}

export interface HybridOptions extends SearchOptions {
  rrfK?: number; // RRF constant, default 60 (ALGORITHMS §3)
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function toHit(c: IndexedChunk, score: number): SearchHit {
  return {
    chunkId: c.chunkId,
    docId: c.docId,
    text: c.text,
    page: c.page,
    charStart: c.charStart,
    charEnd: c.charEnd,
    score
  };
}

/** Deterministic tie-break so equal scores produce a stable order. */
function byScoreThenId(a: { id: string; score: number }, b: { id: string; score: number }): number {
  return b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Cosine top-K over the index (FR-RET-001). Returns ≤K hits in descending score,
 * each with source + page + span. Applies the no-results rule (ALGORITHMS §3):
 * if the best score is below `floor`, return [] so the caller never feeds the LLM
 * irrelevant context (and never fabricates citations — FR-CHAT-002).
 */
export function vectorSearch(
  query: number[],
  index: IndexedChunk[],
  opts: SearchOptions = {}
): SearchHit[] {
  const k = opts.k ?? 8;
  const floor = opts.floor ?? -Infinity;
  const scored = index
    .map((c) => ({ id: c.chunkId, score: cosineSimilarity(query, c.embedding), c }))
    .sort(byScoreThenId);
  if (scored.length === 0 || scored[0].score < floor) return [];
  return scored.slice(0, k).map(({ c, score }) => toHit(c, score));
}

/**
 * Reciprocal Rank Fusion: fused(d) = Σ_r 1 / (k + rank_r(d)). Needs no score
 * normalization across rankers — why it's preferred for hybrid retrieval (ALGORITHMS §3).
 */
export function rrfFuse(rankings: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, idx) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + (idx + 1)));
    });
  }
  return scores;
}

/**
 * Diacritic-fold + lowercase for ACCENT-INSENSITIVE lexical matching. Vietnamese text is routinely
 * written both with and without tone/vowel marks (legacy exports, filenames, telegraphic notes), so a
 * query "Hoả Phong" must still match a note that stored "Hoa Phong" and vice versa. NFD splits a
 * precomposed letter into base + combining marks (U+0300–U+036F), which we strip; "đ/Đ" are separate
 * letters (not decomposed) so they're mapped explicitly. ASCII text is unaffected, so English exact-
 * term matching (IDs, names) is preserved. Used by the lexical recall channel + precision re-rank.
 */
export function foldDiacritics(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

/** Lightweight lexical (BM25-stand-in) score: count accent-insensitive exact SUBSTRING term hits. Kept
 *  for `hybridSearch`, whose terms are exact IDs/names/symbols where substring matching is wanted. */
function lexicalScore(text: string, terms: string[]): number {
  const hay = foldDiacritics(text);
  let score = 0;
  for (const term of terms) {
    const t = foldDiacritics(term);
    if (t.length === 0) continue;
    let from = 0;
    let idx = hay.indexOf(t, from);
    while (idx !== -1) {
      score += 1;
      from = idx + t.length;
      idx = hay.indexOf(t, from);
    }
  }
  return score;
}

/**
 * WHOLE-WORD term overlap (count of query terms present as full words in `text`). Unlike the
 * substring `lexicalScore`, this won't let a weak query term like "end" (from "quarter-end") match
 * inside "spend" / "send" — critical for the precision re-rank + noise gate over natural-language
 * notes, where a false substring hit would wrongly rescue a cross-deal note. Unicode word split.
 * Exported for the DB-side lexical recall channel (VectorStore.lexicalSearch), which over-fetches
 * with substring CONTAINS in-DB and then applies THIS whole-word filter to drop the false hits.
 */
export function wordTermScore(text: string, terms: string[]): number {
  const words = new Set(
    foldDiacritics(text)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
  );
  let score = 0;
  for (const t of terms) if (words.has(foldDiacritics(t))) score += 1;
  return score;
}

/**
 * Hybrid retrieval (FR-RET-003, Phase 2): fuse the vector ranking with an exact-term
 * lexical ranking via RRF. Recovers exact IDs/names/symbols that pure cosine misses,
 * so hybrid recall ≥ pure-vector recall on exact terms (TC-RET-003).
 */
export function hybridSearch(
  query: number[],
  queryTerms: string[],
  index: IndexedChunk[],
  opts: HybridOptions = {}
): SearchHit[] {
  const k = opts.k ?? 8;

  const vectorRanking = index
    .map((c) => ({ id: c.chunkId, score: cosineSimilarity(query, c.embedding) }))
    .sort(byScoreThenId)
    .map((x) => x.id);

  const lexicalRanking = index
    .map((c) => ({ id: c.chunkId, score: lexicalScore(c.text, queryTerms) }))
    .filter((x) => x.score > 0)
    .sort(byScoreThenId)
    .map((x) => x.id);

  const fused = rrfFuse([vectorRanking, lexicalRanking], opts.rrfK ?? 60);
  const byId = new Map(index.map((c) => [c.chunkId, c]));

  return [...fused.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort(byScoreThenId)
    .slice(0, k)
    .map(({ id, score }) => toHit(byId.get(id) as IndexedChunk, score));
}

// Short, high-frequency English words that carry no retrieval signal — dropped from query terms so
// the lexical re-rank keys on the distinctive content words (esp. proper nouns) that actually
// separate the right note from a topically-similar one. (Tokens < 3 chars are dropped too, which
// already removes "is/of/to/an/or/we/it", so this only needs the ≥3-char stop words.)
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'was',
  'were',
  'our',
  'you',
  'your',
  'this',
  'that',
  'these',
  'those',
  'with',
  'what',
  'who',
  'whom',
  'whose',
  'which',
  'how',
  'why',
  'when',
  'where',
  'does',
  'did',
  'can',
  'could',
  'will',
  'would',
  'should',
  'has',
  'have',
  'had',
  'not',
  'but',
  'its',
  'his',
  'her',
  'from',
  'into',
  'about',
  'they',
  'them',
  'their',
  'than',
  'then',
  'out',
  'get',
  'any',
  'all'
]);

/**
 * Tokenize a query into distinctive lexical terms for the hybrid re-rank: lowercased, deduped,
 * ≥3 chars, stop-words removed. Unicode-aware split (keeps Vietnamese / accented content words).
 */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (tok.length < 3 || STOP_WORDS.has(tok) || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/**
 * Precision re-rank (FR-RET-003): re-order already-retrieved hits by fusing their VECTOR rank with
 * an exact-term LEXICAL rank (RRF). A note that is merely TOPICALLY similar to the query but never
 * names its subject (the classic dense-retrieval false positive — e.g. an unrelated invoice scoring
 * high on a "budget" question) gets only its vector contribution and is demoted beneath notes that
 * actually contain the query's distinctive terms; the per-doc cap downstream then drops it. Pure +
 * order-only: each hit keeps its cosine `score` (the relevance floor + Sources display rely on it),
 * and the call is a NO-OP when the query shares no lexical term with any hit (recall preserved).
 */
export function hybridRerank<T extends { chunkId: string; text: string; score: number }>(
  hits: T[],
  terms: string[],
  rrfK = 60
): T[] {
  if (hits.length <= 1 || terms.length === 0) return hits;
  const vectorRanking = hits.map((h) => h.chunkId); // hits arrive sorted desc by cosine
  const lexicalRanking = hits
    .map((h) => ({ id: h.chunkId, score: wordTermScore(h.text, terms) }))
    .filter((x) => x.score > 0)
    .sort(byScoreThenId)
    .map((x) => x.id);
  if (lexicalRanking.length === 0) return hits; // no lexical signal at all → leave order untouched
  const fused = rrfFuse([vectorRanking, lexicalRanking], rrfK);
  const cosine = new Map(hits.map((h) => [h.chunkId, h.score]));
  return [...hits].sort((a, b) => {
    const fa = fused.get(a.chunkId) ?? 0;
    const fb = fused.get(b.chunkId) ?? 0;
    return (
      fb - fa ||
      (cosine.get(b.chunkId) ?? 0) - (cosine.get(a.chunkId) ?? 0) ||
      (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0)
    );
  });
}

/**
 * Merge the exact-term LEXICAL recall channel into an already-selected context (the recall half of
 * FR-RET-003). `hybridRerank` can only re-order what the vector pass RETURNED — a chunk that names
 * the query's exact term (an ID, a person, a project) but sits outside the HNSW top-K can never
 * surface through re-ranking alone. This appends those independently-retrieved lexical hits:
 *   • context non-empty → append up to `maxAdd` lexical hits not already present (recall top-up;
 *     the cap keeps a generic term from flooding the context — precision gates run downstream).
 *   • context EMPTY (no vector seed cleared the relevance floor) → the lexical hits BECOME the
 *     context (the "exact ID" rescue: embeddings are weakest exactly where literal match is total).
 * Pure + order-preserving; a no-op with no lexical hits, so recall never regresses.
 */
export function withLexicalChannel<T extends { chunkId: string }>(
  context: T[],
  lexical: T[],
  opts: { maxAdd?: number } = {}
): T[] {
  const maxAdd = opts.maxAdd ?? 4;
  const have = new Set(context.map((h) => h.chunkId));
  const fresh = lexical.filter((h) => !have.has(h.chunkId)).slice(0, maxAdd);
  if (fresh.length === 0) return context;
  return context.length === 0 ? fresh : [...context, ...fresh];
}

/**
 * The documents the query ANCHORS to via the knowledge graph — its SUBJECT CLUSTER. Two hops:
 *   1. Seed: notes that mention an entity the query names (full name in the query, or a distinctive
 *      ≥4-char word of the name appears as a query term) — e.g. the notes mentioning "Project Harmony".
 *   2. Expand: notes that mention any entity CO-OCCURRING in a seed note — e.g. a "Project Harmony"
 *      seed also names "Yamaha", so the POC note (which names Yamaha but not "Project Harmony") joins
 *      the cluster. This is the graph-native inclusion GraphRAG is for, computed from entity mentions.
 *
 * This is a far stronger relevance signal than raw lexical/topic overlap — it keys on the subject,
 * not generic words ("budget", "end") a cross-deal invoice happens to share — and, being mention-
 * based, it deliberately EXCLUDES a note that only got graph-expanded through a spurious shared
 * entity (an invoice linked in via a junk node), because that note names nothing in the cluster.
 * Empty when the query names no known entity (caller treats it as "no anchor" → keeps all; recall-safe).
 */
export function entityAnchorDocs(
  query: string,
  entities: { name: string; docIds: string[] }[]
): Set<string> {
  // Diacritic-fold both sides so a "Hoả Phong" query still anchors to a "Hoa Phong" entity (the same
  // accent-insensitivity the lexical channel uses — otherwise the entity-denoise step drops the
  // lexical rescue of a no-diacritic note). ASCII names are unaffected.
  const qlc = foldDiacritics(query);
  const qWords = new Set(queryTerms(query).map(foldDiacritics));
  // A name-word only anchors if it's DISTINCTIVE — present in exactly one entity's name. This stops a
  // generic shared token like "project" (in "Project Harmony", "Project Falcon", "Project Orion")
  // from cross-anchoring every deal; "harmony"/"falcon" (unique to one) still anchor precisely.
  const nameWordFreq = new Map<string, number>();
  for (const e of entities) {
    for (const w of new Set(
      foldDiacritics(e.name)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((x) => x.length >= 4)
    )) {
      nameWordFreq.set(w, (nameWordFreq.get(w) ?? 0) + 1);
    }
  }
  const seedDocs = new Set<string>();
  for (const e of entities) {
    const nameLc = foldDiacritics(e.name);
    if (nameLc.length < 3) continue;
    const named =
      qlc.includes(nameLc) ||
      nameLc
        .split(/[^\p{L}\p{N}]+/u)
        .some((w) => w.length >= 4 && nameWordFreq.get(w) === 1 && qWords.has(w));
    if (named) for (const d of e.docIds) seedDocs.add(d);
  }
  if (seedDocs.size === 0) return seedDocs; // query named no known entity → no anchor
  // Hop 2: any entity that co-occurs in a seed note pulls in the rest of its notes (subject cluster).
  const docs = new Set(seedDocs);
  for (const e of entities) {
    if (e.docIds.some((d) => seedDocs.has(d))) for (const d of e.docIds) docs.add(d);
  }
  return docs;
}

/**
 * Restrict hits to the query's entity-anchored documents (FR-CHAT-002 precision) — a hit on a note
 * that mentions NONE of the entities the query named, isn't `protect`-ed (graph-connected siblings
 * keep their structural inclusion), and isn't a strong standalone semantic match (cosine ≥
 * `strongCosine`) is a different subject (the cross-deal invoice / another client's deal) and is
 * dropped, so even a weak model never SEES it — precision must not depend on the LLM ignoring noise.
 * Recall-safe: a NO-OP when the query anchored to no entity (`anchorDocs` empty), and any genuinely
 * strong semantic match survives regardless. Order preserved.
 */
export function restrictToEntities<T extends { chunkId: string; docId: string; score: number }>(
  hits: T[],
  anchorDocs: ReadonlySet<string>,
  opts: { protect?: ReadonlySet<string>; strongCosine?: number } = {}
): T[] {
  if (anchorDocs.size === 0) return hits; // query named no known entity → keep all (recall-safe)
  const protect = opts.protect ?? new Set<string>();
  const strong = opts.strongCosine ?? 0.6;
  return hits.filter((h) => anchorDocs.has(h.docId) || protect.has(h.chunkId) || h.score >= strong);
}

/**
 * Keep the single best (first) hit per document, preserving rank order (FR-RET-001). Used to
 * favor breadth across DISTINCT relevant documents — so a grounded answer synthesizes from
 * several notes at once instead of multiple chunks of the same one. `maxDocs` caps the count.
 */
export function dedupeByDoc<T extends { docId: string }>(hits: T[], maxDocs = Infinity): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const h of hits) {
    if (seen.has(h.docId)) continue;
    seen.add(h.docId);
    out.push(h);
    if (out.length >= maxDocs) break;
  }
  return out;
}

export interface RelevanceOptions {
  /** Absolute cosine floor — a hit below this is never relevant, even if it's the top hit. */
  absolute?: number; // default 0.45 (bge-m3)
  /** Relative band: keep hits scoring ≥ topScore × relative (drops the long, low-score tail). */
  relative?: number; // default 0.75 (bge-m3)
}

/**
 * Trim retrieved hits to the ones ACTUALLY relevant to the query, so References + Micro-Map + the
 * grounded context don't carry low-score noise (FR-CHAT-002). The over-fetch (k=12/24) favors
 * recall; this is the precision pass on top of it. Assumes `hits` is sorted desc by score (as
 * vectorSearch / hybridSearch return). A hit survives iff it clears BOTH:
 *   • the absolute floor (a low cosine is noise regardless of the rest), and
 *   • the relative band below the top hit (so one strong hit doesn't drag in weak ones).
 * Returns [] when even the top hit is below the absolute floor — the caller's no-results guard
 * then fires (NO_RESULTS_MESSAGE) instead of inventing citations.
 *
 * Defaults are calibrated for **bge-m3** (ADR-029), whose cosine scores are COMPRESSED: a strong
 * match lands ~0.6–0.75 and unrelated docs sit ~0.4–0.5 (much less spread than bge-small). The old
 * 0.35/0.6 floor let that noise through — e.g. an invoice scoring 0.45 surfaced for a security
 * question. The relative band (0.75) does the work; the absolute (0.45) is a safety floor.
 */
export function relevantHits<T extends { score: number }>(
  hits: T[],
  opts: RelevanceOptions = {}
): T[] {
  const absolute = opts.absolute ?? 0.45;
  const relative = opts.relative ?? 0.75;
  if (hits.length === 0 || hits[0].score < absolute) return [];
  const cutoff = Math.max(absolute, hits[0].score * relative);
  return hits.filter((h) => h.score >= cutoff);
}

export interface SourceRef {
  n: number; // 1-based reference number, aligned with the inline [#n] citation
  docId: string;
  chunkId: string;
}

/**
 * The distinct source documents behind an answer, numbered for a "References" list at the foot
 * of the answer. Numbers line up 1:1 with the inline `[#n]` citation order (FR-CHAT-002/003).
 */
export function referencesFromHits(hits: { docId: string; chunkId: string }[]): SourceRef[] {
  return dedupeByDoc(hits).map((h, i) => ({ n: i + 1, docId: h.docId, chunkId: h.chunkId }));
}
