import { describe, it, expect } from 'vitest';
import { renderMarkdown, escapeHtml, linkifyCitations } from '../../src/lib/render/markdown';

// FR-UI-002 (preview) · OBSIDIAN-DNA §5.10 · ADR-016. Safe-subset Markdown renderer.

const resolveLink = (target: string) =>
  target.toLowerCase() === 'apollo' ? { docId: 'notes/apollo.md', title: 'Apollo' } : null;

describe('escapeHtml', () => {
  it('escapes the five significant chars', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;'
    );
  });
});

describe('renderMarkdown — security (escape-first)', () => {
  it('escapes raw HTML in note text (no XSS)', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes an img/onerror payload as text', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).toContain('&lt;img');
  });

  it('blocks javascript: links, keeping the text', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('click');
    expect(html).not.toContain('<a href');
  });

  it('allows http(s) links with rel=noopener', () => {
    const html = renderMarkdown('[site](https://example.com)');
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">site</a>'
    );
  });
});

describe('renderMarkdown — blocks', () => {
  it('renders headings, emphasis, and code spans', () => {
    expect(renderMarkdown('# Title')).toBe('<h1>Title</h1>');
    expect(renderMarkdown('a **bold** and *italic* and ~~gone~~')).toBe(
      '<p>a <strong>bold</strong> and <em>italic</em> and <del>gone</del></p>'
    );
    expect(renderMarkdown('use `code` here')).toBe('<p>use <code>code</code> here</p>');
  });

  it('does not format inside inline code or fenced code', () => {
    expect(renderMarkdown('`**not bold**`')).toBe('<p><code>**not bold**</code></p>');
    expect(renderMarkdown('```\n<b>&\n```')).toBe('<pre><code>&lt;b&gt;&amp;</code></pre>');
  });

  it('renders unordered, ordered, nested, and task lists', () => {
    expect(renderMarkdown('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(renderMarkdown('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
    expect(renderMarkdown('- a\n  - a1')).toBe('<ul><li>a<ul><li>a1</li></ul></li></ul>');
    const tasks = renderMarkdown('- [ ] todo\n- [x] done');
    expect(tasks).toContain('<input type="checkbox" disabled> todo');
    expect(tasks).toContain('<input type="checkbox" disabled checked> done');
  });

  it('renders blockquotes and horizontal rules', () => {
    expect(renderMarkdown('> quoted')).toBe('<blockquote><p>quoted</p></blockquote>');
    expect(renderMarkdown('---')).toBe('<hr>');
  });

  it('renders a GFM table', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>1</td>');
  });
});

describe('renderMarkdown — wikilinks', () => {
  it('renders resolved links as clickable, broken ones dimmed, aliases as display', () => {
    const html = renderMarkdown('See [[Apollo]] and [[Apollo|the project]] and [[Ghost]].', {
      resolveLink
    });
    expect(html).toContain('<a class="wikilink" data-doc="notes/apollo.md"');
    expect(html).toContain('>the project</a>'); // alias display
    expect(html).toContain('<span class="broken-link">Ghost</span>');
  });

  it('does not treat a [[link]] inside code as a wikilink', () => {
    const html = renderMarkdown('`[[Apollo]]`', { resolveLink });
    expect(html).toContain('<code>[[Apollo]]</code>');
    expect(html).not.toContain('class="wikilink"');
  });
});

describe('linkifyCitations', () => {
  it('wraps [#n] markers in a clickable cite button carrying its number', () => {
    const out = linkifyCitations('Budget is blocked [#1] and Roland undercut us [#3].');
    expect(out).toContain('<button type="button" class="cite" data-cite="1">[#1]</button>');
    expect(out).toContain('<button type="button" class="cite" data-cite="3">[#3]</button>');
  });

  it('composes with rendered Markdown (markers survive renderMarkdown verbatim)', () => {
    const html = linkifyCitations(renderMarkdown('- step one [#2]', {}));
    expect(html).toContain(
      '<li>step one <button type="button" class="cite" data-cite="2">[#2]</button></li>'
    );
  });

  it('leaves text without markers untouched', () => {
    expect(linkifyCitations('no citations here')).toBe('no citations here');
  });

  it('strips markers outside the valid set (hallucinated / out-of-range citations)', () => {
    const valid = new Set([1, 2]);
    const out = linkifyCitations('Real [#1] but invented [#5] and another [#2].', valid);
    expect(out).toContain('data-cite="1"');
    expect(out).toContain('data-cite="2"');
    expect(out).not.toContain('data-cite="5"');
    expect(out).not.toContain('[#5]'); // the dead marker is gone entirely, not left as text
  });

  it('swallows the space before a stripped marker so no double space / pre-punctuation gap remains', () => {
    expect(linkifyCitations('the young Sun [#5].', new Set([1]))).toBe('the young Sun.');
  });

  it('with an empty valid set, strips every marker (ungrounded answer cites nothing)', () => {
    expect(linkifyCitations('Earth formed from a nebula [#1][#2].', new Set())).toBe(
      'Earth formed from a nebula.'
    );
  });

  it('keeps wrapping every marker when no valid set is given (raw behavior)', () => {
    const out = linkifyCitations('a [#1] b [#9]');
    expect(out).toContain('data-cite="1"');
    expect(out).toContain('data-cite="9"');
  });
});

describe('renderMarkdown — LaTeX math (KaTeX)', () => {
  it('renders inline $…$ math to KaTeX HTML', () => {
    const html = renderMarkdown('Solve $ax + b > 0$ for x.');
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('$ax'); // the raw delimiters are consumed
  });

  it('renders display $$…$$ and \\[…\\] as block (displayMode)', () => {
    expect(renderMarkdown(String.raw`$$\frac{1}{2}$$`)).toContain('katex-display');
    expect(renderMarkdown(String.raw`\[ x = \frac{-b}{a} \]`)).toContain('katex-display');
  });

  it('renders inline \\(…\\) math', () => {
    expect(renderMarkdown(String.raw`the value \(x^2\) here`)).toContain('class="katex"');
  });

  it('does NOT treat currency like $1,900 as math', () => {
    const html = renderMarkdown('The budget is $1,900 each.');
    expect(html).not.toContain('katex');
    expect(html).toContain('$1,900');
  });

  it('leaves a $700 … $500 currency pair as text', () => {
    const html = renderMarkdown('flights $700 and hotels $500');
    expect(html).not.toContain('katex');
    expect(html).toContain('$700');
    expect(html).toContain('$500');
  });

  it('still renders math that starts with a digit, e.g. $2x + 3 > 0$', () => {
    const html = renderMarkdown('Solve $2x + 3 > 0$ now.');
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('$2x');
  });

  it('classifies each $…$ pair so a currency run never cascades into a sentence span', () => {
    // "$2 > 0$" is math; the following "$x$" is math; the Vietnamese prose between them must NOT be
    // swallowed into a math span (the live bug: a digit-led pair leaked over the next sentence).
    const html = renderMarkdown('Vì $2 > 0$, nghiệm của bất phương trình là $x$ dương.');
    expect(html.match(/class="katex"/g)?.length).toBe(2);
    expect(html).toContain('nghiệm của bất phương trình là');
    expect(html).not.toContain('katex">nghiệm'); // prose not rendered as math
  });

  it('does not let math break the escape-first contract (no raw script passes through)', () => {
    const html = renderMarkdown(String.raw`$\text{<script>alert(1)</script>}$`);
    expect(html).not.toContain('<script>');
  });

  it('renders malformed TeX without throwing', () => {
    expect(() => renderMarkdown(String.raw`$\frac{1}{$`)).not.toThrow();
  });
});
