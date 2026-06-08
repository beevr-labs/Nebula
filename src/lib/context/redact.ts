// Trustworthy redaction (CE3, FR-CTX-005/012) · ALGORITHMS §5. Build redaction PATTERNS — by entity
// (all of its aliases, optionally its connected people/projects) and by PII type — that the compiler
// applies BEFORE serialization (so redacted text never reaches the clipboard), compute an EXACT preview
// of what will be removed, and produce a content-free AUDIT record for the export log. All pure: the
// preview uses the same 'g' regex the compiler uses, so "what you see is exactly what gets removed".

/** A redaction pattern + a human label (the label drives the preview/audit; never the removed content). */
export interface Redaction {
  pattern: string; // regex source, fed to `new RegExp(pattern, 'g')` — same as the compiler
  label: string; // e.g. "entity: Acme" or "pii: email"
}

/** Escape a literal string for safe use inside a RegExp. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface RedactableEntity {
  name: string;
  aliases?: string[];
}

/**
 * Redactions for one entity: every distinct alias (and its display name), matched as a whole word
 * where the boundaries make sense. Optionally also redact its CONNECTED entities (people/projects from
 * the graph) — "scrub this client and everyone attached to it". Deterministic: aliases are sorted and
 * deduped, longest first (so "Acme Corp" is tried before "Acme").
 */
export function redactionsForEntity(
  entity: RedactableEntity,
  connected: RedactableEntity[] = []
): Redaction[] {
  const out: Redaction[] = [];
  const add = (e: RedactableEntity, kind: 'entity' | 'connected') => {
    const forms = [...new Set([e.name, ...(e.aliases ?? [])].map((s) => s.trim()).filter(Boolean))];
    forms.sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
    for (const f of forms) {
      out.push({ pattern: `\\b${escapeRegex(f)}\\b`, label: `${kind}: ${e.name}` });
    }
  };
  add(entity, 'entity');
  for (const c of connected) add(c, 'connected');
  return out;
}

export type PiiType = 'email' | 'phone' | 'ssn' | 'credit_card' | 'ip';

// Approximate but useful PII matchers (a preview-before-copy guard, not a compliance scanner).
export const PII_PATTERNS: Record<PiiType, string> = {
  email: '[\\w.+-]+@[\\w-]+\\.[\\w.-]+',
  phone: '\\+?\\d[\\d\\s().-]{7,}\\d',
  ssn: '\\b\\d{3}-\\d{2}-\\d{4}\\b',
  credit_card: '\\b(?:\\d[ -]?){13,16}\\b',
  ip: '\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b'
};

/** Redactions for the chosen PII types. Deterministic order (the PiiType list as given). */
export function piiRedactions(types: PiiType[]): Redaction[] {
  return types.map((t) => ({ pattern: PII_PATTERNS[t], label: `pii: ${t}` }));
}

export interface PreviewEntry {
  label: string;
  pattern: string;
  matches: string[]; // the DISTINCT strings that will be replaced — the exact preview
  count: number; // total occurrences across all source text
}

/**
 * Exactly what each redaction will remove from the given source texts — distinct matched strings +
 * total occurrence count — using the SAME global regex the compiler applies. This is the "see before
 * you copy" guarantee: the preview and the actual removal can't disagree. Pure.
 */
export function redactionPreview(texts: string[], redactions: Redaction[]): PreviewEntry[] {
  const joined = texts.join('\n');
  return redactions.map((r) => {
    const re = new RegExp(r.pattern, 'g');
    const seen = new Set<string>();
    let count = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(joined)) !== null) {
      count++;
      seen.add(m[0]);
      if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width matches
    }
    return { label: r.label, pattern: r.pattern, matches: [...seen].sort(), count };
  });
}

/** Per-label removal counts — for the audit. NO content, only labels + counts (the trust guarantee). */
export interface RedactionSummaryEntry {
  label: string;
  count: number;
}

export function redactionSummary(preview: PreviewEntry[]): RedactionSummaryEntry[] {
  const byLabel = new Map<string, number>();
  for (const p of preview) byLabel.set(p.label, (byLabel.get(p.label) ?? 0) + p.count);
  return [...byLabel.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([label, count]) => ({ label, count })); // prettier-ignore
}

/** The compiler wants `{pattern}[]`; the labels are only for preview/audit. */
export function toCompilerRedactions(redactions: Redaction[]): { pattern: string }[] {
  return redactions.map((r) => ({ pattern: r.pattern }));
}

export interface AuditRecord {
  exportedAt: string; // the ONLY non-deterministic field (injected)
  targetModel: string;
  tokenCount: number;
  sources: { path: string; hash: string }[]; // hashes ONLY — never content (NFR-SEC-004)
  redactionSummary: RedactionSummaryEntry[];
}

/**
 * Build the export audit record (FR-CTX-004/012, NFR-SEC-004): source hashes (never content) + token
 * count + target model + a redaction summary (labels + counts, no removed text). `exportedAt` is the
 * only clock-dependent field, injected so the rest is deterministic and the record is reproducible.
 */
export function buildAuditRecord(input: {
  sources: { path: string; hash: string }[];
  tokenCount: number;
  targetModel: string;
  redactionSummary: RedactionSummaryEntry[];
  exportedAt: string;
}): AuditRecord {
  return {
    exportedAt: input.exportedAt,
    targetModel: input.targetModel,
    tokenCount: input.tokenCount,
    sources: input.sources.map((s) => ({ path: s.path, hash: s.hash })),
    redactionSummary: input.redactionSummary
  };
}
