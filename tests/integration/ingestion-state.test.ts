import { describe, it, expect } from 'vitest';
import {
  runIngestion,
  retryFailed,
  nextState,
  isResumable,
  type IngestDoc,
  type IngestState,
  type RunOptions
} from '../../src/lib/ingest/state-machine';

// FR-ING-007/008 · TC-ING-007 (resume, no duplicates) + TC-ING-008 (failure surfaced).

function recordingOpts(throwAt?: IngestState) {
  const visited: IngestState[] = [];
  const persisted: IngestState[] = [];
  let cleaned = 0;
  const stages: RunOptions['stages'] = {};
  for (const s of [
    'queued',
    'parsing',
    'chunked',
    'embedding',
    'indexing',
    'tagging'
  ] as IngestState[]) {
    stages[s] = (doc) => {
      visited.push(doc.state);
      if (doc.state === throwAt) throw new Error(`boom at ${doc.state}`);
    };
  }
  const opts: RunOptions = {
    stages,
    persist: (doc) => {
      persisted.push(doc.state);
    },
    cleanupPartial: () => {
      cleaned += 1;
    }
  };
  return {
    opts,
    visited,
    persisted,
    get cleaned() {
      return cleaned;
    }
  };
}

describe('nextState / isResumable', () => {
  it('walks the happy path and flags non-indexed as resumable', () => {
    expect(nextState('queued')).toBe('parsing');
    expect(nextState('tagging')).toBe('indexed');
    expect(() => nextState('indexed')).toThrow();
    expect(isResumable('embedding')).toBe(true);
    expect(isResumable('indexed')).toBe(false);
  });
});

describe('TC-ING-007 — full run + resume without re-doing stages', () => {
  it('runs every stage once from queued and ends indexed', async () => {
    const { opts, visited } = recordingOpts();
    const result = await runIngestion({ id: 'd1', state: 'queued' }, opts);
    expect(result.state).toBe('indexed');
    expect(visited).toEqual(['queued', 'parsing', 'chunked', 'embedding', 'indexing', 'tagging']);
  });

  it('resumes from embedding and never re-parses/re-chunks (no duplicate chunks)', async () => {
    const { opts, visited } = recordingOpts();
    const resumed: IngestDoc = { id: 'd1', state: 'embedding' }; // crashed after chunking
    const result = await runIngestion(resumed, opts);
    expect(result.state).toBe('indexed');
    expect(visited).toEqual(['embedding', 'indexing', 'tagging']); // parsing/chunked skipped
  });
});

describe('TC-ING-008 — failure is surfaced, partials cleaned', () => {
  it('marks the document failed with a specific reason on a stage error (e.g. OOM at embedding)', async () => {
    const rec = recordingOpts('embedding');
    const result = await runIngestion({ id: 'd2', state: 'queued' }, rec.opts);
    expect(result.state).toBe('failed');
    expect(result.failedReason).toMatch(/boom at embedding/);
    expect(rec.cleaned).toBe(1);
    expect(rec.persisted.at(-1)).toBe('failed'); // failed state committed
  });

  it('retry cleans partials and requeues', async () => {
    let cleaned = 0;
    const requeued = await retryFailed({ id: 'd2', state: 'failed', failedReason: 'x' }, () => {
      cleaned += 1;
    });
    expect(requeued.state).toBe('queued');
    expect(cleaned).toBe(1);
  });
});
