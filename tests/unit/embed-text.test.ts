import { describe, it, expect } from 'vitest';
import {
  headingIndex,
  sectionAt,
  docTitleOf,
  normalizeForEmbedding,
  buildEmbedText
} from '../../src/lib/ingest/embed-text';

describe('headingIndex — ATX headings with offsets + levels', () => {
  it('finds headings in document order with correct levels', () => {
    const text = '# Báo cáo Q4\n\nMở đầu.\n\n## Doanh thu\n\nSố liệu.\n\n### Chi tiết\nrow';
    const hs = headingIndex(text);
    expect(hs.map((h) => [h.level, h.text])).toEqual([
      [1, 'Báo cáo Q4'],
      [2, 'Doanh thu'],
      [3, 'Chi tiết']
    ]);
    // offsets are monotonically increasing (so sectionAt's binary search is valid)
    for (let i = 1; i < hs.length; i++) expect(hs[i].offset).toBeGreaterThan(hs[i - 1].offset);
  });

  it('ignores "#" that is not a heading (no space after, or mid-line)', () => {
    expect(headingIndex('a #notahashtag\ntext #5 issue')).toEqual([]);
  });
});

describe('sectionAt — nearest heading at or before an offset', () => {
  const text = '# Title\n\nintro\n\n## Alpha\n\nbody of alpha\n\n## Beta\n\nbody of beta';
  const hs = headingIndex(text);

  it('returns the section a char offset lives under', () => {
    const alphaBody = text.indexOf('body of alpha');
    const betaBody = text.indexOf('body of beta');
    expect(sectionAt(hs, alphaBody)).toBe('Alpha');
    expect(sectionAt(hs, betaBody)).toBe('Beta');
  });

  it('returns the H1 for content between the title and the first subheading', () => {
    expect(sectionAt(hs, text.indexOf('intro'))).toBe('Title');
  });

  it('returns "" when the offset is above the first heading', () => {
    expect(sectionAt(headingIndex('no headings here\njust text'), 3)).toBe('');
  });
});

describe('docTitleOf — first level-1 heading only', () => {
  it('returns the first H1', () => {
    expect(docTitleOf(headingIndex('## sub\n# Real Title\n# Second H1'))).toBe('Real Title');
  });
  it('returns "" when there is no H1 (only deeper headings)', () => {
    expect(docTitleOf(headingIndex('## only a sub\ntext'))).toBe('');
  });
});

describe('normalizeForEmbedding — strip markdown structure, keep content', () => {
  it('drops table rule rows and linearizes data rows to cell values', () => {
    const md = '| Quý | Sản phẩm | Doanh thu |\n| --- | --- | --- |\n| Q4 | Thiên Lộc A | 1620 |';
    const out = normalizeForEmbedding(md);
    expect(out).not.toContain('|');
    expect(out).not.toContain('---');
    expect(out).toContain('Q4 · Thiên Lộc A · 1620');
    expect(out).toContain('Quý · Sản phẩm · Doanh thu');
  });

  it('keeps an escaped pipe as a literal character in a cell', () => {
    expect(normalizeForEmbedding('| a \\| b | c |')).toBe('a | b · c');
  });

  it('strips heading / list / blockquote markers but keeps their text', () => {
    const md = '## Mục tiêu\n- điểm một\n- điểm hai\n1. bước đầu\n> trích dẫn';
    const out = normalizeForEmbedding(md);
    expect(out).toBe('Mục tiêu\nđiểm một\nđiểm hai\nbước đầu\ntrích dẫn');
  });

  it('collapses intra-line whitespace and excess blank lines', () => {
    expect(normalizeForEmbedding('a   b\n\n\n\nc')).toBe('a b\n\nc');
  });

  it('leaves a lone inline pipe in prose untouched', () => {
    expect(normalizeForEmbedding('use a | b for OR')).toBe('use a | b for OR');
  });
});

describe('buildEmbedText — contextual prefix + normalized body', () => {
  it('prepends "Title › Section" to the normalized body', () => {
    const out = buildEmbedText({ docTitle: 'Báo cáo Q4', section: 'Doanh thu', body: '- số liệu' });
    expect(out).toBe('Báo cáo Q4 › Doanh thu\nsố liệu');
  });

  it('does not repeat the title when the section equals it (chunk under the H1)', () => {
    expect(buildEmbedText({ docTitle: 'Title', section: 'Title', body: 'x' })).toBe('Title\nx');
  });

  it('emits only the section when there is no title', () => {
    expect(buildEmbedText({ docTitle: '', section: 'Alpha', body: 'x' })).toBe('Alpha\nx');
  });

  it('emits just the body when there is no title or section', () => {
    expect(buildEmbedText({ body: 'plain text' })).toBe('plain text');
  });

  it('falls back to the original body when normalization empties it (pure table rules)', () => {
    const out = buildEmbedText({ docTitle: 'T', section: 'S', body: '| --- | --- |' });
    expect(out).toBe('T › S\n| --- | --- |');
  });
});
