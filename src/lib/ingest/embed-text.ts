// What the EMBEDDER actually sees — deliberately DISTINCT from a chunk's stored `text` (which stays
// verbatim, with charStart/charEnd, so a citation can still scroll/highlight the exact span —
// FR-CHAT-003). Two cheap, deterministic transforms that lift retrieval quality without touching
// offsets or the DB schema:
//
//   1. NORMALIZE — strip markdown *structure* (table bars + separator rules, list/heading/quote
//      markers) that the model would otherwise embed as if it were content. A raw row like
//      "| Q4 | Thiên Lộc A | 1620 |" or a "| --- | --- |" rule dilutes the vector with punctuation;
//      we keep the cell *values* and drop the scaffolding so the embedding keys on words.
//   2. CONTEXTUALIZE — prepend a short "Note title › Section" line so a 60-token fragment carries the
//      heading it lives under (Anthropic's "contextual retrieval"). The small chunk size trades away
//      context for precision; this hands a little of it back. Title + section are derived from the
//      note's OWN markdown headings, so this needs no title plumbing through the ingest call sites.
//
// Pure & deterministic (ALGORITHMS §7) — unit-testable without a GPU/model. The embed Worker feeds
// buildEmbedText(...) to the embedder; the store still persists the original chunk text, so nothing
// downstream of retrieval (citations, lexical channel, References) changes.

export interface Heading {
  offset: number; // char offset of the heading line in the source text
  level: number; // 1–6 (count of leading '#')
  text: string; // heading text, markers stripped
}

// ATX headings only ("# …" … "###### …"), at line start, optional trailing '#'s tolerated. Multiline
// + global so matchAll walks the whole document in one pass. Code-fence-blind on purpose: a stray
// "# foo" in a code block becoming a spurious section prefix is low-harm and not worth a fence parser.
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*$/gm;

// A GFM table separator / horizontal rule row: optional outer pipes around runs of 2+ dashes (with
// optional ':' alignment). Pure structure — dropped entirely. Also catches a bare "---" hr (also noise).
const TABLE_RULE_RE = /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/;

const MAX_PREFIX_PART = 140; // bound each context part so the prefix can never eat the embed window

/** All ATX headings in document order, with offsets + levels. One pass, pure. */
export function headingIndex(text: string): Heading[] {
  const out: Heading[] = [];
  for (const m of text.matchAll(HEADING_RE)) {
    out.push({ offset: m.index ?? 0, level: m[1].length, text: m[2].trim() });
  }
  return out;
}

/** The nearest heading at or before `charStart` — the SECTION a chunk lives in. Binary search over the
 *  (already offset-sorted) index; '' when the chunk sits above the first heading. */
export function sectionAt(headings: Heading[], charStart: number): string {
  let lo = 0;
  let hi = headings.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (headings[mid].offset <= charStart) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans === -1 ? '' : headings[ans].text;
}

/** The note's title for the prefix: its first level-1 heading, else '' . Kept deliberately narrow —
 *  a random first line isn't a title, so only an explicit `# H1` is trusted (otherwise the section
 *  alone carries the context). */
export function docTitleOf(headings: Heading[]): string {
  return headings.find((h) => h.level === 1)?.text ?? '';
}

/** True for a table data/header row (starts with '|', or has ≥2 pipes) — so a lone inline '|' in prose
 *  is left untouched while real rows get their bars stripped. */
function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith('|') || (t.match(/\|/g)?.length ?? 0) >= 2;
}

/** A table row → its cell VALUES joined by ' · ', bars dropped. Splits on UNescaped '|' (csv.ts writes
 *  a literal cell pipe as '\|'), so an escaped pipe survives as '|'; empty outer cells are dropped. */
function stripTableRow(line: string): string {
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '|') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells
    .map((c) => c.trim())
    .filter(Boolean)
    .join(' · ');
}

/**
 * Strip markdown STRUCTURE for embedding while preserving all human content:
 *   • table rule / hr rows         → dropped
 *   • table data rows "| a | b |"  → "a · b" (bars gone, cell values + escaped pipes kept)
 *   • leading block markers (#, >, -, *, +, "1.") → removed, the text after them kept
 *   • intra-line whitespace collapsed, 3+ blank lines → one
 * Conservative: never removes alphanumeric content. Pure.
 */
export function normalizeForEmbedding(text: string): string {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    if (TABLE_RULE_RE.test(raw)) continue; // pure scaffolding — drop the whole line
    let line = isTableRow(raw) ? stripTableRow(raw) : raw;
    line = line
      .replace(/^[ \t]*#{1,6}[ \t]+/, '') // heading marker
      .replace(/^[ \t]*>[ \t]?/, '') // blockquote
      .replace(/^[ \t]*[-*+][ \t]+/, '') // bullet list
      .replace(/^[ \t]*\d+[.)][ \t]+/, '') // ordered list
      .replace(/[ \t]+/g, ' ')
      .trimEnd();
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function clampPart(s: string): string {
  const t = s.trim();
  return t.length > MAX_PREFIX_PART ? t.slice(0, MAX_PREFIX_PART).trimEnd() : t;
}

/**
 * The exact string fed to the embedder for one chunk: a bounded "Title › Section" context line
 * (deduped, omitted when empty) prepended to the normalized body. Falls back to the original
 * trimmed body if normalization leaves nothing (a chunk that was pure table rules), so we never
 * embed an empty string. Pure.
 */
export function buildEmbedText(opts: { docTitle?: string; section?: string; body: string }): string {
  const body = normalizeForEmbedding(opts.body) || opts.body.trim();
  const title = clampPart(opts.docTitle ?? '');
  const section = clampPart(opts.section ?? '');
  const parts: string[] = [];
  if (title) parts.push(title);
  if (section && section !== title) parts.push(section);
  const prefix = parts.join(' › ');
  return prefix ? `${prefix}\n${body}` : body;
}
