// Per-note graph ingestion — the extract → resolve → persist orchestration (Phase 1).
//
// This is the glue that turns ONE note's text into persisted graph state: entity nodes, chunk-level
// mention edges (provenance), and relation edges. It was inlined in the page component; pulling it
// here makes the WHOLE path integration-testable against a real store with a stubbed generator (no
// GPU), and gives the page a single call instead of a 25-line block. Best-effort by design — exactly
// like auto-tagging: no model loaded → no-op (chunks/embeddings and plain RAG are unaffected).
//
// The store is taken as a structural interface (not the concrete VectorStore) so the graph layer
// never imports the SurrealDB engine — same dependency-free discipline as graph/types.ts. The LLM is
// reached through the injected `TextGenerator` seam (entities.ts), the one part that needs the model.

import type { TextGenerator } from '$lib/ingest/autotag';
import { extractEntities, type ExtractOptions } from '$lib/graph/entities';
import { resolveExtraction } from '$lib/graph/resolve';
import type { EntityRecord } from '$lib/graph/types';

/** Relations weaker than this confidence are dropped — keeps low-signal/guessed edges out (a tiny
 *  model tends to label everything the same generic type). Forgiving floor; matches ADR-032. */
export const RELATION_CONFIDENCE_FLOOR = 0.5;

/** The slice of the persistence layer this orchestration needs. VectorStore satisfies it. */
export interface GraphIngestStore {
  getGraphHash(docId: string): Promise<string | null>;
  setGraphHash(docId: string, hash: string): Promise<void>;
  clearDocGraph(docId: string): Promise<void>;
  upsertEntity(e: EntityRecord): Promise<void>;
  chunkTextsForDoc(docId: string): Promise<{ chunkId: string; text: string }[]>;
  relateMention(chunkId: string, docId: string, entityId: string): Promise<void>;
  relateEntities(sourceId: string, targetId: string, type: string, docId: string): Promise<void>;
}

export type IngestGraphResult =
  | { status: 'no_model' } // no generator → nothing to extract WITH
  | { status: 'skipped' } // text unchanged since last extraction (hash hit) — the incremental guard
  | { status: 'no_graph' } // extraction failed/unparseable, or yielded no entities
  | { status: 'ingested'; entityCount: number };

/**
 * Cheap, stable content hash (FNV-1a) for the incremental-extraction guard: identical note text since
 * its last extraction → skip the expensive LLM pass. Deterministic, no clock/deps.
 */
export function graphHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * Extract → resolve → persist one note's entity graph. Steps:
 *  1. Incremental guard: same content hash as last time → `skipped` (no LLM call).
 *  2. `extractEntities` (LLM) → `resolveExtraction` (canonicalize + dedup surface forms).
 *  3. Replace the doc's prior graph (`clearDocGraph`) and upsert the resolved entity nodes.
 *  4. Mention provenance: attach each entity only to the chunks whose text actually NAMES it (by any
 *     surface form) — chunk-level, not whole-doc, so GraphRAG expands to the right sibling chunks.
 *  5. Relations above the confidence floor become entity→entity edges, tagged with this doc.
 *  6. Record the content hash so the next rebuild skips this note unless it changed.
 */
export async function ingestDocGraph(
  store: GraphIngestStore,
  docId: string,
  text: string,
  generate: TextGenerator | null,
  opts: ExtractOptions = {}
): Promise<IngestGraphResult> {
  if (!generate) return { status: 'no_model' };

  const hash = graphHash(text);
  if ((await store.getGraphHash(docId)) === hash) return { status: 'skipped' };

  const res = await extractEntities(text, generate, opts);
  if (!res.ok) return { status: 'no_graph' };
  const g = resolveExtraction(res.extraction);
  if (g.entities.length === 0) return { status: 'no_graph' };

  await store.clearDocGraph(docId);
  for (const e of g.entities) await store.upsertEntity(e);

  // Attach each entity to the chunks whose text actually names it → chunk-level provenance, which is
  // what lets GraphRAG pull the RIGHT sibling chunks (not the whole doc) on a shared entity.
  const chunks = await store.chunkTextsForDoc(docId);
  const lc = chunks.map((c) => ({ chunkId: c.chunkId, text: c.text.toLowerCase() }));
  for (const e of g.entities) {
    const surfaces = [e.name, ...e.aliases].map((s) => s.toLowerCase()).filter(Boolean);
    for (const c of lc) {
      if (surfaces.some((s) => c.text.includes(s)))
        await store.relateMention(c.chunkId, docId, e.id);
    }
  }

  for (const r of g.relations) {
    if ((r.confidence ?? 1) < RELATION_CONFIDENCE_FLOOR) continue;
    await store.relateEntities(r.sourceId, r.targetId, r.type, docId);
  }

  await store.setGraphHash(docId, hash);
  return { status: 'ingested', entityCount: g.entities.length };
}
