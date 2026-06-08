// Vault export — the "Eject Button" (FR-DATA-006) + non-destructive guarantee (FR-ING-011).
// OBSIDIAN-DNA §5.1 ("Text-First Mandate"): the SurrealDB/OPFS index is a derived cache;
// the source of truth is portable Markdown. This module resolves all DB content (notes,
// PDF-extraction sidecars, chat histories) back into a standard folder hierarchy of `.md`
// files with valid YAML frontmatter, and packs them into a dependency-free, store-only
// ZIP — a valid PKZIP archive any tool (Obsidian, Logseq, Finder) can open. This is what
// guarantees 100% migration compatibility (NFR-PORT-001).
//
// Pure & deterministic (ALGORITHMS §8): no network/DB/GPU, no clock — identical input
// yields byte-identical output. The DB rows are passed in; the caller (the browser/PWA)
// wires the actual read and the browser download (Blob → <a download>). buildVaultExport
// never mutates its inputs — the originals (incl. imported PDFs) are never touched.

import { serializeNote } from '$lib/vault/note';

export interface ExportNote {
  /** Vault-relative path, e.g. `notes/apollo.md`. */
  path: string;
  frontmatter?: Record<string, unknown>;
  body: string;
}

export interface ExportSource {
  /** e.g. `sources/contract.md` — the EXTRACTED text, not the original binary. */
  path: string;
  frontmatter?: Record<string, unknown>;
  text: string;
}

export interface ExportOriginal {
  /** e.g. `sources/contract.pdf` — the untouched ORIGINAL binary (FR-ING-011). */
  path: string;
  bytes: Uint8Array;
}

export interface ExportChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ExportChat {
  id: string;
  title?: string;
  created?: string; // ISO; passed in (no clock here) so output stays deterministic
  messages: ExportChatMessage[];
}

export interface VaultExportInput {
  notes?: ExportNote[];
  sources?: ExportSource[];
  originals?: ExportOriginal[]; // original binaries (PDF/CSV…) preserved under sources/
  chats?: ExportChat[];
}

export interface VaultExportEntry {
  path: string;
  content: string | Uint8Array; // text for .md, raw bytes for original binaries
}

/** Render a chat transcript to a portable Markdown file with frontmatter. */
function renderChat(chat: ExportChat): string {
  const fm: Record<string, unknown> = { type: 'chat', id: chat.id };
  if (chat.title) fm.title = chat.title;
  if (chat.created) fm.created = chat.created;
  const body = chat.messages.map((m) => `**${m.role}:**\n\n${m.content}`).join('\n\n---\n\n');
  return serializeNote({ frontmatter: fm, body });
}

/**
 * Resolve all DB content into an ordered list of export entries (FR-DATA-006). Logical
 * hierarchy: `notes/` (incl. Markdown proxy notes), `sources/` (original binaries +/or
 * extracted text), `chats/`. Entries are sorted by path so the archive is deterministic.
 * Inputs are read-only (FR-ING-011).
 */
export function buildVaultExport(input: VaultExportInput): VaultExportEntry[] {
  const entries: VaultExportEntry[] = [];

  for (const note of input.notes ?? []) {
    entries.push({
      path: note.path,
      content: serializeNote({ frontmatter: { ...note.frontmatter }, body: note.body })
    });
  }

  for (const src of input.sources ?? []) {
    entries.push({
      path: src.path,
      content: serializeNote({ frontmatter: { ...src.frontmatter }, body: src.text })
    });
  }

  // Original binaries (the untouched PDFs/CSVs the proxy notes link back to, FR-ING-011).
  for (const orig of input.originals ?? []) {
    entries.push({ path: orig.path, content: orig.bytes });
  }

  for (const chat of input.chats ?? []) {
    entries.push({ path: `chats/${chat.id}.md`, content: renderChat(chat) });
  }

  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ──────────────────────────── store-only ZIP writer ────────────────────────────
// Compression method 0 (STORE). A valid PKZIP archive without a deflate dependency,
// keeping DEPENDENCIES.lock pinned (ADR-009). Deterministic: a fixed DOS timestamp
// (1980-01-01) and UTF-8 filename flag, so the same entries always emit the same bytes.

const DOS_TIME = 0;
const DOS_DATE = 0x21; // 1980-01-01 00:00:00

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard CRC-32 (poly 0xEDB88320). Check value: crc32("123456789") === 0xCBF43926. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Pack entries into a store-only ZIP (FR-DATA-006). Returns the raw archive bytes; the
 * caller wraps them in a Blob and triggers the download. Standard format → opens in any
 * unzip tool and round-trips cleanly into Obsidian.
 */
export function toZip(entries: VaultExportEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  let centralSize = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.path);
    const dataBytes = typeof entry.content === 'string' ? enc.encode(entry.content) : entry.content;
    const crc = crc32(dataBytes);
    const size = dataBytes.length;
    const localOffset = offset;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed (2.0)
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 filename
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);

    chunks.push(local, dataBytes);
    offset += local.length + dataBytes.length;

    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory header signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true); // flags: UTF-8 filename
    cv.setUint16(10, 0, true); // method: store
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, localOffset, true);
    cen.set(nameBytes, 46);
    central.push(cen);
    centralSize += cen.length;
  }

  const centralOffset = offset;
  for (const c of central) chunks.push(c);

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory signature
  ev.setUint16(4, 0, true); // this disk
  ev.setUint16(6, 0, true); // disk with central dir
  ev.setUint16(8, entries.length, true); // entries on this disk
  ev.setUint16(10, entries.length, true); // total entries
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, 0, true); // comment length
  chunks.push(eocd);

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/** Convenience: resolve DB content → store-only ZIP bytes in one call (FR-DATA-006). */
export function exportVaultZip(input: VaultExportInput): Uint8Array {
  return toZip(buildVaultExport(input));
}
