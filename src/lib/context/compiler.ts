// Context Compiler — surfaces "the relevant ~5%" as a deterministic, auditable payload.
// FR-CTX-001..004 · ALGORITHMS §5 · API-CONTRACTS §3.
//
// This module is the PURE, deterministic core (ALGORITHMS §7): given identical
// `sources` + `targetModel` + `redactions`, `xml` is byte-identical (FR-CTX-002).
// Resolving CompileRequest.items (note docId / searchHits / chatThread) into
// `CompileSource[]` is the DB-backed layer (T-030..) and is wired in slice 9's UI;
// it calls `compile()` below. Keeping the core pure is what makes TC-CTX-002/003
// runnable without a GPU or DB.

import { encode as encodeCl100k } from 'gpt-tokenizer/encoding/cl100k_base';
import { encode as encodeO200k } from 'gpt-tokenizer/encoding/o200k_base';
import { costReport, type CostReport } from './cost';

export interface CompileChunk {
  seq: number;
  page?: number;
  text: string;
}

/** One source file with its content hash and the chunks selected from it. */
export interface CompileSource {
  docId: string;
  path: string;
  hash: string; // content hash of the source file, e.g. 'sha256:ab12…'
  chunks: CompileChunk[];
}

export interface CompileTask {
  question: string; // the actual question to put in front of the cloud model
}

export interface CompileInput {
  sources: CompileSource[];
  targetModel: string; // selects the tokenizer (FR-CTX-003)
  redactions?: { pattern: string }[]; // FR-CTX-005 — applied BEFORE serialization
  task?: CompileTask; // FR-CTX-009 (CE2) — make the payload paste-and-go; omit → byte-identical to before
}

// CE2 directive: tells the cloud model to answer from the sources and cite by `path#seq`, which is the
// exact addressing Magic Jump round-trips back to vault locations (FR-CTX-010 / CE4). Versioned constant
// so the payload stays byte-identical for a fixed input.
export const CITE_DIRECTIVE =
  "Answer the question using ONLY the sources below. After each claim, cite the source it came from as [path#seq] — the source's path and the chunk's seq — e.g. [notes/budget.md#0]. Do not use outside knowledge.";

export interface CompileResult {
  xml: string;
  manifest: {
    sources: { path: string; hash: string }[];
    tokenCount: number; // via the target tokenizer, ±5% (FR-CTX-003)
    tokenizer: string; // named, e.g. 'cl100k_base'
    cost: CostReport; // CE5 (FR-CTX-011) — context-window fit + estimated input cost for the target model
    generatedAt: string; // ONLY non-deterministic field; never appears in `xml`
  };
}

// --- Tokenizer registry (ALGORITHMS §5) -------------------------------------
// Named so the manifest stays honest as models change. Claude has no public
// tokenizer, so cl100k_base is the documented closest approximation (±5%).
type EncodingName = 'o200k_base' | 'cl100k_base';

const TOKENIZER_BY_MODEL: Record<string, EncodingName> = {
  'gpt-4o': 'o200k_base',
  'gpt-4o-mini': 'o200k_base',
  'gpt-4': 'cl100k_base',
  'gpt-3.5': 'cl100k_base',
  'claude-sonnet': 'cl100k_base',
  'claude-opus': 'cl100k_base'
};

export function tokenizerFor(targetModel: string): EncodingName {
  return TOKENIZER_BY_MODEL[targetModel] ?? 'cl100k_base';
}

function countTokens(text: string, enc: EncodingName): number {
  return (enc === 'o200k_base' ? encodeO200k(text) : encodeCl100k(text)).length;
}

// --- XML escaping ------------------------------------------------------------
function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

// --- Redaction (FR-CTX-005) — applied before serialization -------------------
function applyRedactions(text: string, redactions?: { pattern: string }[]): string {
  if (!redactions?.length) return text;
  let out = text;
  for (const { pattern } of redactions) {
    out = out.replace(new RegExp(pattern, 'g'), '[REDACTED]');
  }
  return out;
}

/**
 * Compile selected sources into a deterministic `<context>` payload + manifest.
 * Determinism (FR-CTX-002): sources ordered by docId, chunks by seq; no timestamp
 * in the body. `now` is injectable so the manifest clock can't leak into `xml`.
 */
export function compile(
  input: CompileInput,
  now: () => string = () => new Date().toISOString()
): CompileResult {
  // 1. Normalize: merge sources sharing a docId, dedup chunks by seq (keep first),
  //    sort chunks by seq. Explicit items are always kept (ALGORITHMS §5 step 1).
  const byDoc = new Map<string, CompileSource>();
  for (const src of input.sources) {
    const existing = byDoc.get(src.docId);
    if (existing) {
      existing.chunks.push(...src.chunks);
    } else {
      byDoc.set(src.docId, { ...src, chunks: [...src.chunks] });
    }
  }

  const orderedSources = [...byDoc.values()]
    .sort((a, b) => (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0))
    .map((src) => {
      const seen = new Set<number>();
      const chunks = [...src.chunks]
        .sort((a, b) => a.seq - b.seq)
        .filter((c) => (seen.has(c.seq) ? false : (seen.add(c.seq), true)));
      return { ...src, chunks };
    });

  // 2. Serialize deterministically (2-space indent, fixed structure).
  const lines: string[] = ['<context generated_by="nebula" version="2.0">'];
  // CE2 (FR-CTX-009): when a task is supplied, lead with the question + the cite-by-path#seq directive
  // so the payload is paste-and-go. Emitted ONLY when present, so a task-less compile is byte-identical
  // to before (FR-CTX-002 — the existing determinism tests are unaffected).
  if (input.task) {
    lines.push('  <task>');
    lines.push(`    <question>${escapeText(input.task.question)}</question>`);
    lines.push(`    <directive>${escapeText(CITE_DIRECTIVE)}</directive>`);
    lines.push('  </task>');
  }
  for (const src of orderedSources) {
    lines.push(`  <source path="${escapeAttr(src.path)}" hash="${escapeAttr(src.hash)}">`);
    for (const chunk of src.chunks) {
      const text = escapeText(applyRedactions(chunk.text, input.redactions));
      const pageAttr = chunk.page === undefined ? '' : ` page="${chunk.page}"`;
      lines.push(`    <chunk seq="${chunk.seq}"${pageAttr}>${text}</chunk>`);
    }
    lines.push('  </source>');
  }
  lines.push('</context>');
  const xml = lines.join('\n');

  // 3. Token budget via the target model's named tokenizer (FR-CTX-003).
  const tokenizer = tokenizerFor(input.targetModel);
  const tokenCount = countTokens(xml, tokenizer);

  return {
    xml,
    manifest: {
      sources: orderedSources.map((s) => ({ path: s.path, hash: s.hash })),
      tokenCount,
      tokenizer,
      cost: costReport(tokenCount, input.targetModel),
      generatedAt: now()
    }
  };
}
