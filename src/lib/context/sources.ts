// Build Context-Compiler sources from notes / retrieval hits (FR-CTX-001) · ALGORITHMS §5.
//
// The Context Compiler (`compiler.ts`) compiles `CompileSource[]` into a deterministic,
// token-counted `<context>` payload to paste into another LLM (GPT/Claude). This module is the
// thin, pure adapter from what the app actually holds — whole notes (share a client's notes) or
// retrieval hits (the "relevant ~5%" that answered a question) — into that shape. Pure.

import type { CompileSource } from '$lib/context/compiler';

export interface NoteForCompile {
  docId: string;
  text: string;
  hash?: string; // content hash for the manifest (e.g. frontmatter nebula_hash)
}

/** One source per note, the whole body as a single chunk (FR-CTX-001). */
export function sourcesFromNotes(notes: NoteForCompile[]): CompileSource[] {
  return notes.map((n) => ({
    docId: n.docId,
    path: n.docId,
    hash: n.hash ?? '',
    chunks: [{ seq: 0, text: n.text }]
  }));
}

export interface HitForCompile {
  chunkId: string; // `${docId}#${seq}`
  docId: string;
  text: string;
  page?: number;
}

/**
 * Group retrieval hits into per-document sources, deriving each chunk's `seq` from its chunkId
 * (`docId#seq`). `hashOf` supplies the source hash for the manifest. The compiler dedups/sorts
 * chunks by seq, so order here doesn't matter.
 */
export function sourcesFromHits(
  hits: HitForCompile[],
  hashOf?: (docId: string) => string
): CompileSource[] {
  const byDoc = new Map<string, CompileSource>();
  for (const h of hits) {
    const seq = Number(h.chunkId.split('#')[1] ?? 0);
    if (!byDoc.has(h.docId)) {
      byDoc.set(h.docId, {
        docId: h.docId,
        path: h.docId,
        hash: hashOf?.(h.docId) ?? '',
        chunks: []
      });
    }
    byDoc
      .get(h.docId)!
      .chunks.push({ seq: Number.isFinite(seq) ? seq : 0, page: h.page, text: h.text });
  }
  return [...byDoc.values()];
}

/** Parse a comma/newline-separated redaction list into the compiler's pattern shape. */
export function parseRedactions(input: string): { pattern: string }[] {
  return input
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pattern) => ({ pattern }));
}
