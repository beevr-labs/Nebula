// Retrieval scope (FR-RET-004) · ALGORITHMS §19.
//
// A hardcore multi-client user keeps notes for many customers in one vault. Answering "what did
// we decide for Acme?" must pull ONLY Acme's notes — cross-client bleed is a confidentiality
// failure, not just noise. A scope restricts retrieval (and the Context Compiler) to a folder
// prefix (`notes/acme/`) or a tag (`#client/acme`). Pure: the UI filters search hits / note sets
// through these helpers. No GPU/DB.

export type Scope =
  | { kind: 'folder'; value: string } // matches docIds starting with `value`
  | { kind: 'tag'; value: string }; // matches notes carrying the (normalized) tag

export interface ScopeNote {
  docId: string;
  tags: string[]; // already-normalized tags (frontmatter + inline), see nav/tags
}

const normTag = (t: string): string => t.trim().replace(/^#/, '').toLowerCase();

/** True if a note belongs to `scope`. */
export function noteInScope(note: ScopeNote, scope: Scope): boolean {
  if (scope.kind === 'folder') return note.docId.startsWith(scope.value);
  return note.tags.map(normTag).includes(normTag(scope.value));
}

/**
 * The set of docIds within `scope` (FR-RET-004), or `null` for "no scope = whole vault".
 * Callers pass `null` through unchanged so an unscoped search behaves exactly as before.
 */
export function scopeDocIds(notes: ScopeNote[], scope: Scope | null): Set<string> | null {
  if (!scope) return null;
  return new Set(notes.filter((n) => noteInScope(n, scope)).map((n) => n.docId));
}

/** Keep only items whose docId is in `ids`; a null `ids` means no scope → keep everything. */
export function filterByScope<T extends { docId: string }>(
  items: T[],
  ids: Set<string> | null
): T[] {
  return ids ? items.filter((i) => ids.has(i.docId)) : items;
}

/** Human label for a scope chip, e.g. `📁 notes/acme/` or `#client/acme`. */
export function scopeLabel(scope: Scope): string {
  return scope.kind === 'folder' ? `📁 ${scope.value}` : `#${normTag(scope.value)}`;
}
