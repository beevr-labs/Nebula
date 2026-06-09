// Safe-subset Markdown renderer (FR-UI-002 preview) · OBSIDIAN-DNA §5.10 · ADR-016.
//
// A dependency-free Markdown→HTML renderer scoped to what notes actually use: headings,
// bold/italic/strikethrough, inline + fenced code, blockquotes, hr, ordered/unordered/nested
// lists, task checkboxes, GFM tables, links, autolinks, and Nebula `[[wikilinks]]`. It is
// **escape-first**: every piece of source text is HTML-escaped, and the renderer NEVER passes
// raw HTML through — so `{@html}`-ing its output is safe even for imported/untrusted note
// bodies (no XSS, the local-first threat that matters here). Deliberately NOT full CommonMark:
// raw HTML, reference links, and exotic nesting are out of scope (ADR-016). Pure. ALGORITHMS §18.

export interface RenderOptions {
  /** Resolve a `[[target]]` to a note; returns null for a broken link. */
  resolveLink?: (target: string) => { docId: string; title: string } | null;
}

/**
 * Wrap inline `[#n]` citation markers (the chat answer's references to numbered context chunks) in a
 * clickable button so Magic Jump can resolve n → source note on click. Pure + escape-safe: it only
 * matches the literal `[#digits]` pattern, which `renderMarkdown` already passes through verbatim
 * (escapeHtml leaves `[`, `#`, `]`, and digits untouched), so it composes with rendered Markdown HTML
 * without re-parsing it. The caller maps `data-cite` → chunkId at click time. ALGORITHMS §18.
 *
 * When `valid` is supplied (the set of citation numbers that actually map to a retrieved source —
 * i.e. the `references` shown to the user), markers OUTSIDE that set are STRIPPED, not linkified: a
 * small model often emits `[#5]` when only 2 chunks were retrieved (or invents citations for an
 * ungrounded answer), and those would otherwise render as dead buttons that jump to nothing
 * (FR-CHAT-002/003). The preceding whitespace is swallowed with the marker so stripping doesn't
 * leave a double space or a space before punctuation. Omit `valid` to linkify every marker (the
 * raw, unvalidated behavior).
 */
export function linkifyCitations(html: string, valid?: ReadonlySet<number>): string {
  return html.replace(/(\s*)\[#(\d+)\]/g, (_m, ws: string, n: string) => {
    if (valid && !valid.has(Number(n))) return ''; // hallucinated / out-of-range → drop, never render
    return `${ws}<button type="button" class="cite" data-cite="${n}">[#${n}]</button>`;
  });
}

/** Escape the five HTML-significant characters. Applied to ALL source-derived text. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Allow http(s)/mailto/relative/anchor URLs; block javascript:, data:, and other schemes. */
function safeUrl(url: string): string | null {
  const u = url.trim();
  if (/^(https?:\/\/|mailto:|#|\/|\.{0,2}\/)/i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null; // any other explicit scheme → block
  return u; // bare relative path/word
}

// Placeholder sentinel: a Private-Use-Area code point that never appears in real note text.
// Built via fromCodePoint so the source file stays pure ASCII.
const PH = String.fromCodePoint(0xe000);

/** Render inline spans within a single block of text (escape-first). */
function inline(text: string, opts: RenderOptions): string {
  const stash: string[] = [];
  const keep = (html: string): string => {
    stash.push(html);
    return `${PH}${stash.length - 1}${PH}`;
  };

  let s = text;
  // 1. inline code — protect verbatim (no inner formatting), escaped.
  s = s.replace(/`([^`\n]+)`/g, (_m, c: string) => keep(`<code>${escapeHtml(c)}</code>`));
  // 2. wikilinks [[target]] / [[target|alias]] / [[target#heading]]
  s = s.replace(/\[\[([^[\]\n]+)\]\]/g, (_m, inner: string) => {
    const pipe = inner.indexOf('|');
    const linkPart = pipe >= 0 ? inner.slice(0, pipe) : inner;
    const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : '';
    const hash = linkPart.indexOf('#');
    const target = (hash >= 0 ? linkPart.slice(0, hash) : linkPart).trim();
    const display = escapeHtml(alias || target);
    const r = opts.resolveLink?.(target) ?? null;
    return keep(
      r
        ? `<a class="wikilink" data-doc="${escapeHtml(r.docId)}" role="link" tabindex="0">${display}</a>`
        : `<span class="broken-link">${display}</span>`
    );
  });
  // 3. markdown links [text](url)
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, txt: string, url: string) => {
    const safe = safeUrl(url);
    const inner = escapeHtml(txt);
    return keep(
      safe
        ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
        : inner
    );
  });
  // 4. bare autolinks
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre: string, url: string) => {
    const safe = safeUrl(url);
    return (
      pre +
      (safe
        ? keep(
            `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`
          )
        : escapeHtml(url))
    );
  });
  // 5. escape whatever text remains, THEN apply emphasis on the escaped text.
  s = escapeHtml(s);
  s = s
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  // 6. restore placeholders (escapeHtml left the PUA sentinel + digits intact).
  s = s.replace(new RegExp(`${PH}(\\d+)${PH}`, 'g'), (_m, i: string) => stash[+i]);
  return s;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

const isTableSep = (l: string | undefined): boolean =>
  !!l && /\|/.test(l) && /^[\s|:-]*-[\s|:-]*$/.test(l);

function blockStart(line: string): boolean {
  return (
    /^```/.test(line) ||
    /^#{1,6}\s/.test(line) ||
    /^>\s?/.test(line) ||
    /^(\s*([-*_])\s*){3,}$/.test(line) ||
    /^\s*([-*+]|\d+\.)\s+/.test(line)
  );
}

/** Parse a list starting at `lines[i]` whose items are indented exactly `baseIndent`. */
function parseList(
  lines: string[],
  i: number,
  baseIndent: number,
  opts: RenderOptions
): { html: string; next: number } {
  const first = /^(\s*)(\d+\.|[-*+])\s+/.exec(lines[i])!;
  const ordered = /\d+\./.test(first[2]);
  const items: string[] = [];
  while (i < lines.length) {
    const m = /^(\s*)(\d+\.|[-*+])\s+(.*)$/.exec(lines[i]);
    if (!m) break;
    const indent = m[1].length;
    if (indent !== baseIndent) break;
    let content = m[3];
    let prefix = '';
    const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
    if (task) {
      const checked = task[1].toLowerCase() === 'x';
      prefix = `<input type="checkbox" disabled${checked ? ' checked' : ''}> `;
      content = task[2];
    }
    i++;
    let child = '';
    const cm = i < lines.length ? /^(\s*)(\d+\.|[-*+])\s+/.exec(lines[i]) : null;
    if (cm && cm[1].length > baseIndent) {
      const r = parseList(lines, i, cm[1].length, opts);
      child = r.html;
      i = r.next;
    }
    items.push(`<li>${prefix}${inline(content, opts)}${child}</li>`);
  }
  const tag = ordered ? 'ol' : 'ul';
  return { html: `<${tag}>${items.join('')}</${tag}>`, next: i };
}

/**
 * Render Markdown to a safe HTML string (FR-UI-002 preview). Escape-first; never emits raw
 * source HTML. `opts.resolveLink` wires `[[wikilinks]]` to vault notes.
 */
export function renderMarkdown(src: string, opts: RenderOptions = {}): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lv = h[1].length;
      out.push(`<h${lv}>${inline(h[2].trim(), opts)}</h${lv}>`);
      i++;
      continue;
    }
    if (/^(\s*([-*_])\s*){3,}$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'), opts)}</blockquote>`);
      continue;
    }
    if (line.includes('|') && isTableSep(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i++]));
      }
      const thead = `<thead><tr>${header.map((c) => `<th>${inline(c, opts)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c, opts)}</td>`).join('')}</tr>`)
        .join('')}</tbody>`;
      out.push(`<table>${thead}${tbody}</table>`);
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const indent = /^(\s*)/.exec(line)![1].length;
      const r = parseList(lines, i, indent, opts);
      out.push(r.html);
      i = r.next;
      continue;
    }
    // paragraph: gather until a blank line or the start of another block
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !blockStart(lines[i]))
      buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '), opts)}</p>`);
  }
  return out.join('\n');
}
