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

/** Lightweight lexical (BM25-stand-in) score: count case-insensitive exact term hits. */
function lexicalScore(text: string, terms: string[]): number {
  const hay = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const t = term.toLowerCase();
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
  absolute?: number; // default 0.35
  /** Relative band: keep hits scoring ≥ topScore × relative (drops the long, low-score tail). */
  relative?: number; // default 0.6
}

/**
 * Trim retrieved hits to the ones ACTUALLY relevant to the query, so References + Micro-Map + the
 * grounded context don't carry low-score noise (FR-CHAT-002). The over-fetch (k=12/24) favors
 * recall; this is the precision pass on top of it. Assumes `hits` is sorted desc by score (as
 * vectorSearch / hybridSearch return). A hit survives iff it clears BOTH:
 *   • the absolute floor (a 0.31 cosine is noise regardless of the rest), and
 *   • the relative band below the top hit (so one strong hit at 0.83 doesn't drag in a 0.49).
 * Returns [] when even the top hit is below the absolute floor — the caller's no-results guard
 * then fires (NO_RESULTS_MESSAGE) instead of inventing citations.
 */
export function relevantHits<T extends { score: number }>(
  hits: T[],
  opts: RelevanceOptions = {}
): T[] {
  const absolute = opts.absolute ?? 0.35;
  const relative = opts.relative ?? 0.6;
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
