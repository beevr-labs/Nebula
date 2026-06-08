import { describe, it, expect } from 'vitest';
import { encode as encodeO200k } from 'gpt-tokenizer/encoding/o200k_base';
import { compile, tokenizerFor, type CompileInput } from '../../src/lib/context/compiler';

// FR-CTX-001..004 · ALGORITHMS §5 · TEST-CASES TC-CTX-002/003/005.

const baseInput: CompileInput = {
  targetModel: 'gpt-4o',
  sources: [
    {
      docId: 'doc-b',
      path: 'sources/contract-2026.pdf',
      hash: 'sha256:cd34',
      chunks: [
        { seq: 7, page: 5, text: 'Termination clause applies on 30 days notice.' },
        { seq: 2, page: 1, text: 'Parties: Acme & Beta.' }
      ]
    },
    {
      docId: 'doc-a',
      path: 'notes/project-x.md',
      hash: 'sha256:ab12',
      chunks: [{ seq: 3, page: 2, text: 'Project X ships in Q3.' }]
    }
  ]
};

describe('Context Compiler — TC-CTX-002 determinism', () => {
  it('produces byte-identical xml for identical inputs (body has no timestamp)', () => {
    const a = compile(baseInput, () => '2026-01-01T00:00:00.000Z');
    const b = compile(baseInput, () => '2099-12-31T23:59:59.999Z'); // different clock
    expect(a.xml).toBe(b.xml); // byte-identical body
    expect(a.manifest.generatedAt).not.toBe(b.manifest.generatedAt); // timestamp may differ
    expect(a.xml).not.toContain('2026-01-01'); // no timestamp leaked into body
  });

  it('orders sources by docId and chunks by seq', () => {
    const { xml } = compile(baseInput, () => 'x');
    // doc-a (project-x.md) must come before doc-b (contract).
    expect(xml.indexOf('project-x.md')).toBeLessThan(xml.indexOf('contract-2026.pdf'));
    // Within doc-b, seq 2 must come before seq 7.
    expect(xml.indexOf('seq="2"')).toBeLessThan(xml.indexOf('seq="7"'));
  });

  it('matches the canonical payload shape', () => {
    const { xml } = compile(baseInput, () => 'x');
    expect(xml.startsWith('<context generated_by="nebula" version="2.0">')).toBe(true);
    expect(xml).toContain('<source path="notes/project-x.md" hash="sha256:ab12">');
    expect(xml).toContain('<chunk seq="3" page="2">Project X ships in Q3.</chunk>');
    expect(xml.endsWith('</context>')).toBe(true);
  });

  it('de-duplicates chunks with the same seq', () => {
    const dup: CompileInput = {
      targetModel: 'gpt-4o',
      sources: [
        {
          docId: 'd',
          path: 'a.md',
          hash: 'sha256:00',
          chunks: [
            { seq: 1, text: 'first' },
            { seq: 1, text: 'duplicate-second' }
          ]
        }
      ]
    };
    const { xml } = compile(dup, () => 'x');
    expect(xml).toContain('>first<');
    expect(xml).not.toContain('duplicate-second');
  });

  it('omits the page attribute when page is undefined', () => {
    const noPage: CompileInput = {
      targetModel: 'gpt-4o',
      sources: [{ docId: 'd', path: 'a.md', hash: 'sha256:00', chunks: [{ seq: 1, text: 'x' }] }]
    };
    const { xml } = compile(noPage, () => 'x');
    expect(xml).toContain('<chunk seq="1">x</chunk>');
  });

  it('XML-escapes special characters in text and attributes', () => {
    const tricky: CompileInput = {
      targetModel: 'gpt-4o',
      sources: [
        {
          docId: 'd',
          path: 'a&b".md',
          hash: 'sha256:00',
          chunks: [{ seq: 1, text: '1 < 2 && "q"' }]
        }
      ]
    };
    const { xml } = compile(tricky, () => 'x');
    expect(xml).toContain('path="a&amp;b&quot;.md"');
    expect(xml).toContain('1 &lt; 2 &amp;&amp; "q"');
    expect(xml).not.toMatch(/text[^>]*1 < 2/);
  });
});

describe('Context Compiler — TC-CTX-003 token count accuracy', () => {
  it('counts with the target model tokenizer and names it', () => {
    const result = compile(baseInput, () => 'x');
    expect(result.manifest.tokenizer).toBe('o200k_base'); // gpt-4o
    const actual = encodeO200k(result.xml).length;
    expect(result.manifest.tokenCount).toBe(actual); // exact for a real tokenizer
    // ±5% requirement (FR-CTX-003) — trivially satisfied when exact.
    expect(Math.abs(result.manifest.tokenCount - actual) / actual).toBeLessThanOrEqual(0.05);
  });

  it('selects cl100k_base for Claude/unknown models', () => {
    expect(tokenizerFor('claude-sonnet')).toBe('cl100k_base');
    expect(tokenizerFor('some-future-model')).toBe('cl100k_base');
    expect(
      compile({ ...baseInput, targetModel: 'claude-sonnet' }, () => 'x').manifest.tokenizer
    ).toBe('cl100k_base');
  });
});

describe('Context Compiler — TC-CTX-005 redaction (neg-safety)', () => {
  it('removes redacted spans before serialization', () => {
    const result = compile(
      {
        targetModel: 'gpt-4o',
        sources: [
          {
            docId: 'd',
            path: 'a.md',
            hash: 'sha256:00',
            chunks: [{ seq: 1, text: 'Contact alice@example.com for details.' }]
          }
        ],
        redactions: [{ pattern: '[\\w.]+@[\\w.]+' }]
      },
      () => 'x'
    );
    expect(result.xml).not.toContain('alice@example.com');
    expect(result.xml).toContain('[REDACTED]');
  });
});

describe('manifest sources', () => {
  it('lists every source path + hash in deterministic order', () => {
    const { manifest } = compile(baseInput, () => 'x');
    expect(manifest.sources).toEqual([
      { path: 'notes/project-x.md', hash: 'sha256:ab12' },
      { path: 'sources/contract-2026.pdf', hash: 'sha256:cd34' }
    ]);
  });
});

describe('Context Compiler — CE2 task-aware payload (FR-CTX-009)', () => {
  it('is byte-identical to a task-less compile when no task is supplied', () => {
    const withoutTask = compile(baseInput, () => 'x').xml;
    const explicitlyNoTask = compile({ ...baseInput, task: undefined }, () => 'x').xml;
    expect(withoutTask).toBe(explicitlyNoTask);
    expect(withoutTask).not.toContain('<task>');
  });

  it('leads with the question + cite-by-path#seq directive when a task is supplied', () => {
    const { xml } = compile(
      { ...baseInput, task: { question: 'When does Project X ship?' } },
      () => 'x'
    );
    expect(xml).toContain('<task>');
    expect(xml).toContain('<question>When does Project X ship?</question>');
    expect(xml).toContain('[path#seq]'); // the directive tells the model how to cite
    // The task block precedes the sources (paste-and-go order).
    expect(xml.indexOf('<task>')).toBeLessThan(xml.indexOf('<source'));
  });

  it('still produces byte-identical output for identical task inputs (determinism preserved)', () => {
    const input = { ...baseInput, task: { question: 'Ship date?' } };
    expect(compile(input, () => 'a').xml).toBe(compile(input, () => 'b').xml);
  });

  it('escapes the question (no XML injection from user text)', () => {
    const { xml } = compile(
      { ...baseInput, task: { question: 'Why <urgent> & "risky"?' } },
      () => 'x'
    );
    expect(xml).toContain('Why &lt;urgent&gt; &amp; "risky"?');
    expect(xml).not.toContain('<urgent>');
  });
});

describe('Context Compiler — CE5 cost in the manifest (FR-CTX-011)', () => {
  it('reports context-window fit + estimated cost for the target model', () => {
    const { manifest } = compile(baseInput, () => 'x'); // gpt-4o
    expect(manifest.cost.known).toBe(true);
    expect(manifest.cost.contextWindow).toBe(128_000);
    expect(manifest.cost.fitsWindow).toBe(true);
    expect(manifest.cost.tokens).toBe(manifest.tokenCount);
    expect(manifest.cost.estInputCostUSD).toBeGreaterThanOrEqual(0);
  });
});
