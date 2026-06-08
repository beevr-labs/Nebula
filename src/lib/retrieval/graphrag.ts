// GraphRAG retrieval (Phase 3) — the quality unlock, and the actual justification for a graph DB.
//
// Plain RAG retrieves chunks that are SEMANTICALLY similar to the query (vector top-K). It misses
// context that is STRUCTURALLY relevant: a chunk that never repeats the query's words but is about
// the same entities. GraphRAG fixes that: take the vector seeds, find the entities they mention,
// then pull in sibling chunks that mention those same entities, and fuse the two signals. Feeding
// the small local LLM structurally-connected context (not just lexical neighbours) is how its
// answers improve WITHOUT a bigger model — the lever for the local-LLM quality ceiling.
//
// This module is the pure ranking/fusion math (unit-tested with fixtures). The DB side — the real
// "vector seed + graph expand" query — is VectorStore.graphRagSearch, which calls fuseGraphRag.

import type { SearchHit } from '$lib/inference/provider';
import type { MentionEdge } from '$lib/graph/types';
import { rrfFuse } from './search';

/** Distinct entity ids mentioned by any of the given chunks (the seeds' entities). */
export function entitiesOfChunks(mentions: MentionEdge[], chunkIds: string[]): string[] {
  const want = new Set(chunkIds);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of mentions) {
    if (!want.has(m.chunkId) || seen.has(m.entityId)) continue;
    seen.add(m.entityId);
    out.push(m.entityId);
  }
  return out;
}

/**
 * Chunks (excluding the seeds) that mention any of `entityIds`, ranked by how many of those
 * entities they share with the seed set — the "graph proximity" ordering. Deterministic
 * (count desc, then chunkId). This is the graph-expansion candidate list.
 */
export function expandByEntities(
  mentions: MentionEdge[],
  entityIds: string[],
  excludeChunkIds: string[]
): string[] {
  const wantEntities = new Set(entityIds);
  const exclude = new Set(excludeChunkIds);
  const sharedCount = new Map<string, number>();
  for (const m of mentions) {
    if (exclude.has(m.chunkId) || !wantEntities.has(m.entityId)) continue;
    sharedCount.set(m.chunkId, (sharedCount.get(m.chunkId) ?? 0) + 1);
  }
  return [...sharedCount.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([chunkId]) => chunkId);
}

/**
 * Choose the answer context from floored vector seeds + the raw graph expansion. The relevance
 * floor MUST already be applied to `relevantSeeds` upstream — that keeps GraphRAG as precise as
 * plain RAG (irrelevant notes never anchor an answer; the no-results guard fires when no seed
 * clears the floor). Graph-expanded siblings are then appended and KEPT even below the floor: they
 * earn inclusion structurally (shared entities), which is the whole point. Deduped against seeds,
 * seed cosine scores preserved (we never surface the internal RRF fusion score to the user).
 *
 * Regression guard (found via live testing): returning the raw RRF-fused set here let unfloored
 * seeds — e.g. an unrelated note — leak into the context and showed ~0.02 RRF scores in the UI.
 */
export function selectGraphRagContext(
  relevantSeeds: SearchHit[],
  expanded: SearchHit[]
): SearchHit[] {
  if (relevantSeeds.length === 0) return []; // no semantic anchor → no-results (don't expand into noise)
  const seedIds = new Set(relevantSeeds.map((h) => h.chunkId));
  return [...relevantSeeds, ...expanded.filter((h) => !seedIds.has(h.chunkId))];
}

export interface GraphRagOptions {
  k?: number; // final context size (default 8)
  rrfK?: number; // RRF constant (default 60)
}

/**
 * Fuse the vector seeds with the graph-expanded chunks via Reciprocal Rank Fusion. `seeds` and
 * `expanded` both carry their cosine score to the query (for the vector ranking); `expanded` MUST
 * be ordered by graph proximity (most-connected first) — that order is the graph ranking. A chunk
 * that is both semantically strong and graph-connected wins; a purely graph-reached chunk can still
 * enter the context on its structural relevance alone. With no expansion this degrades to plain
 * vector order (so GraphRAG never does worse than RAG on recall). Returns ≤k hits, fused score desc.
 */
export function fuseGraphRag(
  seeds: SearchHit[],
  expanded: SearchHit[],
  opts: GraphRagOptions = {}
): SearchHit[] {
  const k = opts.k ?? 8;

  // Universe of candidate chunks, deduped by chunkId (seed record wins — same text either way).
  const byId = new Map<string, SearchHit>();
  for (const h of expanded) if (!byId.has(h.chunkId)) byId.set(h.chunkId, h);
  for (const h of seeds) byId.set(h.chunkId, h); // seeds overwrite, authoritative

  const vectorRanking = [...byId.values()]
    .sort(
      (a, b) => b.score - a.score || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0)
    )
    .map((h) => h.chunkId);

  // Graph ranking: the expansion order (already graph-proximity sorted by the caller).
  const graphRanking = expanded.map((h) => h.chunkId);

  const fused = rrfFuse([vectorRanking, graphRanking], opts.rrfK ?? 60);

  return [...fused.entries()]
    .map(([chunkId, score]) => ({ hit: byId.get(chunkId)!, score }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.hit.chunkId < b.hit.chunkId ? -1 : a.hit.chunkId > b.hit.chunkId ? 1 : 0)
    )
    .slice(0, k)
    .map(({ hit, score }) => ({ ...hit, score }));
}
