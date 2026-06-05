// Manual wikilink authoring + backlinks (FR-LINK-003/004/005) · OBSIDIAN-DNA §5.7.
//
// The Weaver (§5.2) auto-links the AI's *output*; this module gives the USER Obsidian's core
// move — typing `[[Note]]` by hand — plus the panel that makes links worth typing: backlinks
// (who links here) and unlinked mentions (where this note's name appears unlinked). All pure
// and deterministic over the same `TitleIndex` the Weaver already builds, so there is zero new
// indexing cost and no GPU/DB. ALGORITHMS §14.

import { type TitleIndex, buildTitleIndex, weaveLinks } from '$lib/weave/weaver';

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

export interface WikilinkRef {
  raw: string; // full match, e.g. "[[Apollo|the project]]"
  target: string; // the note name: "Apollo" (before any "#heading" or "|alias")
  alias?: string; // display override after "|"
  display: string; // alias ?? target
  start: number; // index of "[["
  end: number; // index just past "]]"
}

/**
 * Parse every `[[wikilink]]` in `text` (FR-LINK-003). Handles `[[Target]]`,
 * `[[Target|Alias]]`, and `[[Target#Heading]]` (heading dropped from the resolved target).
 * Ignores empty targets. Offsets are exact so a renderer/editor can map back to the source.
 */
export function parseWikilinks(text: string): WikilinkRef[] {
  const re = /\[\[([^[\]\n]+)\]\]/g;
  const out: WikilinkRef[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const inner = m[1];
    const pipe = inner.indexOf('|');
    const linkPart = pipe >= 0 ? inner.slice(0, pipe) : inner;
    const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : undefined;
    const hash = linkPart.indexOf('#');
    const target = (hash >= 0 ? linkPart.slice(0, hash) : linkPart).trim();
    if (!target) continue;
    out.push({
      raw: m[0],
      target,
      alias: alias || undefined,
      display: alias || target,
      start: m.index,
      end: m.index + m[0].length
    });
  }
  return out;
}

/** Resolve a wikilink target to a note via the title/alias index (FR-LINK-003). */
export function resolveTarget(
  target: string,
  index: TitleIndex
): { docId: string; title: string } | null {
  const key = norm(target);
  const hit = index.surfaces.find((s) => s.surface === key);
  return hit ? { docId: hit.docId, title: hit.title } : null;
}

export interface LinkSegment {
  text: string;
  link?: { docId: string; title: string }; // resolved → clickable
  broken?: boolean; // a `[[name]]` that matches no note (Obsidian shows these dimmed)
}

/**
 * Render `text` into segments for display, turning each `[[wikilink]]` into a clickable (or
 * broken) link and leaving the rest as plain text. NOTE: this REPLACES `[[A|b]]` with its
 * display form `b`, so concatenating segments does not reproduce the source — it is a view,
 * not a lossless transform (unlike `weaveLinks`).
 */
export function renderWikilinks(text: string, index: TitleIndex): LinkSegment[] {
  const refs = parseWikilinks(text);
  const out: LinkSegment[] = [];
  let pos = 0;
  for (const ref of refs) {
    if (ref.start > pos) out.push({ text: text.slice(pos, ref.start) });
    const r = resolveTarget(ref.target, index);
    if (r) out.push({ text: ref.display, link: r });
    else out.push({ text: ref.display, broken: true });
    pos = ref.end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos) });
  return out;
}

/**
 * Rewrite every `[[wikilink]]` whose bare target equals `oldTitle` (case/space-insensitive) so it
 * points at `newTitle`, preserving any `#heading` and `|alias` (FR-LINK-003). Used on rename so
 * inbound links don't break when a note's title changes. Returns the new text + whether anything
 * changed. Links whose target is an *alias* of the note (not its title) are left as-is — they
 * still resolve through the alias index.
 */
export function rewriteWikilinkTitle(
  text: string,
  oldTitle: string,
  newTitle: string
): { text: string; changed: boolean } {
  const oldKey = norm(oldTitle);
  let out = '';
  let pos = 0;
  let changed = false;
  for (const ref of parseWikilinks(text)) {
    out += text.slice(pos, ref.start);
    if (norm(ref.target) === oldKey) {
      const inner = ref.raw.slice(2, -2); // strip "[[" … "]]"
      const pipe = inner.indexOf('|');
      const aliasPart = pipe >= 0 ? inner.slice(pipe) : ''; // includes the leading "|"
      const linkPart = pipe >= 0 ? inner.slice(0, pipe) : inner;
      const hash = linkPart.indexOf('#');
      const headingPart = hash >= 0 ? linkPart.slice(hash) : ''; // includes the leading "#"
      out += `[[${newTitle}${headingPart}${aliasPart}]]`;
      changed = true;
    } else {
      out += ref.raw;
    }
    pos = ref.end;
  }
  out += text.slice(pos);
  return { text: out, changed };
}

export interface WikilinkSuggestion {
  docId: string;
  title: string;
}

export interface AutocompleteState {
  query: string; // the partial note name typed after "[["
  replaceStart: number; // index just after "[[" — where to splice the chosen title
  caret: number; // the caret position the query ends at
  suggestions: WikilinkSuggestion[];
}

/** Rank distinct notes whose title/alias matches `q` (prefix > substring), deduped by docId. */
export function rankTitles(index: TitleIndex, q: string, limit = 8): WikilinkSuggestion[] {
  const query = norm(q);
  const scored: { docId: string; title: string; score: number; len: number }[] = [];
  for (const s of index.surfaces) {
    let score: number;
    if (query === '') score = 0;
    else if (s.surface.startsWith(query)) score = 2;
    else if (s.surface.includes(query)) score = 1;
    else continue;
    scored.push({ docId: s.docId, title: s.title, score, len: s.surface.length });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score || a.len - b.len || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)
  );
  const seen = new Set<string>();
  const out: WikilinkSuggestion[] = [];
  for (const x of scored) {
    if (seen.has(x.docId)) continue;
    seen.add(x.docId);
    out.push({ docId: x.docId, title: x.title });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Autocomplete for the editor (FR-LINK-003): given the full `text` and the `caret` offset,
 * detect an open `[[` on the current line with no closing `]]` yet, and return the partial
 * query + ranked suggestions. Returns null when the caret is not inside an open wikilink.
 */
export function autocompleteWikilink(
  text: string,
  caret: number,
  index: TitleIndex,
  limit = 8
): AutocompleteState | null {
  const before = text.slice(0, caret);
  const open = before.lastIndexOf('[[');
  if (open < 0) return null;
  const between = before.slice(open + 2);
  // An open `[[` is only "active" if nothing since closes/breaks it.
  if (between.includes(']]') || between.includes('\n') || between.includes('[[')) return null;
  const pipe = between.indexOf('|');
  const linkQuery = pipe >= 0 ? between.slice(0, pipe) : between;
  return {
    query: linkQuery,
    replaceStart: open + 2,
    caret,
    suggestions: rankTitles(index, linkQuery, limit)
  };
}

/**
 * Splice a chosen note title into an open `[[` (FR-LINK-003). Replaces the partial query
 * between `state.replaceStart` and the caret with `title]]`, returning the new text + the
 * caret position to place just past the inserted `]]`.
 */
export function applyWikilinkChoice(
  text: string,
  state: AutocompleteState,
  title: string
): { text: string; caret: number } {
  const head = text.slice(0, state.replaceStart);
  const tail = text.slice(state.caret);
  const inserted = `${title}]]`;
  return { text: head + inserted + tail, caret: head.length + inserted.length };
}

export interface Backlink {
  docId: string;
  title: string;
  count: number; // how many times the source note links here
}

export interface NoteBody {
  docId: string;
  title: string;
  body: string;
  aliases?: string[];
}

/**
 * Compute linked backlinks for the whole vault (FR-LINK-004): for each target note, the source
 * notes that contain a `[[wikilink]]` resolving to it (self-links excluded), ordered by count
 * then docId. Returns a map keyed by target docId.
 */
export function buildBacklinks(notes: NoteBody[], index: TitleIndex): Map<string, Backlink[]> {
  const titleByDoc = new Map(notes.map((n) => [n.docId, n.title]));
  const edges = new Map<string, Map<string, number>>(); // target -> (source -> count)
  for (const note of notes) {
    for (const ref of parseWikilinks(note.body)) {
      const r = resolveTarget(ref.target, index);
      if (!r || r.docId === note.docId) continue;
      if (!edges.has(r.docId)) edges.set(r.docId, new Map());
      const inner = edges.get(r.docId)!;
      inner.set(note.docId, (inner.get(note.docId) ?? 0) + 1);
    }
  }
  const result = new Map<string, Backlink[]>();
  for (const [target, sources] of edges) {
    const list = [...sources].map(([docId, count]) => ({
      docId,
      title: titleByDoc.get(docId) ?? docId,
      count
    }));
    list.sort((a, b) => b.count - a.count || (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0));
    result.set(target, list);
  }
  return result;
}

export interface UnlinkedMention {
  docId: string;
  title: string;
  snippet: string; // the mention with a little surrounding context, «marked»
}

/**
 * Find unlinked mentions of `target` (FR-LINK-005): other notes whose body contains the
 * target's title/alias as bare text NOT already inside a `[[wikilink]]`, code span, or fenced
 * block. Reuses the Weaver's matcher (longest-match, word-boundary aware) over a one-note
 * index, so it can't false-positive inside code or existing links.
 */
export function findUnlinkedMentions(
  target: { docId: string; title: string; aliases?: string[] },
  notes: NoteBody[]
): UnlinkedMention[] {
  const idx = buildTitleIndex([
    { docId: target.docId, title: target.title, aliases: target.aliases }
  ]);
  const out: UnlinkedMention[] = [];
  for (const note of notes) {
    if (note.docId === target.docId) continue;
    const segs = weaveLinks(note.body, idx, { once: true });
    let offset = 0;
    let found = -1;
    let len = 0;
    for (const s of segs) {
      if (s.link && s.link.docId === target.docId) {
        found = offset;
        len = s.text.length;
        break;
      }
      offset += s.text.length;
    }
    if (found >= 0) {
      const pre = note.body.slice(Math.max(0, found - 30), found);
      const hit = note.body.slice(found, found + len);
      const post = note.body.slice(found + len, found + len + 30);
      out.push({
        docId: note.docId,
        title: note.title,
        snippet: `${pre}«${hit}»${post}`.replace(/\s+/g, ' ').trim()
      });
    }
  }
  return out;
}
