// SurrealDB vector store — FR-ING-005 (HNSW cosine index) + FR-RET-001 (top-K search).
// Uses @surrealdb/wasm, which runs the engine in-process: `mem://` in Node/tests,
// `indxdb://nebula` in the webview (DATA-MODEL §1, ADR-008). The store is a derived,
// rebuildable cache (FR-DATA-002) — the `.md` files remain the source of truth.

import { RecordId, Surreal } from 'surrealdb';
import { surrealdbWasmEngines } from '@surrealdb/wasm';
import { EMBEDDING_DIM } from '$lib/inference/provider';
import type { SearchHit } from '$lib/inference/provider';
import type { EntityRecord, MentionEdge, RelationEdge } from '$lib/graph/types';
import type { GraphNeighbor } from '$lib/graph/entity-graph';
import { fuseGraphRag } from '$lib/retrieval/graphrag';
import { wordTermScore } from '$lib/retrieval/search';

export interface ChunkRecord {
  chunkId: string;
  docId: string;
  text: string;
  page?: number;
  charStart: number;
  charEnd: number;
  embedding: number[];
}

interface ChunkRow {
  chunkId: string;
  docId: string;
  text: string;
  page: number | null;
  charStart: number;
  charEnd: number;
  dist: number;
}

/**
 * A persisted note document (FR-DATA-001). In a browser/webview build there are no `.md` files on
 * disk, so the note's own content must be stored durably here (alongside its derived chunks) or it
 * is lost on refresh. This table IS the source of truth for the vault in that context.
 */
export interface NoteRecord {
  docId: string;
  title: string;
  body: string;
  aliases?: string[];
  kind?: string;
  sourcePath?: string;
  frontmatter?: Record<string, unknown>;
}

/** A graph-expanded hit: a sibling chunk reached through shared entities, carrying the proximity signal
 *  so the UI can say WHY it was pulled in (and weight the Micro-Map by structure, not cosine). */
export interface ExpandedHit extends SearchHit {
  sharedCount: number; // how many seed entities this chunk shares (graph proximity)
  sharedEntities: string[]; // display names of those shared entities
}

/** The three rankings GraphRAG produces: vector seeds, graph-expanded chunks, and the fused set. */
export interface GraphRagResult {
  seeds: SearchHit[]; // pure vector top-K (semantic)
  expanded: ExpandedHit[]; // sibling chunks reached via shared entities (structural), with proximity
  fused: SearchHit[]; // the final, RRF-fused context fed to the LLM
  entityIds: string[]; // the entities the seeds mention (what the expansion hung off)
}

export class VectorStore {
  private db: Surreal | null = null;

  /** Connect + define the schema and the HNSW cosine index (FR-ING-005). */
  async connect(url = 'mem://', dimension = EMBEDDING_DIM): Promise<void> {
    const db = new Surreal({ engines: surrealdbWasmEngines() });
    await db.connect(url);
    await db.use({ namespace: 'nebula', database: 'nebula' });
    // IF NOT EXISTS is ESSENTIAL: on a PERSISTED indxdb store the tables/index already exist from a
    // prior session, and a bare `DEFINE TABLE` throws "already exists" — which made connect() fall
    // back to mem://, silently discarding all persistence (the "notes always lost" bug). Idempotent
    // definitions let a returning session reuse the persisted data instead of starting empty.
    await db.query(
      `DEFINE TABLE IF NOT EXISTS chunk SCHEMALESS;
       DEFINE INDEX IF NOT EXISTS hnsw_idx ON chunk FIELDS embedding HNSW DIMENSION ${dimension} DIST COSINE;
       DEFINE TABLE IF NOT EXISTS note SCHEMALESS;
       DEFINE TABLE IF NOT EXISTS entity SCHEMALESS;
       DEFINE TABLE IF NOT EXISTS mentions SCHEMALESS;
       DEFINE TABLE IF NOT EXISTS relates SCHEMALESS;
       DEFINE TABLE IF NOT EXISTS graphmeta SCHEMALESS;`
    );
    this.db = db;
  }

  private get conn(): Surreal {
    if (!this.db) throw new Error('VectorStore not connected');
    return this.db;
  }

  // Serialize EVERY statement through one promise chain (+ retry transient errors). The IndexedDB-
  // backed engine throws "Can not open transaction" when a read and a write overlap on the same
  // connection — which is exactly what happened under bulk ingest (a fire-and-forget entity-pane
  // refresh racing the next note's writes), wedging the connection so all further writes failed.
  // Funnelling every query here guarantees strictly one-at-a-time access, with a short backoff retry.
  private chain: Promise<unknown> = Promise.resolve();
  private q<T>(sql: string, vars?: Record<string, unknown>): Promise<T> {
    const exec = async (): Promise<T> => {
      const db = this.conn;
      for (let attempt = 0; ; attempt++) {
        try {
          return (await db.query(sql, vars)) as T;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (attempt >= 4 || !/transaction|lock|busy|conflict/i.test(msg)) throw e;
          await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
        }
      }
    };
    const result = this.chain.then(exec, exec);
    this.chain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * Upsert chunks keyed by a stable record id (= chunkId), so re-ingesting a document
   * overwrites rather than duplicating (FR-ING-007 — chunks keyed by (document, seq)).
   * ONE statement for the whole batch: per-chunk UPSERTs each became their own IndexedDB
   * transaction through the serial queue (30 chunks = 30 round-trips = the seconds-long
   * "indexing…" stall after every save), while the embedding itself was near-instant.
   */
  async upsertChunks(records: ChunkRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.q(
      `FOR $r IN $records {
         UPSERT type::thing("chunk", $r.cid) CONTENT { chunkId: $r.cid, docId: $r.docId, text: $r.text, page: $r.page, charStart: $r.cs, charEnd: $r.ce, embedding: $r.emb };
       }`,
      {
        records: records.map((r) => ({
          cid: r.chunkId,
          docId: r.docId,
          text: r.text,
          page: r.page ?? null,
          cs: r.charStart,
          ce: r.charEnd,
          emb: r.embedding
        }))
      }
    );
  }

  /** Cosine top-K KNN over the HNSW index (FR-RET-001). Returns hits in descending score. */
  async search(queryVec: number[], k = 8): Promise<SearchHit[]> {
    const topK = Math.max(1, Math.floor(k));
    const [rows] = await this.q<[ChunkRow[]]>(
      `SELECT chunkId, docId, text, page, charStart, charEnd, vector::distance::knn() AS dist
       FROM chunk WHERE embedding <|${topK},COSINE|> $q ORDER BY dist`,
      { q: queryVec }
    );
    return (rows ?? []).map((row) => ({
      chunkId: row.chunkId,
      docId: row.docId,
      text: row.text,
      page: row.page ?? undefined,
      charStart: row.charStart,
      charEnd: row.charEnd,
      score: 1 - row.dist // cosine similarity = 1 − cosine distance (DATA-MODEL §4)
    }));
  }

  /**
   * Exact-term lexical recall channel (FR-RET-003, the recall half): chunks that literally contain a
   * query term, found INDEPENDENTLY of the HNSW ranking. Pure-vector retrieval is weakest exactly
   * where literal match is total — an invoice ID, a person's name, a Vietnamese proper noun the
   * embedding fragments — and `hybridRerank` can't recover those because it only re-orders what the
   * vector pass already returned. Over-fetches with substring CONTAINS in-DB (a table scan — fine at
   * browser-vault scale), then keeps only WHOLE-WORD matches (no "end" inside "spend") ranked by
   * term-hit count, then cosine. `score` is the cosine similarity so hits display on the seed scale.
   */
  async lexicalSearch(queryVec: number[], terms: string[], k = 8): Promise<SearchHit[]> {
    const clean = [
      ...new Set(terms.map((t) => t.toLowerCase().trim()).filter((t) => t.length >= 3))
    ].slice(0, 8);
    if (clean.length === 0) return [];
    // string::contains (NOT the CONTAINS operator — that's array membership) does the substring scan;
    // the whole-word precision pass (wordTermScore) runs in JS below to drop "end"-inside-"spend".
    const conds = clean
      .map((_, i) => `string::contains(string::lowercase(text), $t${i})`)
      .join(' OR ');
    const [rows] = await this.q<[ChunkRow[]]>(
      `SELECT chunkId, docId, text, page, charStart, charEnd,
              vector::similarity::cosine(embedding, $q) AS dist
       FROM chunk WHERE ${conds}`,
      { q: queryVec, ...Object.fromEntries(clean.map((t, i) => [`t${i}`, t])) }
    );
    return (rows ?? [])
      .map((row) => ({ row, words: wordTermScore(row.text, clean) }))
      .filter((x) => x.words > 0)
      .sort(
        (a, b) =>
          b.words - a.words ||
          b.row.dist - a.row.dist ||
          (a.row.chunkId < b.row.chunkId ? -1 : a.row.chunkId > b.row.chunkId ? 1 : 0)
      )
      .slice(0, Math.max(1, Math.floor(k)))
      .map(({ row }) => ({
        chunkId: row.chunkId,
        docId: row.docId,
        text: row.text,
        page: row.page ?? undefined,
        charStart: row.charStart,
        charEnd: row.charEnd,
        score: row.dist // vector::similarity::cosine — already a similarity
      }));
  }

  /** Remove all chunks for a document (re-index / delete — FR-DATA-002/003). */
  async deleteDoc(docId: string): Promise<void> {
    await this.q('DELETE chunk WHERE docId = $docId', { docId });
  }

  /** A document's chunk ids + text — used to attach entity mentions to the chunk that names them. */
  async chunkTextsForDoc(docId: string): Promise<{ chunkId: string; text: string }[]> {
    const [rows] = await this.q<[{ chunkId: string; text: string }[]]>(
      'SELECT chunkId, text FROM chunk WHERE docId = $docId',
      { docId }
    );
    return rows ?? [];
  }

  /**
   * Persist a note document (FR-DATA-001), keyed by docId so a save/edit overwrites in place.
   * This is what makes hand-written notes survive a refresh in the browser build (no `.md` on disk).
   */
  async upsertNote(note: NoteRecord): Promise<void> {
    await this.q(
      'UPSERT type::thing("note", $id) CONTENT { docId: $id, title: $title, body: $body, aliases: $aliases, kind: $kind, sourcePath: $sourcePath, frontmatter: $fm }',
      {
        id: note.docId,
        title: note.title,
        body: note.body,
        aliases: note.aliases ?? [],
        kind: note.kind ?? null,
        sourcePath: note.sourcePath ?? null,
        fm: note.frontmatter ?? {}
      }
    );
  }

  /** All persisted notes (the vault), for rehydrating on startup. */
  async allNotes(): Promise<NoteRecord[]> {
    const [rows] = await this.q<
      [
        {
          docId: string;
          title: string;
          body: string;
          aliases: string[] | null;
          kind: string | null;
          sourcePath: string | null;
          frontmatter: Record<string, unknown> | null;
        }[]
      ]
    >('SELECT docId, title, body, aliases, kind, sourcePath, frontmatter FROM note');
    return (rows ?? []).map((r) => ({
      docId: r.docId,
      title: r.title,
      body: r.body,
      aliases: r.aliases ?? [],
      kind: r.kind ?? undefined,
      sourcePath: r.sourcePath ?? undefined,
      frontmatter: r.frontmatter ?? undefined
    }));
  }

  /** Forget a persisted note (FR-NOTE-009). Its chunks are dropped separately via deleteDoc. */
  async deleteNote(docId: string): Promise<void> {
    await this.q('DELETE type::thing("note", $id)', { id: docId });
  }

  /**
   * Record the retrieval sub-graph for a query as SurrealDB graph edges (FR-GRAPH-002,
   * OBSIDIAN-DNA §5.3): `RELATE query:⟨id⟩ -> retrieved_from -> chunk:⟨id⟩`, carrying the
   * cosine score + rank. Re-relating the same query replaces its prior edges so the
   * Micro-Map reflects only the latest turn.
   */
  async relateRetrieval(
    queryId: string,
    hits: { chunkId: string; score: number }[]
  ): Promise<void> {
    // Clear + re-relate in ONE statement (not 1 + K round-trips): the Micro-Map refresh rides the
    // same serial queue as ingest writes, so per-edge RELATEs delayed every other DB consumer.
    await this.q(
      `DELETE retrieved_from WHERE in = $q;
       FOR $h IN $hits {
         LET $c = type::thing("chunk", $h.chunkId);
         RELATE $q->retrieved_from->$c SET score = $h.score, rank = $h.rank;
       }`,
      {
        q: new RecordId('query', queryId),
        hits: hits.map((h, i) => ({ chunkId: h.chunkId, score: h.score, rank: i + 1 }))
      }
    );
  }

  /** Read back a query's retrieval sub-graph, ordered by rank (FR-GRAPH-001 render input). */
  async getRetrievalSubgraph(
    queryId: string
  ): Promise<{ chunkId: string; docId: string; score: number; rank: number }[]> {
    const [rows] = await this.q<
      [{ chunkId: string; docId: string; score: number; rank: number }[]]
    >(
      `SELECT out.chunkId AS chunkId, out.docId AS docId, score, rank
       FROM retrieved_from WHERE in = $q ORDER BY rank`,
      { q: new RecordId('query', queryId) }
    );
    return rows ?? [];
  }

  /** Drop a query's edges — the Micro-Map is ephemeral per conversation turn (FR-GRAPH-002). */
  async clearRetrieval(queryId: string): Promise<void> {
    await this.q('DELETE retrieved_from WHERE in = $q', {
      q: new RecordId('query', queryId)
    });
  }

  async count(): Promise<number> {
    const [rows] = await this.q<[{ c: number }[]]>('SELECT count() AS c FROM chunk GROUP ALL');
    return rows?.[0]?.c ?? 0;
  }

  // ── Knowledge graph (entities, mentions, relations) ──────────────────────────────────────────
  // Entities + their edges are PERSISTED (extraction is an expensive LLM pass — see graph/entities.ts)
  // so multi-hop traversal and GraphRAG work across sessions without re-reading the vault. Every edge
  // carries the `docId` that asserted it, for provenance (verifiable answers) and scoped cleanup.

  /** Upsert entity nodes keyed by canonical id (idempotent; last write wins on name/aliases).
   *  Whole batch in one statement — a note's 20 entities used to be 20 serialized round-trips. */
  async upsertEntities(es: EntityRecord[]): Promise<void> {
    if (es.length === 0) return;
    await this.q(
      `FOR $e IN $es {
         UPSERT type::thing("entity", $e.id) CONTENT { entityId: $e.id, name: $e.name, type: $e.type, aliases: $e.aliases };
       }`,
      { es: es.map((e) => ({ id: e.id, name: e.name, type: e.type, aliases: e.aliases ?? [] })) }
    );
  }

  /** Single-entity convenience over the batch path. */
  async upsertEntity(e: EntityRecord): Promise<void> {
    await this.upsertEntities([e]);
  }

  /** Record chunk→entity mention edges, tagged with their doc (provenance + scoped cleanup).
   *  One statement for all of a note's mentions — the hottest edge type (entities × chunks). */
  async relateMentions(edges: MentionEdge[]): Promise<void> {
    if (edges.length === 0) return;
    await this.q(
      `FOR $m IN $ms {
         LET $c = type::thing("chunk", $m.chunkId);
         LET $e = type::thing("entity", $m.entityId);
         RELATE $c->mentions->$e SET docId = $m.docId;
       }`,
      { ms: edges.map((m) => ({ chunkId: m.chunkId, entityId: m.entityId, docId: m.docId })) }
    );
  }

  /** Single-mention convenience over the batch path. */
  async relateMention(chunkId: string, docId: string, entityId: string): Promise<void> {
    await this.relateMentions([{ chunkId, docId, entityId }]);
  }

  /** Record entity→entity relation edges with their label + the doc that asserted them (batched). */
  async relateEntityEdges(
    edges: { sourceId: string; targetId: string; type: string; docId: string }[]
  ): Promise<void> {
    if (edges.length === 0) return;
    await this.q(
      `FOR $r IN $rs {
         LET $s = type::thing("entity", $r.sourceId);
         LET $t = type::thing("entity", $r.targetId);
         RELATE $s->relates->$t SET type = $r.type, docId = $r.docId;
       }`,
      { rs: edges }
    );
  }

  /** Single-relation convenience over the batch path. */
  async relateEntities(
    sourceId: string,
    targetId: string,
    type: string,
    docId: string
  ): Promise<void> {
    await this.relateEntityEdges([{ sourceId, targetId, type, docId }]);
  }

  /**
   * Drop a document's graph edges (re-ingest / delete). Entity NODES are left intact — they may be
   * mentioned by other docs; orphaned ones (no remaining mentions) are simply filtered out of the
   * index. Mirrors deleteDoc for chunks: the graph is a rebuildable cache over the `.md` truth.
   */
  async clearDocGraph(docId: string): Promise<void> {
    await this.q(
      'DELETE mentions WHERE docId = $docId; DELETE relates WHERE docId = $docId; DELETE graphmeta WHERE docId = $docId;',
      { docId }
    );
  }

  /**
   * Incremental-extraction guard (perf): the content hash of the text last extracted into the graph
   * for `docId`. A rebuild compares it to the current text and SKIPS the (expensive) LLM extraction
   * when unchanged — so re-running "build graph" only re-reads notes that actually changed, turning a
   * minutes-long full pass into a near-instant no-op. Returns null when the doc was never extracted.
   */
  async getGraphHash(docId: string): Promise<string | null> {
    const [rows] = await this.q<[{ hash: string }[]]>(
      'SELECT hash FROM graphmeta WHERE docId = $docId',
      { docId }
    );
    return rows?.[0]?.hash ?? null;
  }

  /** Record the content hash extracted for a doc (set after a successful extraction). */
  async setGraphHash(docId: string, hash: string): Promise<void> {
    await this.q('UPSERT type::thing("graphmeta", $id) CONTENT { docId: $id, hash: $hash }', {
      id: docId,
      hash
    });
  }

  /** All entity nodes (for the entities pane / pure index builders). */
  async allEntities(): Promise<EntityRecord[]> {
    const [rows] = await this.q<
      [{ id: string; name: string; type: string; aliases: string[] | null }[]]
    >('SELECT entityId AS id, name, type, aliases FROM entity');
    return (rows ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      aliases: r.aliases ?? []
    }));
  }

  /** All mention edges as flat {docId, chunkId, entityId} rows (for the pure index builders). */
  async allMentions(): Promise<MentionEdge[]> {
    const [rows] = await this.q<[{ docId: string; chunkId: string; entityId: string }[]]>(
      'SELECT docId, in.chunkId AS chunkId, out.entityId AS entityId FROM mentions'
    );
    return (rows ?? []).filter((r) => r.chunkId && r.entityId);
  }

  /** All relation edges as flat {sourceId, targetId, type, docId} rows. */
  async allRelations(): Promise<RelationEdge[]> {
    const [rows] = await this.q<
      [{ sourceId: string; targetId: string; type: string; docId: string | null }[]]
    >('SELECT in.entityId AS sourceId, out.entityId AS targetId, type, docId FROM relates');
    return (rows ?? [])
      .filter((r) => r.sourceId && r.targetId)
      .map((r) => ({
        sourceId: r.sourceId,
        targetId: r.targetId,
        type: r.type,
        docId: r.docId ?? undefined
      }));
  }

  /** The distinct docIds that mention an entity (its provenance / "backlinks"). */
  async mentionsForEntity(entityId: string): Promise<{ docId: string; chunkId: string }[]> {
    const [rows] = await this.q<[{ docId: string; chunkId: string }[]]>(
      'SELECT docId, in.chunkId AS chunkId FROM mentions WHERE out = $e',
      { e: new RecordId('entity', entityId) }
    );
    return (rows ?? []).filter((r) => r.chunkId);
  }

  /** Distinct entity ids mentioned by any of the given chunks (the seeds' entities). */
  async entityIdsForChunks(chunkIds: string[]): Promise<string[]> {
    if (chunkIds.length === 0) return [];
    const [rows] = await this.q<[{ entityId: string }[]]>(
      'SELECT out.entityId AS entityId FROM mentions WHERE in IN $chunks',
      { chunks: chunkIds.map((id) => new RecordId('chunk', id)) }
    );
    const seen = new Set<string>();
    for (const r of rows ?? []) if (r.entityId) seen.add(r.entityId);
    return [...seen];
  }

  /** 1-hop neighbours of an entity over `relates`, BOTH directions, with names + relation labels. */
  private async neighbors1(
    entityId: string
  ): Promise<{ id: string; name: string; type: string }[]> {
    const e = new RecordId('entity', entityId);
    const [outRows] = await this.q<[{ id: string; name: string; type: string }[]]>(
      'SELECT out.entityId AS id, out.name AS name, out.type AS type FROM relates WHERE in = $e',
      { e }
    );
    const [inRows] = await this.q<[{ id: string; name: string; type: string }[]]>(
      'SELECT in.entityId AS id, in.name AS name, in.type AS type FROM relates WHERE out = $e',
      { e }
    );
    return [...(outRows ?? []), ...(inRows ?? [])].filter((r) => r.id);
  }

  /**
   * Multi-hop traversal over the PERSISTENT entity graph (FR-GRAPH, the graph-DB justification):
   * breadth-first from `entityId` up to `hops`, returning each reachable entity with its hop
   * distance. This is the "everyone connected to Acme within 2 hops" query — the thing that's
   * painful over an in-memory recompute but native to a persisted graph. Capped at `maxNodes`.
   */
  async entityNeighbors(entityId: string, hops = 2, maxNodes = 50): Promise<GraphNeighbor[]> {
    const visited = new Set<string>([entityId]);
    const result: GraphNeighbor[] = [];
    let frontier = [entityId];
    for (let hop = 1; hop <= hops && frontier.length; hop++) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const n of await this.neighbors1(node)) {
          if (visited.has(n.id)) continue;
          visited.add(n.id);
          result.push({ id: n.id, name: n.name, type: n.type, hop });
          next.push(n.id);
          if (result.length >= maxNodes) return result;
        }
      }
      frontier = next;
    }
    return result;
  }

  /** Relation edges whose BOTH endpoints are in `entityIds` (for rendering an entity sub-graph). */
  async relationsAmong(entityIds: string[]): Promise<RelationEdge[]> {
    if (entityIds.length === 0) return [];
    const ents = entityIds.map((id) => new RecordId('entity', id));
    const [rows] = await this.q<[{ sourceId: string; targetId: string; type: string }[]]>(
      'SELECT in.entityId AS sourceId, out.entityId AS targetId, type FROM relates WHERE in IN $ents AND out IN $ents',
      { ents }
    );
    return (rows ?? []).filter((r) => r.sourceId && r.targetId);
  }

  /**
   * GraphRAG retrieval (Phase 3) — the multi-model payoff: vector + graph in one engine. Vector
   * search finds semantic seeds; their entities pull in sibling chunks (structurally relevant
   * context the vector pass ranked low or missed); the two are RRF-fused (graph/graphrag.ts). When
   * the vault has no graph yet this degrades to plain vector order, so it never loses recall.
   */
  async graphRagSearch(
    queryVec: number[],
    opts: { seedK?: number; expandK?: number; k?: number } = {}
  ): Promise<GraphRagResult> {
    const seedK = opts.seedK ?? 8;
    const expandK = opts.expandK ?? 8;
    const k = opts.k ?? 8;

    const seeds = await this.search(queryVec, seedK);
    const seedChunkIds = new Set(seeds.map((h) => h.chunkId)); // all seeds are excluded from expansion
    // Anchor the graph expansion on the STRONGLY-relevant seeds only (a tight band below the top
    // score). Using EVERY vector seed's entities — including the weak tail a vault always returns —
    // floods the expansion with off-topic siblings: e.g. a "trip budget" question, which names no
    // entity, otherwise pulls in research notes through a weak research seed's entities. The band
    // keeps the on-topic seeds (so legitimate graph siblings still surface) and drops the noise.
    const top = seeds[0]?.score ?? 0;
    const anchorSeeds = seeds.filter((h) => h.score >= top * 0.8);
    const entityIds = await this.entityIdsForChunks(
      (anchorSeeds.length ? anchorSeeds : seeds).map((h) => h.chunkId)
    );
    if (entityIds.length === 0) {
      return { seeds, expanded: [], fused: seeds.slice(0, k), entityIds: [] };
    }

    // Sibling chunks mentioning the seed entities, scored vs the query in-DB (one row per mention).
    // `entityName` rides along so we can report WHICH entities connect each sibling (UI + Micro-Map).
    const ents = entityIds.map((id) => new RecordId('entity', id));
    const [rows] = await this.q<[(ChunkRow & { chunkId: string; entityName: string | null })[]]>(
      `SELECT in.chunkId AS chunkId, in.docId AS docId, in.text AS text, in.page AS page,
              in.charStart AS charStart, in.charEnd AS charEnd, out.name AS entityName,
              vector::similarity::cosine(in.embedding, $q) AS dist
       FROM mentions WHERE out IN $ents`,
      { q: queryVec, ents }
    );

    // Aggregate to one hit per sibling chunk: the SET of shared entities = graph proximity (count +
    // names). Names are kept so a chunk reached purely through the graph can explain why it's here.
    const byChunk = new Map<string, { hit: SearchHit; shared: Set<string> }>();
    for (const r of rows ?? []) {
      if (!r.chunkId || seedChunkIds.has(r.chunkId)) continue; // drop seeds — they're the vector side
      const existing = byChunk.get(r.chunkId);
      if (existing) {
        if (r.entityName) existing.shared.add(r.entityName);
      } else {
        byChunk.set(r.chunkId, {
          shared: new Set(r.entityName ? [r.entityName] : []),
          hit: {
            chunkId: r.chunkId,
            docId: r.docId,
            text: r.text,
            page: r.page ?? undefined,
            charStart: r.charStart,
            charEnd: r.charEnd,
            score: r.dist // already a cosine SIMILARITY here (vector::similarity::cosine), not a distance
          }
        });
      }
    }
    const expanded: ExpandedHit[] = [...byChunk.values()]
      .sort((a, b) => b.shared.size - a.shared.size || b.hit.score - a.hit.score)
      .slice(0, expandK)
      .map((x) => ({ ...x.hit, sharedCount: x.shared.size, sharedEntities: [...x.shared] }));

    const fused = fuseGraphRag(seeds, expanded, { k });
    return { seeds, expanded, fused, entityIds };
  }

  async close(): Promise<void> {
    await this.db?.close();
    this.db = null;
  }
}
