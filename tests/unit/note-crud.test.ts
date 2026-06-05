import { describe, it, expect } from 'vitest';
import {
  slugify,
  notePathFromTitle,
  normalizeFolder,
  deriveNotePath,
  moveNotePath,
  renameNote,
  validateDraft,
  createNote,
  updateNote
} from '../../src/lib/vault/note-crud';
import { parseNote, computeNoteHash } from '../../src/lib/vault/note';

// FR-NOTE-001..004 · OBSIDIAN-DNA §5.6. Hand-written notes as first-class vault `.md`.

describe('slugify', () => {
  it('lowercases, hyphenates, and trims to an Obsidian-safe stem', () => {
    expect(slugify('Project X Liability')).toBe('project-x-liability');
    expect(slugify('  Hello,  World!! ')).toBe('hello-world');
    expect(slugify('Q3 / 2026 — Revenue')).toBe('q3-2026-revenue');
  });

  it('strips diacritics (incl. Vietnamese) for a portable filename', () => {
    expect(slugify('Đánh giá Quý 3')).toBe('danh-gia-quy-3');
    expect(slugify('Café Déjà Vu')).toBe('cafe-deja-vu');
  });

  it('degrades a punctuation-only / empty title to "untitled"', () => {
    expect(slugify('')).toBe('untitled');
    expect(slugify('!!!')).toBe('untitled');
    expect(slugify('   ')).toBe('untitled');
  });
});

describe('normalizeFolder', () => {
  it('slugifies each segment and keeps nesting', () => {
    expect(normalizeFolder('Clients / Acme Inc')).toBe('clients/acme-inc');
    expect(normalizeFolder('Đánh giá')).toBe('danh-gia');
  });
  it('returns empty for a blank/punctuation-only folder', () => {
    expect(normalizeFolder('')).toBe('');
    expect(normalizeFolder('  /  ')).toBe('');
  });
});

describe('deriveNotePath', () => {
  it('honors a (nested) folder and defaults to notes/', () => {
    expect(deriveNotePath('My Note')).toBe('notes/my-note.md');
    expect(deriveNotePath('My Note', { folder: 'Clients/Acme' })).toBe('clients/acme/my-note.md');
  });
  it('suffixes within the chosen folder on collision', () => {
    expect(deriveNotePath('Note', { folder: 'clients', existingPaths: ['clients/note.md'] })).toBe(
      'clients/note-2.md'
    );
  });
});

describe('moveNotePath', () => {
  it('keeps the filename, changes only the folder', () => {
    expect(moveNotePath('notes/apollo.md', 'clients/acme')).toBe('clients/acme/apollo.md');
  });
  it('is a no-op when already in the target folder', () => {
    expect(moveNotePath('notes/apollo.md', 'notes')).toBe('notes/apollo.md');
  });
  it('suffixes the stem on a name clash in the destination', () => {
    expect(moveNotePath('notes/apollo.md', 'clients', ['clients/apollo.md'])).toBe(
      'clients/apollo-2.md'
    );
  });
});

describe('renameNote', () => {
  it('changes the title + path (same folder) and re-stamps the hash', async () => {
    const created = await createNote({
      title: 'Old Name',
      body: 'hello',
      now: '2026-06-06T00:00:00Z'
    });
    const renamed = await renameNote({
      docId: created.docId,
      markdown: created.markdown,
      newTitle: 'New Name',
      now: '2026-06-07T00:00:00Z'
    });
    expect(created.docId).toBe('notes/old-name.md');
    expect(renamed.docId).toBe('notes/new-name.md');
    expect(renamed.note.frontmatter.title).toBe('New Name');
    expect(renamed.note.frontmatter.modified).toBe('2026-06-07T00:00:00Z');
    // hash stays honest: re-reading the file reproduces nebula_hash (FR-DATA-003).
    expect(renamed.note.frontmatter.nebula_hash).toBe(await computeNoteHash(renamed.markdown));
  });

  it('preserves the original folder when renaming a moved note', async () => {
    const created = await createNote({
      title: 'Spec',
      body: 'x',
      now: '2026-06-06T00:00:00Z',
      folder: 'clients/acme'
    });
    const renamed = await renameNote({
      docId: created.docId,
      markdown: created.markdown,
      newTitle: 'Spec v2',
      now: '2026-06-06T00:00:00Z'
    });
    expect(renamed.docId).toBe('clients/acme/spec-v2.md');
  });
});

describe('createNote (folder)', () => {
  it('writes into the requested folder', async () => {
    const f = await createNote({
      title: 'Brief',
      body: '',
      now: '2026-06-06T00:00:00Z',
      folder: 'Clients/Globex'
    });
    expect(f.docId).toBe('clients/globex/brief.md');
  });
});

describe('notePathFromTitle', () => {
  it('builds notes/<slug>.md', () => {
    expect(notePathFromTitle('My Note')).toBe('notes/my-note.md');
  });

  it('avoids collisions by suffixing -2, -3 …', () => {
    const taken = ['notes/my-note.md', 'notes/my-note-2.md'];
    expect(notePathFromTitle('My Note', taken)).toBe('notes/my-note-3.md');
  });

  it('two untitled notes never overwrite each other', () => {
    const first = notePathFromTitle('', []);
    const second = notePathFromTitle('', [first]);
    expect(first).toBe('notes/untitled.md');
    expect(second).toBe('notes/untitled-2.md');
  });
});

describe('validateDraft', () => {
  it('requires a non-blank title; empty body is fine', () => {
    expect(validateDraft({ title: 'Has title', body: '' }).ok).toBe(true);
    const bad = validateDraft({ title: '   ', body: 'x' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toMatch(/title/i);
  });
});

describe('createNote', () => {
  it('produces a valid .md with note frontmatter, trimmed title, and a body-hash', async () => {
    const file = await createNote({
      title: '  Project X  ',
      body: 'Liability caps for Project X.',
      now: '2026-06-06T10:00:00Z',
      id: '01J9Z3K7QW8N'
    });
    expect(file.docId).toBe('notes/project-x.md');
    expect(file.note.frontmatter.title).toBe('Project X'); // trimmed
    expect(file.note.frontmatter.type).toBe('note');
    expect(file.note.frontmatter.id).toBe('01J9Z3K7QW8N');
    expect(file.note.frontmatter.created).toBe('2026-06-06T10:00:00Z');
    expect(file.note.frontmatter.modified).toBe('2026-06-06T10:00:00Z');
    expect(file.note.body).toBe('Liability caps for Project X.');

    // nebula_hash is over the BODY only (matches change-detection, FR-DATA-003)
    expect(file.note.frontmatter.nebula_hash).toBe(await computeNoteHash(file.markdown));

    // round-trips: serialized markdown parses back to the same frontmatter+body
    const round = parseNote(file.markdown);
    expect(round.frontmatter.title).toBe('Project X');
    expect(round.body.trim()).toBe('Liability caps for Project X.');
  });

  it('is deterministic — same draft + injected now ⇒ byte-identical markdown', async () => {
    const input = { title: 'Same', body: 'Same body', now: '2026-06-06T00:00:00Z' };
    const a = await createNote({ ...input });
    const b = await createNote({ ...input });
    expect(a.markdown).toBe(b.markdown);
  });

  it('derives a collision-free path from existing vault paths', async () => {
    const file = await createNote({
      title: 'My Note',
      body: '',
      now: '2026-06-06T00:00:00Z',
      existingPaths: ['notes/my-note.md']
    });
    expect(file.docId).toBe('notes/my-note-2.md');
  });

  it('omits id when not injected and preserves caller frontmatter', async () => {
    const file = await createNote({
      title: 'Tagged',
      body: 'x',
      now: '2026-06-06T00:00:00Z',
      frontmatter: { tags: ['a', 'b'], type: 'memo' }
    });
    expect(file.note.frontmatter.id).toBeUndefined();
    expect(file.note.frontmatter.tags).toEqual(['a', 'b']);
    expect(file.note.frontmatter.type).toBe('memo'); // caller type wins over default 'note'
  });
});

describe('updateNote', () => {
  it('re-stamps modified + nebula_hash on a body edit, preserving id/created/tags', async () => {
    const created = await createNote({
      title: 'Doc',
      body: 'old body',
      now: '2026-06-06T10:00:00Z',
      id: '01ABC',
      frontmatter: { tags: ['keep'] }
    });

    const edited = await updateNote({
      docId: created.docId,
      markdown: created.markdown,
      body: 'new longer body text',
      now: '2026-06-07T09:30:00Z'
    });

    expect(edited.docId).toBe('notes/doc.md'); // path unchanged
    expect(edited.note.frontmatter.id).toBe('01ABC'); // stable
    expect(edited.note.frontmatter.created).toBe('2026-06-06T10:00:00Z'); // preserved
    expect(edited.note.frontmatter.modified).toBe('2026-06-07T09:30:00Z'); // bumped
    expect(edited.note.frontmatter.tags).toEqual(['keep']); // preserved
    expect(edited.note.body).toBe('new longer body text');
    expect(edited.note.frontmatter.nebula_hash).toBe(await computeNoteHash(edited.markdown));
    expect(edited.note.frontmatter.nebula_hash).not.toBe(created.note.frontmatter.nebula_hash);
  });

  it('keeps the existing body when only the title changes', async () => {
    const created = await createNote({
      title: 'Old Title',
      body: 'unchanged body',
      now: '2026-06-06T10:00:00Z'
    });
    const edited = await updateNote({
      docId: created.docId,
      markdown: created.markdown,
      title: 'New Title',
      now: '2026-06-07T00:00:00Z'
    });
    expect(edited.note.frontmatter.title).toBe('New Title');
    expect(edited.note.body).toBe('unchanged body');
    // body-only hash is unchanged because the body didn't change
    expect(edited.note.frontmatter.nebula_hash).toBe(created.note.frontmatter.nebula_hash);
  });
});
