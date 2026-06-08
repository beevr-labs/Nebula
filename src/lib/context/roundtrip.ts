// Round-trip: resolve a pasted frontier-model answer's citations back to vault locations (CE4,
// FR-CTX-010) · ALGORITHMS §5. When the user compiles a task payload (CE2), the cloud model is told
// to cite by `[path#seq]` — the source's path and the chunk's seq. This module parses those markers
// (and the local `[#n]` form) out of a pasted answer and resolves each to a `chunkId` the existing
// Magic Jump (jumpTo / resolveCitationTarget) already navigates + highlights — so a GPT/Claude answer
// gets the SAME click-to-source navigation as a local-chat answer. Pure + deterministic — no DOM, no DB.

export interface ParsedRef {
  raw: string; // the literal marker, e.g. "[notes/budget.md#0]" or "[#2]"
  kind: 'path' | 'index'; // path#seq (frontier paste) vs #n (local-chat numbering)
  path?: string; // for kind:'path' — the source path (== docId in the compiler)
  seq?: number; // for kind:'path'
  index?: number; // for kind:'index' — the 1-based [#n]
  span: [number, number]; // char offsets of the marker in the pasted text (for highlighting)
}

export interface ResolvedRef extends ParsedRef {
  chunkId: string | null; // `${docId}#${seq}` when it resolves to a real vault location, else null
  docId: string | null;
  resolved: boolean;
}

// `[path#seq]` — path is anything up to a '#', containing a dot (a filename), so it never matches the
// bare `[#n]` form. `[#n]` — empty path before '#'. Both captured in one pass to preserve order/spans.
const PATH_SEQ = /\[([^[\]#]*\.[^[\]#]*)#(\d+)\]/g;
const INDEX = /\[#(\d+)\]/g;

/** Parse every `[path#seq]` and `[#n]` marker out of a pasted answer, in document order. Pure. */
export function parseRefs(answer: string): ParsedRef[] {
  const refs: ParsedRef[] = [];
  let m: RegExpExecArray | null;

  PATH_SEQ.lastIndex = 0;
  while ((m = PATH_SEQ.exec(answer)) !== null) {
    refs.push({
      raw: m[0],
      kind: 'path',
      path: m[1].trim(),
      seq: Number(m[2]),
      span: [m.index, m.index + m[0].length]
    });
  }

  INDEX.lastIndex = 0;
  while ((m = INDEX.exec(answer)) !== null) {
    refs.push({
      raw: m[0],
      kind: 'index',
      index: Number(m[1]),
      span: [m.index, m.index + m[0].length]
    });
  }

  return refs.sort((a, b) => a.span[0] - b.span[0]);
}

/**
 * Resolve parsed refs to vault chunkIds. A `path#seq` ref resolves when its path is a known docId (the
 * compiler uses path == docId); an `index` ref resolves via the supplied `contextOrder` (the chunkIds
 * of the compiled sources, 1-based — same mapping as local-chat `parseCitations`). Unresolved refs are
 * kept (resolved:false) so the UI can show "couldn't find that source" rather than silently dropping it.
 */
export function resolveRefs(
  refs: ParsedRef[],
  knownDocIds: Iterable<string>,
  contextOrder: readonly string[] = []
): ResolvedRef[] {
  const docs = new Set(knownDocIds);
  return refs.map((r) => {
    if (r.kind === 'path' && r.path !== undefined && r.seq !== undefined) {
      const docId = docs.has(r.path) ? r.path : null;
      const chunkId = docId ? `${docId}#${r.seq}` : null;
      return { ...r, docId, chunkId, resolved: chunkId !== null };
    }
    if (r.kind === 'index' && r.index !== undefined) {
      const chunkId = contextOrder[r.index - 1] ?? null;
      const docId = chunkId ? chunkId.slice(0, chunkId.lastIndexOf('#')) : null;
      return { ...r, docId, chunkId, resolved: chunkId !== null };
    }
    return { ...r, docId: null, chunkId: null, resolved: false };
  });
}

/** Convenience: parse + resolve in one call. The distinct resolved chunkIds (dedup, document order). */
export function resolvePastedAnswer(
  answer: string,
  knownDocIds: Iterable<string>,
  contextOrder: readonly string[] = []
): { refs: ResolvedRef[]; chunkIds: string[] } {
  const refs = resolveRefs(parseRefs(answer), knownDocIds, contextOrder);
  const seen = new Set<string>();
  const chunkIds: string[] = [];
  for (const r of refs) if (r.chunkId && !seen.has(r.chunkId)) (seen.add(r.chunkId), chunkIds.push(r.chunkId)); // prettier-ignore
  return { refs, chunkIds };
}
