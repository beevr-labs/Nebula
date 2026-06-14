import { describe, it, expect } from 'vitest';
import { exportVaultZip, type VaultExportInput } from '../../src/lib/vault/export';
import { parseZip, readVaultZip } from '../../src/lib/vault/import';

// FR-DATA-006 (Eject Button) — the RETURN trip. Export already proves DB → portable zip; these prove
// zip → restorable vault, so a backup can actually be restored (export→import round-trips losslessly).

const sample: VaultExportInput = {
  notes: [
    {
      path: 'notes/apollo.md',
      frontmatter: { title: 'Apollo', tags: ['x', 'y'] },
      body: 'Ships in Q3.'
    },
    { path: 'trip/japan.md', frontmatter: { title: 'Japan' }, body: 'Maya, Leo, Priya.' }
  ]
};

describe('parseZip', () => {
  it('reads every entry (path + store method + bytes) out of a Nebula export', () => {
    const entries = parseZip(exportVaultZip(sample));
    expect(entries.map((e) => e.path).sort()).toEqual(['notes/apollo.md', 'trip/japan.md']);
    expect(entries.every((e) => e.method === 0)).toBe(true);
    const apollo = entries.find((e) => e.path === 'notes/apollo.md')!;
    expect(new TextDecoder().decode(apollo.data)).toContain('Ships in Q3.');
  });

  it('throws on a buffer that is not a ZIP', () => {
    expect(() => parseZip(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(/ZIP/i);
  });
});

describe('readVaultZip', () => {
  it('restores notes with frontmatter + body parsed back out', () => {
    const { notes, originals, skipped } = readVaultZip(exportVaultZip(sample));
    expect(skipped).toEqual([]);
    expect(originals).toEqual([]);
    const apollo = notes.find((n) => n.path === 'notes/apollo.md')!;
    expect(apollo.body.trim()).toBe('Ships in Q3.');
    expect(apollo.frontmatter.title).toBe('Apollo');
    expect(apollo.frontmatter.tags).toEqual(['x', 'y']);
  });

  it('round-trips a Markdown-proxy vault: proxy note + untouched binary original', () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0xfe, 0x0a]); // %PDF + non-UTF8
    const zip = exportVaultZip({
      notes: [
        {
          path: 'notes/report.md',
          frontmatter: { source: 'sources/report.pdf', title: 'Q3' },
          body: 'extracted text'
        }
      ],
      originals: [{ path: 'sources/report.pdf', bytes: pdfBytes }]
    });
    const { notes, originals } = readVaultZip(zip);
    expect(notes.map((n) => n.path)).toEqual(['notes/report.md']);
    expect(notes[0].frontmatter.source).toBe('sources/report.pdf');
    expect(originals.map((o) => o.path)).toEqual(['sources/report.pdf']);
    expect(Array.from(originals[0].bytes)).toEqual(Array.from(pdfBytes)); // byte-for-byte
  });

  it('leaves chat transcripts out of the restored note tree', () => {
    const zip = exportVaultZip({
      notes: [{ path: 'notes/a.md', frontmatter: { title: 'A' }, body: 'hi' }],
      chats: [
        {
          id: 'sess-1',
          title: 'S',
          created: '2026-06-05T00:00:00Z',
          messages: [{ role: 'user', content: 'q' }]
        }
      ]
    });
    const { notes } = readVaultZip(zip);
    expect(notes.map((n) => n.path)).toEqual(['notes/a.md']);
  });

  it('reports DEFLATE-compressed entries as skipped instead of dropping them silently', () => {
    // Take a real store-only zip and flip its single entry's method to 8 (deflate) in both the local
    // and central headers — readVaultZip must not treat it as a note, and must surface it in `skipped`.
    const zip = exportVaultZip({
      notes: [{ path: 'notes/a.md', frontmatter: { title: 'A' }, body: 'hi' }]
    });
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocd = zip.length - 22;
    const centralOff = dv.getUint32(eocd + 16, true);
    const localOff = dv.getUint32(centralOff + 42, true);
    dv.setUint16(localOff + 8, 8, true); // local header: method
    dv.setUint16(centralOff + 10, 8, true); // central header: method
    const { notes, originals, skipped } = readVaultZip(zip);
    expect(notes).toEqual([]);
    expect(originals).toEqual([]);
    expect(skipped).toEqual(['notes/a.md']);
  });
});
