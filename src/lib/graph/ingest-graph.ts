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
import {
  extractEntities,
  buildBatchEntityPrompt,
  parseBatchEntityResponse,
  planBatches,
  DEFAULT_SKIM_TOKENS,
  DEFAULT_BATCH_MAX_DOCS,
  type ExtractOptions,
  type Extraction
} from '$lib/graph/entities';
import { resolveExtraction, type ResolvedGraph } from '$lib/graph/resolve';
import type { EntityRecord } from '$lib/graph/types';

/** Relations weaker than this confidence are dropped — keeps low-signal/guessed edges out (a tiny
 *  model tends to label everything the same generic type). Forgiving floor; matches ADR-032. */
export const RELATION_CONFIDENCE_FLOOR = 0.5;

/** The slice of the persistence layer this orchestration needs. VectorStore satisfies it.
 *  Batch-shaped on purpose: persisting a note is a handful of statements regardless of how many
 *  entities/edges it has — per-item calls each became their own serialized DB round-trip. */
export interface GraphIngestStore {
  getGraphHash(docId: string): Promise<string | null>;
  setGraphHash(docId: string, hash: string): Promise<void>;
  clearDocGraph(docId: string): Promise<void>;
  upsertEntities(es: EntityRecord[]): Promise<void>;
  chunkTextsForDoc(docId: string): Promise<{ chunkId: string; text: string }[]>;
  relateMentions(edges: { chunkId: string; docId: string; entityId: string }[]): Promise<void>;
  relateEntityEdges(
    edges: { sourceId: string; targetId: string; type: string; docId: string }[]
  ): Promise<void>;
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

  return extractAndPersist(store, docId, text, generate, opts);
}

/** Extract ONE note with the LLM and persist its graph — `ingestDocGraph` minus the hash guard
 *  (callers that already checked the hash, like the vault batcher, come straight here). */
async function extractAndPersist(
  store: GraphIngestStore,
  docId: string,
  text: string,
  generate: TextGenerator,
  opts: ExtractOptions = {}
): Promise<IngestGraphResult> {
  const res = await extractEntities(text, generate, opts);
  if (!res.ok) return { status: 'no_graph' };
  return persistExtraction(store, docId, text, res.extraction);
}

/** Resolve + persist one note's raw extraction (shared by the solo and batched paths). */
async function persistExtraction(
  store: GraphIngestStore,
  docId: string,
  text: string,
  extraction: Extraction
): Promise<IngestGraphResult> {
  const g = resolveExtraction(extraction);
  if (g.entities.length === 0) return { status: 'no_graph' };
  const entityCount = await persistResolvedGraph(store, docId, text, g);
  return { status: 'ingested', entityCount };
}

/**
 * Persist an already-RESOLVED graph for one note (the steps shared by LLM extraction and pre-built
 * seeding): replace the doc's prior graph, upsert entity nodes, attach each entity to the chunks
 * whose text actually NAMES it (chunk-level provenance — what lets GraphRAG pull the right sibling
 * chunks), add the above-floor relation edges, and record the content hash so the incremental guard
 * skips this note next time. Returns the entity count. Chunks must already exist (index the note
 * first), else no mentions attach.
 */
async function persistResolvedGraph(
  store: GraphIngestStore,
  docId: string,
  text: string,
  g: ResolvedGraph
): Promise<number> {
  await store.clearDocGraph(docId);
  await store.upsertEntities(g.entities);

  const chunks = await store.chunkTextsForDoc(docId);
  const lc = chunks.map((c) => ({ chunkId: c.chunkId, text: c.text.toLowerCase() }));
  const mentions: { chunkId: string; docId: string; entityId: string }[] = [];
  for (const e of g.entities) {
    const surfaces = [e.name, ...e.aliases].map((s) => s.toLowerCase()).filter(Boolean);
    for (const c of lc) {
      if (surfaces.some((s) => c.text.includes(s)))
        mentions.push({ chunkId: c.chunkId, docId, entityId: e.id });
    }
  }
  await store.relateMentions(mentions);

  await store.relateEntityEdges(
    g.relations
      .filter((r) => (r.confidence ?? 1) >= RELATION_CONFIDENCE_FLOOR)
      .map((r) => ({ sourceId: r.sourceId, targetId: r.targetId, type: r.type, docId }))
  );

  await store.setGraphHash(docId, graphHash(text));
  return g.entities.length;
}

/**
 * Seed a note's graph from a HAND-AUTHORED extraction — the exact same resolve + persist path as
 * `ingestDocGraph`, but with NO LLM. This is what lets a demo/seed vault ship a ready-made knowledge
 * graph so a first-run user sees entities + relations instantly, without waiting to load the chat
 * model and run extraction. Records the content hash too, so the later auto-build SKIPS these notes
 * (they're already graphed) unless the user edits them. Index the note first so chunks exist.
 */
export async function seedDocGraph(
  store: GraphIngestStore,
  docId: string,
  text: string,
  extraction: Extraction
): Promise<number> {
  return persistResolvedGraph(store, docId, text, resolveExtraction(extraction));
}

/** Cumulative progress after each settled batch — drives the status line + progressive refresh. */
export interface VaultGraphProgress {
  done: number; // notes settled so far (skipped + extracted + failed)
  total: number;
  extracted: number; // cumulative successfully-ingested notes
  skipped: number; // cumulative hash hits
  label: string; // docId of the last settled note ('' for the hash-skip pass)
}

export interface VaultGraphOptions extends ExtractOptions {
  /** Notes per batched LLM call (default DEFAULT_BATCH_MAX_DOCS). */
  maxBatchDocs?: number;
  /** Awaited after the hash pass and after each LLM call's notes persist. */
  onBatch?: (p: VaultGraphProgress) => void | Promise<void>;
}

/** Whitespace-token count — the same unit as `firstTokens`/`segmentTokens` (words in English,
 *  syllables in Vietnamese), NOT BPE tokens. */
function countTokens(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Generation budget for an n-doc batched call: JSON-mode stops at the closing brace so a roomy
 *  budget is free, but a model build that REJECTED json mode rambles to the cap — keep it modest. */
function batchMaxTokens(n: number, opts: ExtractOptions): number {
  return Math.min(1024, (opts.maxTokens ?? 512) + 192 * (n - 1));
}

/**
 * Extract a WHOLE VAULT's entity graphs in as few LLM generations as possible — the vault-rebuild
 * path (buildVaultGraph). The per-note loop paid one generation per note no matter how small the
 * note; on a many-note vault the fixed per-call cost (instruction prefill + engine round-trip)
 * dominated. Here:
 *   1. Hash pass first — unchanged notes are skipped with ZERO LLM calls (and reported at once).
 *   2. Notes longer than the skim window keep the proven SOLO path (segmented extraction covers
 *      their tail; batching can't — a batch slot only fits one skim).
 *   3. Everything else is greedily packed into batches that fit one skim window (≤ maxBatchDocs
 *      per call) and extracted with ONE generation per batch via the numbered-docs prompt.
 *   4. A null batch slot (model dropped/mangled that document) falls back to single-doc extraction
 *      for THAT note only; a thrown generation (abort / model gone) settles the batch as no_graph
 *      without retrying — best-effort per note, the queue never wedges, same as the per-note path.
 * Returns per-doc results keyed by docId. Persisted notes record their content hash, so re-running
 * is incremental regardless of how a previous run ended.
 */
export async function ingestVaultGraph(
  store: GraphIngestStore,
  docs: { docId: string; text: string }[],
  generate: TextGenerator | null,
  opts: VaultGraphOptions = {}
): Promise<Map<string, IngestGraphResult>> {
  const results = new Map<string, IngestGraphResult>();
  if (!generate) {
    for (const d of docs) results.set(d.docId, { status: 'no_model' });
    return results;
  }
  const skim = opts.skimTokens ?? DEFAULT_SKIM_TOKENS;
  const maxDocs = opts.maxBatchDocs ?? DEFAULT_BATCH_MAX_DOCS;
  const total = docs.length;
  let done = 0;
  let extracted = 0;
  let skipped = 0;
  const report = async (label: string) =>
    opts.onBatch?.({ done, total, extracted, skipped, label });
  const settle = (docId: string, r: IngestGraphResult) => {
    results.set(docId, r);
    done++;
    if (r.status === 'ingested') extracted++;
  };

  // 1. Incremental guard over the whole vault — no LLM cost for unchanged notes.
  const pending: { docId: string; text: string; tokens: number }[] = [];
  for (const d of docs) {
    if ((await store.getGraphHash(d.docId)) === graphHash(d.text)) {
      settle(d.docId, { status: 'skipped' });
      skipped++;
    } else {
      pending.push({ ...d, tokens: countTokens(d.text) });
    }
  }
  if (skipped > 0) await report('');

  // 2/3. Pack the short notes into batched calls; long notes go solo (segmented) below.
  const small = pending.filter((d) => d.tokens <= skim);
  const solo = pending.filter((d) => d.tokens > skim);
  for (const group of planBatches(
    small.map((d) => d.tokens),
    skim,
    maxDocs
  )) {
    const members = group.map((i) => small[i]);
    if (members.length === 1) {
      // A 1-doc batch gains nothing from the batch prompt — use the proven single-doc path.
      const d = members[0];
      settle(d.docId, await extractAndPersist(store, d.docId, d.text, generate, opts).catch(() => ({ status: 'no_graph' }) as const)); // prettier-ignore
      await report(d.docId);
      continue;
    }
    let slots: (Extraction | null)[] | null = null;
    try {
      const out = await generate(
        buildBatchEntityPrompt(
          members.map((m) => m.text),
          opts
        ),
        {
          maxTokens: batchMaxTokens(members.length, opts),
          signal: opts.signal
        }
      );
      slots = parseBatchEntityResponse(out, members.length, opts);
    } catch {
      slots = null; // generation itself died (abort / model gone) — don't retry per-doc
    }
    for (let i = 0; i < members.length; i++) {
      const d = members[i];
      const slot = slots?.[i] ?? null;
      try {
        if (slot) settle(d.docId, await persistExtraction(store, d.docId, d.text, slot));
        else if (slots)
          settle(d.docId, await extractAndPersist(store, d.docId, d.text, generate, opts)); // 4. dropped slot → solo retry
        else settle(d.docId, { status: 'no_graph' });
      } catch {
        settle(d.docId, { status: 'no_graph' });
      }
    }
    await report(members[members.length - 1].docId);
  }

  // Long notes: the segmented solo path (covers their tail past one skim window).
  for (const d of solo) {
    settle(d.docId, await extractAndPersist(store, d.docId, d.text, generate, opts).catch(() => ({ status: 'no_graph' }) as const)); // prettier-ignore
    await report(d.docId);
  }
  return results;
}
