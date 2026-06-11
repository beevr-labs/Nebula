// Entity + relation extraction — the foundation of the persistent knowledge graph (GraphRAG).
//
// Wikilinks/backlinks/tags are link graphs the *user* authors over whole notes. This module builds
// the layer *underneath* the notes: it reads a document and extracts the named things inside it
// (people, orgs, projects, concepts…) and how they relate. Those edges are EXPENSIVE — they cost an
// LLM pass — so unlike backlinks they are computed once at ingest and PERSISTED (see db/store.ts),
// not recomputed on every load. That persistence is what later makes multi-hop traversal and
// GraphRAG retrieval (graph-connected context, not just semantically-similar context) possible.
//
// The LLM is reached through the same injected `TextGenerator` seam as autotag.ts, so this module is
// pure & unit-testable with a stub — no GPU in the gate. Every extracted edge carries provenance
// (the chunk it came from) at the persistence layer, keeping answers verifiable (the trust pillar).

import type { TextGenerator } from '$lib/ingest/autotag';
import { firstTokens } from '$lib/ingest/autotag';

/** The canonical entity kinds. Anything the model returns outside this set collapses to 'other'. */
export type EntityType = 'person' | 'org' | 'project' | 'place' | 'concept' | 'event' | 'other';

const ENTITY_TYPES: ReadonlySet<string> = new Set([
  'person',
  'org',
  'project',
  'place',
  'concept',
  'event',
  'other'
]);

export interface ExtractedEntity {
  name: string;
  type: EntityType;
}

/** A directed relation between two entities, both referenced by their (surface) name. */
export interface ExtractedRelation {
  source: string;
  target: string;
  type: string; // short lowercase verb phrase, e.g. "acquired", "reports_to", "leads"
  confidence?: number; // 0..1, how clearly the text states it (used to drop weak/guessed edges)
}

export interface Extraction {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

export type ExtractionResult =
  | { ok: true; extraction: Extraction }
  | { ok: false; reason: 'no_model' | 'unparseable' | 'error'; detail?: string };

export interface ExtractOptions {
  skimTokens?: number; // whitespace-token window per extraction segment (default 1200)
  maxSegments?: number; // how many consecutive segments of a long doc to extract (default 2)
  maxEntities?: number; // clamp entity count per segment (default 20)
  maxRelations?: number; // clamp relation count per segment (default 30)
  maxTokens?: number; // generation budget (default 512)
  signal?: AbortSignal;
}

export const DEFAULT_SKIM_TOKENS = 1200;
// Each segment is a SEPARATE LLM generation — the single slowest step of indexing a long note. 2
// covers ~2400 words (well past the old single-skim blind spot) while keeping the worst-case graph
// cost at 2× a generation, not 4×. The graph pass is backgrounded (drainIndexQueue), so this bounds
// how long "building graph…" lingers without ever blocking search.
export const DEFAULT_MAX_SEGMENTS = 2;
export const DEFAULT_MAX_ENTITIES = 20;
export const DEFAULT_MAX_RELATIONS = 30;

// Versioned instruction (PROMPTS): changing it must re-run the extraction parse tests.
// The worked example is load-bearing — small models default EVERY relation to one generic type
// ("works_at") without it; the example's varied types (acquired / cto_of / leads) break that habit.
export const ENTITY_INSTRUCTION = `You are Nebula's knowledge-graph builder. From the document excerpt, extract the key entities and the relationships EXPLICITLY stated between them. Output ONLY one JSON object — no prose, no code fence, no extra keys.

Schema:
{"entities":[{"name":string,"type":string}],"relations":[{"source":string,"target":string,"type":string,"confidence":number}]}

Rules:
- entities: the important named things — people, organizations, projects, places, concepts, events. Use the name as written (keep original casing and language).
- type: exactly one of: person, org, project, place, concept, event, other.
- relations: connect two entities that BOTH appear in your entities list. "type" is the SPECIFIC relationship from the text, a short lowercase verb phrase with underscores (e.g. founded, acquired, reports_to, leads, owns, located_in, part_of, replaced, uses, signed, returns). Do NOT label every relation the same generic type — use the actual verb. "confidence" is 0.0–1.0 for how clearly the text states it.
- Only include relations actually supported by the text; if none, use [].

Example:
Input: "Acme acquired Beta Corp in 2020. Jane Doe, Acme's CTO, now leads the Helix project."
Output: {"entities":[{"name":"Acme","type":"org"},{"name":"Beta Corp","type":"org"},{"name":"Jane Doe","type":"person"},{"name":"Helix","type":"project"}],"relations":[{"source":"Acme","target":"Beta Corp","type":"acquired","confidence":0.95},{"source":"Jane Doe","target":"Acme","type":"cto_of","confidence":0.9},{"source":"Jane Doe","target":"Helix","type":"leads","confidence":0.9}]}

Now extract from the document excerpt below. Output the JSON object and nothing else.`;

/** Assemble the strict-JSON extraction prompt. Pure. */
export function buildEntityPrompt(text: string, opts: ExtractOptions = {}): string {
  const excerpt = firstTokens(text, opts.skimTokens ?? DEFAULT_SKIM_TOKENS);
  return `${ENTITY_INSTRUCTION}\n\n# Document excerpt\n${excerpt}`;
}

/** Pull the outermost {...} object out of a possibly-noisy LLM response. */
function extractJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1));
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Coerce an arbitrary string into one of the known entity types (default 'other'). */
export function normalizeType(value: unknown): EntityType {
  if (typeof value !== 'string') return 'other';
  const t = value.toLowerCase().trim().split(/\s+/)[0];
  return (ENTITY_TYPES.has(t) ? t : 'other') as EntityType;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim();
  return name.length ? name : null;
}

function normalizeRelType(value: unknown): string {
  if (typeof value !== 'string') return 'related_to';
  const t = value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_]/gu, '');
  return t.length ? t : 'related_to';
}

/**
 * Parse + normalize an LLM extraction response. Tolerant of code fences and surrounding prose.
 * Entities are deduped by name (case-insensitive) and clamped; relations are kept only when both
 * endpoints name an extracted entity (the model is told to honor this, but small models drift).
 * Returns null when no JSON object can be recovered (caller → degrade, never a hard failure).
 */
export function parseEntityResponse(raw: string, opts: ExtractOptions = {}): Extraction | null {
  const obj = extractJson(raw);
  if (!obj) return null;

  const maxEntities = opts.maxEntities ?? DEFAULT_MAX_ENTITIES;
  const maxRelations = opts.maxRelations ?? DEFAULT_MAX_RELATIONS;

  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();
  const known = new Set<string>(); // lowercased names, for relation endpoint validation
  if (Array.isArray(obj.entities)) {
    for (const raw of obj.entities) {
      if (!raw || typeof raw !== 'object') continue;
      const name = cleanName((raw as Record<string, unknown>).name);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      known.add(key);
      entities.push({ name, type: normalizeType((raw as Record<string, unknown>).type) });
      if (entities.length >= maxEntities) break;
    }
  }

  const relations: ExtractedRelation[] = [];
  const relSeen = new Set<string>();
  if (Array.isArray(obj.relations)) {
    for (const raw of obj.relations) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const source = cleanName(r.source);
      const target = cleanName(r.target);
      if (!source || !target) continue;
      if (source.toLowerCase() === target.toLowerCase()) continue; // no self-loops
      // Endpoints must be entities we extracted, else the edge dangles.
      if (!known.has(source.toLowerCase()) || !known.has(target.toLowerCase())) continue;
      const type = normalizeRelType(r.type);
      const dedup = `${source.toLowerCase()}|${target.toLowerCase()}|${type}`;
      if (relSeen.has(dedup)) continue;
      relSeen.add(dedup);
      const rel: ExtractedRelation = { source, target, type };
      if (typeof r.confidence === 'number' && Number.isFinite(r.confidence)) {
        rel.confidence = Math.min(1, Math.max(0, r.confidence));
      }
      relations.push(rel);
      if (relations.length >= maxRelations) break;
    }
  }

  return { entities, relations };
}

/**
 * Split a document into consecutive `n`-whitespace-token segments, capped at `maxSegments`. NOTE:
 * "tokens" here are WHITESPACE tokens (words in English, syllables in Vietnamese), not BPE tokens —
 * same unit as `firstTokens`. Pure; [] for blank text.
 */
export function segmentTokens(text: string, n: number, maxSegments: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length && out.length < maxSegments; i += n) {
    out.push(words.slice(i, i + n).join(' '));
  }
  return out;
}

/** Merge per-segment extractions: entities deduped by name (case-insensitive, first seen wins),
 *  relations deduped by (source, target, type). Pure; resolveExtraction canonicalizes further. */
export function mergeExtractions(parts: Extraction[]): Extraction {
  const entities: ExtractedEntity[] = [];
  const seenEnt = new Set<string>();
  const relations: ExtractedRelation[] = [];
  const seenRel = new Set<string>();
  for (const p of parts) {
    for (const e of p.entities) {
      const key = e.name.toLowerCase();
      if (seenEnt.has(key)) continue;
      seenEnt.add(key);
      entities.push(e);
    }
    for (const r of p.relations) {
      const key = `${r.source.toLowerCase()}|${r.target.toLowerCase()}|${r.type}`;
      if (seenRel.has(key)) continue;
      seenRel.add(key);
      relations.push(r);
    }
  }
  return { entities, relations };
}

/**
 * Read a document SEGMENT BY SEGMENT and extract its entity graph. The old single-skim version only
 * ever read the first `skimTokens` words, so a long note's tail produced NO entities — and GraphRAG
 * could never expand into it (the recall blind spot). Now up to `maxSegments` consecutive windows
 * are each extracted and merged, so the graph covers ~4800 words by default; the per-note cost is
 * bounded and paid once per content hash (ingest-graph's incremental guard). Best-effort per
 * segment: one unparseable segment doesn't discard the others; all failing → the first failure.
 * A `null` generator (no model loaded) degrades to `no_model` so the caller can flag the note for
 * later extraction instead of failing the ingest — exactly like autotag's `taggable_later` path.
 */
export async function extractEntities(
  text: string,
  generate: TextGenerator | null,
  opts: ExtractOptions = {}
): Promise<ExtractionResult> {
  if (!generate) return { ok: false, reason: 'no_model' };
  const skim = opts.skimTokens ?? DEFAULT_SKIM_TOKENS;
  const segments = segmentTokens(text, skim, opts.maxSegments ?? DEFAULT_MAX_SEGMENTS);
  if (segments.length === 0) segments.push(''); // blank doc — keep the single-call contract

  const parts: Extraction[] = [];
  let firstFail: ExtractionResult | null = null;
  for (const seg of segments) {
    try {
      const out = await generate(buildEntityPrompt(seg, opts), {
        maxTokens: opts.maxTokens ?? 512,
        signal: opts.signal
      });
      const extraction = parseEntityResponse(out, opts);
      if (extraction) parts.push(extraction);
      else if (!firstFail)
        firstFail = { ok: false, reason: 'unparseable', detail: out.slice(0, 120) };
    } catch (e) {
      if (!firstFail)
        firstFail = {
          ok: false,
          reason: 'error',
          detail: e instanceof Error ? e.message : String(e)
        };
      break; // a throw (abort / model gone) won't get better on the next segment
    }
  }
  if (parts.length === 0) return firstFail ?? { ok: false, reason: 'unparseable' };
  return { ok: true, extraction: mergeExtractions(parts) };
}
