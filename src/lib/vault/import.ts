// Vault import — the inverse of export.ts (FR-DATA-006): read a Nebula `.zip` back into notes +
// original binaries so a user can RESTORE a backup, not just produce one. Without this, Export Vault
// is a one-way door — a user who clears their browser, switches machines, or loses their store has a
// `.zip` they cannot get back into the app. This closes that loop.
//
// Pure & deterministic (mirrors export.ts §8): no network/DB/GPU, no clock. The caller (the browser)
// wires the file read and the actual DB writes. Parses the store-only (method 0) archives export.ts
// emits; entries compressed with DEFLATE (method 8 — e.g. a vault re-zipped by Finder/7-Zip) are
// reported in `skipped` rather than silently dropped, so the user is never told "restored" when part
// of the archive was left out. Re-exporting from Nebula always yields a fully restorable store-only zip.

import { parseNote } from '$lib/vault/note';

/** One raw entry read out of a ZIP central directory. `data` is the stored bytes (for method 0 this
 *  IS the file content; for method 8 it is still DEFLATE-compressed and must be inflated by a caller). */
export interface ZipEntry {
  path: string;
  /** Compression method: 0 = store (uncompressed), 8 = deflate. */
  method: number;
  data: Uint8Array;
}

export interface ImportedNote {
  /** Vault-relative path = docId, e.g. `notes/apollo.md`. */
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface ImportedOriginal {
  /** e.g. `sources/contract.pdf` — the untouched original binary. */
  path: string;
  bytes: Uint8Array;
}

export interface ImportedVault {
  notes: ImportedNote[];
  originals: ImportedOriginal[];
  /** Paths skipped because they were DEFLATE-compressed (not produced by Nebula's own export). */
  skipped: string[];
}

const SIG_EOCD = 0x06054b50; // end of central directory
const SIG_CENTRAL = 0x02014b50; // central directory file header
const SIG_LOCAL = 0x04034b50; // local file header

/**
 * Parse a ZIP archive into its entries by walking the central directory (the authoritative index —
 * robust to the exact local-header layout). Throws on a malformed/non-ZIP buffer so the caller can
 * tell the user "that isn't a Nebula vault zip" instead of importing garbage.
 */
export function parseZip(bytes: Uint8Array): ZipEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Find the EOCD record. It's the last 22 bytes when there's no archive comment (Nebula writes none),
  // but scan back up to 64 KB + 22 to tolerate a comment from another tool. Search from the end.
  let eocd = -1;
  const minPos = Math.max(0, bytes.length - (0xffff + 22));
  for (let p = bytes.length - 22; p >= minPos; p--) {
    if (dv.getUint32(p, true) === SIG_EOCD) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)');

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true); // offset of the first central-directory header

  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== SIG_CENTRAL) {
      throw new Error('corrupt ZIP (bad central directory header)');
    }
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const path = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen));

    // Resolve the data: the local header repeats name + extra (their lengths can differ from the
    // central copy), so read THEM to find where the payload actually starts.
    if (dv.getUint32(localOffset, true) !== SIG_LOCAL) {
      throw new Error(`corrupt ZIP (bad local header for ${path})`);
    }
    const lNameLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = bytes.slice(dataStart, dataStart + compSize); // copy, so we don't retain the whole zip

    entries.push({ path, method, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** A `.md` / `.markdown` path (the vault's source-of-truth notes). */
function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/**
 * Resolve a parsed ZIP into a restorable vault: `.md` files become notes (frontmatter + body), every
 * other file is treated as an original binary (kept under `sources/`). Chat transcripts under `chats/`
 * are left out — they are not vault notes and re-importing them would pollute the note tree. Mirrors
 * what export.ts emits (notes at their docId path + originals under sources/), so an export→import
 * round-trips. DEFLATE-compressed entries are collected in `skipped` (see module header).
 */
export function readVaultZip(bytes: Uint8Array): ImportedVault {
  const notes: ImportedNote[] = [];
  const originals: ImportedOriginal[] = [];
  const skipped: string[] = [];

  for (const entry of parseZip(bytes)) {
    if (entry.path.endsWith('/')) continue; // directory entry, no payload
    if (entry.method !== 0) {
      skipped.push(entry.path);
      continue;
    }
    if (isMarkdown(entry.path)) {
      if (entry.path.startsWith('chats/')) continue; // transcripts aren't vault notes
      const parsed = parseNote(new TextDecoder('utf-8').decode(entry.data));
      notes.push({ path: entry.path, frontmatter: parsed.frontmatter, body: parsed.body });
    } else {
      originals.push({ path: entry.path, bytes: entry.data });
    }
  }
  return { notes, originals, skipped };
}
