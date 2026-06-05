import { describe, it, expect } from 'vitest';
import {
  parseNote,
  serializeNote,
  computeNoteHash,
  hasChanged,
  withNebulaHash
} from '../../src/lib/vault/note';

// FR-DATA-001/003 · TC-PORT-001 (round-trip) · TC-DATA-003 (change detection).

const sample = `---
id: 01J9Z3K7QW8N
title: Project X
type: contract
tags: [legal, project-x]
custom_obsidian_key: keep-me
---

# Project X

Body content here.
`;

describe('TC-PORT-001 — frontmatter round-trip preserves keys', () => {
  it('parses frontmatter + body', () => {
    const { frontmatter, body } = parseNote(sample);
    expect(frontmatter.id).toBe('01J9Z3K7QW8N');
    expect(frontmatter.type).toBe('contract');
    expect(frontmatter.tags).toEqual(['legal', 'project-x']);
    expect(body).toContain('# Project X');
  });

  it('preserves unknown (Obsidian/user) keys on re-serialize (NFR-PORT-001)', () => {
    const out = serializeNote(parseNote(sample));
    const reparsed = parseNote(out);
    expect(reparsed.frontmatter.custom_obsidian_key).toBe('keep-me');
    expect(reparsed.frontmatter.title).toBe('Project X');
    expect(reparsed.body.trim()).toContain('Body content here.');
  });
});

describe('TC-DATA-003 — content-hash change detection', () => {
  it('produces a sha256: hash of the body', async () => {
    const h = await computeNoteHash(sample);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('detects a body edit but ignores metadata-only frontmatter edits', async () => {
    const stored = await computeNoteHash(sample);

    // Add a tag (metadata only) → body unchanged → not "changed".
    const metaEdited = sample.replace('[legal, project-x]', '[legal, project-x, new-tag]');
    expect(await hasChanged(metaEdited, stored)).toBe(false);

    // Edit the body → changed.
    const bodyEdited = sample.replace('Body content here.', 'Body content CHANGED.');
    expect(await hasChanged(bodyEdited, stored)).toBe(true);
  });

  it('treats a missing stored hash as changed (first sight)', async () => {
    expect(await hasChanged(sample, null)).toBe(true);
  });

  it('stamps nebula_hash into frontmatter', async () => {
    const stamped = await withNebulaHash(sample);
    const fm = parseNote(stamped).frontmatter;
    expect(fm.nebula_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fm.custom_obsidian_key).toBe('keep-me'); // still preserved
  });
});
