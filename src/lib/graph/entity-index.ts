// Entity navigation (Phase 2) — the Obsidian "Tag pane", but for extracted entities instead of
// hand-typed tags. buildTagIndex (nav/tags.ts) aggregates frontmatter tags; this aggregates the
// mention edges the LLM produced at ingest. Same shape of pure aggregation, so an "Entities" pane
// can list every person/org/concept in the vault with how many notes touch it, and an entity page
// can show its notes (mentions) and its connected entities (relations). Pure — no GPU/DB.

import type { EntityRecord, MentionEdge, RelationEdge } from './types';

export interface EntityEntry {
  id: string;
  name: string;
  type: string;
  noteCount: number; // distinct docs mentioning it
  docIds: string[];
}

/**
 * Build the vault entity index: every entity that is actually mentioned somewhere, with its
 * distinct-doc count and the docIds, sorted by descending count then name. Entities with zero
 * mentions (orphaned after a doc delete) are omitted — they're noise, not navigation.
 */
export function buildEntityIndex(
  entities: EntityRecord[],
  // Only (entityId, docId) is read — accept the lean DB-deduped pairs OR full MentionEdge rows.
  mentions: Pick<MentionEdge, 'entityId' | 'docId'>[]
): EntityEntry[] {
  const docsByEntity = new Map<string, Set<string>>();
  for (const m of mentions) {
    if (!docsByEntity.has(m.entityId)) docsByEntity.set(m.entityId, new Set());
    docsByEntity.get(m.entityId)!.add(m.docId);
  }
  const entries: EntityEntry[] = [];
  for (const e of entities) {
    const docs = docsByEntity.get(e.id);
    if (!docs || docs.size === 0) continue;
    entries.push({
      id: e.id,
      name: e.name,
      type: e.type,
      noteCount: docs.size,
      docIds: [...docs].sort()
    });
  }
  entries.sort(
    (a, b) => b.noteCount - a.noteCount || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );
  return entries;
}

/** The distinct docIds that mention an entity (its "backlinks"), sorted. */
export function notesForEntity(mentions: MentionEdge[], entityId: string): string[] {
  const docs = new Set<string>();
  for (const m of mentions) if (m.entityId === entityId) docs.add(m.docId);
  return [...docs].sort();
}

export interface Neighbor {
  id: string;
  type: string; // the relation label
  direction: 'out' | 'in';
}

/**
 * 1-hop neighbors of an entity over the relation edges, in BOTH directions (an entity page wants
 * "X works_at Acme" and "Bob works_at Acme" alike). Deduped by (neighbor, type, direction), sorted
 * deterministically. The persistent/multi-hop version lives in db/store.ts (real graph traversal).
 */
export function entityNeighbors(relations: RelationEdge[], entityId: string): Neighbor[] {
  const out: Neighbor[] = [];
  const seen = new Set<string>();
  const add = (id: string, type: string, direction: 'out' | 'in'): void => {
    const key = `${id}|${type}|${direction}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id, type, direction });
  };
  for (const r of relations) {
    if (r.sourceId === entityId) add(r.targetId, r.type, 'out');
    else if (r.targetId === entityId) add(r.sourceId, r.type, 'in');
  }
  out.sort(
    (a, b) =>
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
      (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) ||
      a.direction.localeCompare(b.direction)
  );
  return out;
}
