import { describe, it, expect } from 'vitest';
import {
  redactionsForEntity,
  piiRedactions,
  redactionPreview,
  redactionSummary,
  buildAuditRecord,
  toCompilerRedactions,
  escapeRegex
} from '../../src/lib/context/redact';
import { compile } from '../../src/lib/context/compiler';

// CE3 — trustworthy redaction (FR-CTX-005/012 · ALGORITHMS §5). Pure pattern building + exact preview
// + content-free audit. The preview must equal what the compiler actually removes.

describe('redactionsForEntity', () => {
  it('redacts every alias, longest first, and optionally connected entities', () => {
    const reds = redactionsForEntity({ name: 'Acme', aliases: ['Acme', 'Acme Corp', 'ACME'] }, [
      { name: 'Jane Doe' }
    ]);
    const labels = reds.map((r) => r.label);
    expect(labels).toContain('entity: Acme');
    expect(labels).toContain('connected: Jane Doe');
    // "Acme Corp" (longer) appears before bare "Acme" so the greedy match scrubs the full form.
    const patterns = reds.map((r) => r.pattern);
    expect(patterns.indexOf('\\bAcme Corp\\b')).toBeLessThan(patterns.indexOf('\\bAcme\\b'));
  });
});

describe('piiRedactions + escapeRegex', () => {
  it('builds PII matchers for the chosen types', () => {
    expect(piiRedactions(['email', 'ssn']).map((r) => r.label)).toEqual(['pii: email', 'pii: ssn']);
  });
  it('escapes regex metacharacters in literals', () => {
    expect(escapeRegex('a.b+c')).toBe('a\\.b\\+c');
  });
});

describe('redactionPreview — exact, matches what the compiler removes', () => {
  const texts = [
    'Acme Corp hired Jane Doe. Reach jane@acme.com or 555-12-3456 about it.',
    'Acme is great. Jane Doe leads it.'
  ];
  const reds = [
    ...redactionsForEntity({ name: 'Acme', aliases: ['Acme', 'Acme Corp'] }, [
      { name: 'Jane Doe' }
    ]),
    ...piiRedactions(['email', 'ssn'])
  ];

  it('previews the distinct strings + counts that will be removed', () => {
    const preview = redactionPreview(texts, reds);
    const email = preview.find((p) => p.label === 'pii: email')!;
    expect(email.matches).toEqual(['jane@acme.com']);
    expect(email.count).toBe(1);
    const jane = preview.filter((p) => p.label === 'connected: Jane Doe');
    expect(jane.reduce((s, p) => s + p.count, 0)).toBe(2); // appears in both notes
  });

  it('the preview equals the actual removal (no content survives that the preview hid)', () => {
    const { xml } = compile(
      {
        targetModel: 'gpt-4o',
        sources: [{ docId: 'n', path: 'n.md', hash: 'sha256:1', chunks: texts.map((t, i) => ({ seq: i, text: t })) }], // prettier-ignore
        redactions: toCompilerRedactions(reds)
      },
      () => 'x'
    );
    // Everything the preview said it would remove is gone from the payload.
    for (const p of redactionPreview(texts, reds)) {
      for (const match of p.matches) expect(xml).not.toContain(match);
    }
    expect(xml).toContain('[REDACTED]');
  });
});

describe('audit record — hashes + counts only, never content', () => {
  it('contains hashes, token count, target model, and a content-free redaction summary', () => {
    const texts = ['Acme hired Jane Doe at jane@acme.com.'];
    const reds = [...redactionsForEntity({ name: 'Acme' }), ...piiRedactions(['email'])];
    const summary = redactionSummary(redactionPreview(texts, reds));
    const audit = buildAuditRecord({
      sources: [{ path: 'n.md', hash: 'sha256:abc' }],
      tokenCount: 42,
      targetModel: 'claude-3-5-sonnet',
      redactionSummary: summary,
      exportedAt: '2026-06-09T00:00:00.000Z'
    });
    expect(audit.sources).toEqual([{ path: 'n.md', hash: 'sha256:abc' }]);
    expect(audit.tokenCount).toBe(42);
    expect(audit.targetModel).toBe('claude-3-5-sonnet');
    expect(audit.redactionSummary).toEqual([
      { label: 'entity: Acme', count: 1 },
      { label: 'pii: email', count: 1 }
    ]);
    // The audit JSON must not leak the actual redacted content.
    const blob = JSON.stringify(audit);
    expect(blob).not.toContain('jane@acme.com');
    expect(blob).not.toContain('Jane Doe');
  });
});
