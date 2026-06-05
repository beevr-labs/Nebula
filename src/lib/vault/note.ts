// Vault note IO — `.md` + YAML frontmatter (FR-DATA-001) and content-hash change
// detection (FR-DATA-003). Pure/async over strings; the actual disk read/write goes
// through fs_scope (NFR-SEC-003). gray-matter preserves unknown frontmatter keys, so
// the Obsidian round-trip (NFR-PORT-001) is not clobbered.

import matter from 'gray-matter';

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Parse a raw `.md` file into frontmatter + body. */
export function parseNote(raw: string): ParsedNote {
  const parsed = matter(raw);
  return { frontmatter: { ...parsed.data }, body: parsed.content };
}

/** Serialize frontmatter + body back to a `.md` string, preserving all keys. */
export function serializeNote(note: ParsedNote): string {
  return matter.stringify(note.body, note.frontmatter);
}

/** SHA-256 of arbitrary text as `sha256:<hex>` (Web Crypto — works in browser, Worker, Node). */
export async function hashContent(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

/**
 * Content hash used for change detection (`nebula_hash`, FR-DATA-003). Hashed over the
 * BODY only, so metadata-only frontmatter edits (e.g. adding tags) don't force a
 * needless re-embed, while any change to the searchable text triggers re-indexing.
 */
export async function computeNoteHash(raw: string): Promise<string> {
  return hashContent(parseNote(raw).body);
}

/** True if the note's body differs from the stored hash (→ re-index, FR-DATA-003). */
export async function hasChanged(
  raw: string,
  storedHash: string | null | undefined
): Promise<boolean> {
  if (!storedHash) return true;
  return (await computeNoteHash(raw)) !== storedHash;
}

/** Stamp the current `nebula_hash` into frontmatter and return the serialized note. */
export async function withNebulaHash(raw: string): Promise<string> {
  const note = parseNote(raw);
  note.frontmatter.nebula_hash = await hashContent(note.body);
  return serializeNote(note);
}
