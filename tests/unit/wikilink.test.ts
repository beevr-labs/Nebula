import { describe, it, expect } from 'vitest';
import {
  parseWikilinks,
  resolveTarget,
  renderWikilinks,
  rankTitles,
  autocompleteWikilink,
  applyWikilinkChoice,
  buildBacklinks,
  findUnlinkedMentions,
  rewriteWikilinkTitle,
  type NoteBody
} from '../../src/lib/weave/wikilink';
import { buildTitleIndex } from '../../src/lib/weave/weaver';

// FR-LINK-003/004/005 · OBSIDIAN-DNA §5.7. Manual wikilink authoring + backlinks.

describe('rewriteWikilinkTitle', () => {
  it('rewrites a bare target, preserving heading and alias', () => {
    const a = rewriteWikilinkTitle('see [[Old]] and [[Old#Setup]]', 'Old', 'New');
    expect(a).toEqual({ text: 'see [[New]] and [[New#Setup]]', changed: true });
    const b = rewriteWikilinkTitle('[[Old|the project]]', 'Old', 'New');
    expect(b.text).toBe('[[New|the project]]');
  });
  it('is case/space-insensitive on the target and leaves other links alone', () => {
    const r = rewriteWikilinkTitle('[[ old ]] [[Other]]', 'OLD', 'New');
    expect(r).toEqual({ text: '[[New]] [[Other]]', changed: true });
  });
  it('reports no change when nothing matches', () => {
    expect(rewriteWikilinkTitle('[[Other]]', 'Old', 'New')).toEqual({
      text: '[[Other]]',
      changed: false
    });
  });
});

const NOTES: NoteBody[] = [
  {
    docId: 'notes/apollo.md',
    title: 'Apollo',
    aliases: ['Apollo project'],
    body: 'Apollo ships in Q3.'
  },
  {
    docId: 'notes/roadmap.md',
    title: 'Roadmap',
    body: 'The [[Apollo]] launch is the headline. See [[Apollo|the project]] and `[[not a link]]`.'
  },
  { docId: 'notes/notes.md', title: 'Notes', body: 'Apollo is mentioned here but not linked.' }
];
const INDEX = buildTitleIndex(
  NOTES.map((n) => ({ docId: n.docId, title: n.title, aliases: n.aliases }))
);

describe('parseWikilinks', () => {
  it('parses plain, aliased, and headinged links with exact offsets', () => {
    const refs = parseWikilinks('a [[Apollo]] b [[Apollo|the project]] c [[Doc#Heading]]');
    expect(refs.map((r) => r.target)).toEqual(['Apollo', 'Apollo', 'Doc']);
    expect(refs[1].alias).toBe('the project');
    expect(refs[1].display).toBe('the project');
    expect(refs[2].display).toBe('Doc'); // heading dropped from display target
    // offsets round-trip
    const r0 = refs[0];
    expect('a [[Apollo]] b [[Apollo|the project]] c [[Doc#Heading]]'.slice(r0.start, r0.end)).toBe(
      '[[Apollo]]'
    );
  });

  it('ignores empty targets', () => {
    expect(parseWikilinks('[[]] and [[ | x]]')).toEqual([]);
  });
});

describe('resolveTarget', () => {
  it('resolves by title and by alias, case-insensitively', () => {
    expect(resolveTarget('apollo', INDEX)?.docId).toBe('notes/apollo.md');
    expect(resolveTarget('Apollo project', INDEX)?.docId).toBe('notes/apollo.md');
    expect(resolveTarget('Nonexistent', INDEX)).toBeNull();
  });
});

describe('renderWikilinks', () => {
  it('renders resolved links, alias display, and broken links', () => {
    const segs = renderWikilinks('Go [[Apollo]] or [[Apollo|here]] or [[Ghost]].', INDEX);
    const linked = segs.filter((s) => s.link);
    expect(linked).toHaveLength(2);
    expect(linked[0].text).toBe('Apollo');
    expect(linked[1].text).toBe('here'); // alias display
    expect(segs.some((s) => s.broken && s.text === 'Ghost')).toBe(true);
  });
});

describe('rankTitles', () => {
  it('prefers prefix over substring and dedupes by docId', () => {
    const s = rankTitles(INDEX, 'apo', 8);
    expect(s[0].docId).toBe('notes/apollo.md');
    // 'Apollo' and alias 'Apollo project' are the same doc → one entry
    expect(s.filter((x) => x.docId === 'notes/apollo.md')).toHaveLength(1);
  });

  it('empty query returns up to limit candidates', () => {
    expect(rankTitles(INDEX, '', 2).length).toBe(2);
  });
});

describe('autocompleteWikilink + applyWikilinkChoice', () => {
  it('detects an open [[ and returns the partial query + suggestions', () => {
    const text = 'See [[apo';
    const state = autocompleteWikilink(text, text.length, INDEX);
    expect(state).not.toBeNull();
    expect(state!.query).toBe('apo');
    expect(state!.replaceStart).toBe(6); // just after "[["
    expect(state!.suggestions[0].title).toBe('Apollo');
  });

  it('returns null when the [[ is already closed or broken by a newline', () => {
    expect(autocompleteWikilink('see [[Apollo]] x', 16, INDEX)).toBeNull();
    expect(autocompleteWikilink('[[apo\nmore', 10, INDEX)).toBeNull();
  });

  it('splices the chosen title and closes the brackets', () => {
    const text = 'See [[apo';
    const state = autocompleteWikilink(text, text.length, INDEX)!;
    const res = applyWikilinkChoice(text, state, 'Apollo');
    expect(res.text).toBe('See [[Apollo]]');
    expect(res.caret).toBe(res.text.length);
  });
});

describe('buildBacklinks', () => {
  it('lists source notes that link to a target, with counts, excluding self-links', () => {
    const map = buildBacklinks(NOTES, INDEX);
    const apolloBacklinks = map.get('notes/apollo.md');
    expect(apolloBacklinks).toBeDefined();
    expect(apolloBacklinks![0].docId).toBe('notes/roadmap.md');
    expect(apolloBacklinks![0].count).toBe(2); // [[Apollo]] + [[Apollo|the project]]; the code-span one ignored
  });
});

describe('findUnlinkedMentions', () => {
  it('finds bare mentions of the title not already wikilinked, with a snippet', () => {
    const mentions = findUnlinkedMentions(
      { docId: 'notes/apollo.md', title: 'Apollo', aliases: ['Apollo project'] },
      NOTES
    );
    const docs = mentions.map((m) => m.docId);
    expect(docs).toContain('notes/notes.md'); // "Apollo is mentioned here but not linked."
    expect(docs).not.toContain('notes/roadmap.md'); // roadmap only has it inside [[ ]] / code
    const note = mentions.find((m) => m.docId === 'notes/notes.md')!;
    expect(note.snippet).toContain('«Apollo»');
  });
});
