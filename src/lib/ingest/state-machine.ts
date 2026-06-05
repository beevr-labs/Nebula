// Resumable ingestion state machine (FR-ING-007/008) — DATA-MODEL §5.
// Each transition is committed (persisted) BEFORE the next begins, so a crash leaves
// the document at a known-good prior state and resume re-runs from there without
// re-doing completed stages (no duplicate chunks — chunks keyed by (document, seq)).

export type IngestState =
  | 'queued'
  | 'parsing'
  | 'chunked'
  | 'embedding'
  | 'indexing'
  | 'tagging'
  | 'indexed'
  | 'failed';

/** The happy-path order (DATA-MODEL §5). `failed` is reachable from any active stage. */
export const INGEST_ORDER: IngestState[] = [
  'queued',
  'parsing',
  'chunked',
  'embedding',
  'indexing',
  'tagging',
  'indexed'
];

export function isTerminal(s: IngestState): boolean {
  return s === 'indexed';
}

export function isResumable(s: IngestState): boolean {
  return s !== 'indexed'; // anything not fully indexed resumes (failed → via retry)
}

/** The next happy-path state. Throws if there is none (terminal/failed). */
export function nextState(s: IngestState): IngestState {
  const i = INGEST_ORDER.indexOf(s);
  if (i === -1 || i === INGEST_ORDER.length - 1) {
    throw new Error(`No successor state for '${s}'`);
  }
  return INGEST_ORDER[i + 1];
}

export interface IngestDoc {
  id: string;
  state: IngestState;
  failedReason?: string;
}

export type StageRunner = (doc: IngestDoc) => void | Promise<void>;

export interface RunOptions {
  /** Work to LEAVE a given state (e.g. parse, chunk, embed, upsert). Missing = no-op. */
  stages: Partial<Record<IngestState, StageRunner>>;
  /** Commit the document state after each transition (resume relies on this). */
  persist: (doc: IngestDoc) => void | Promise<void>;
  /** Delete partial chunks before a retry / after a failure (DATA-MODEL §5 cleanup). */
  cleanupPartial?: (doc: IngestDoc) => void | Promise<void>;
}

/**
 * Drive a document from its current state to `indexed`, persisting after each step.
 * Resumes from `doc.state` (already-completed stages are skipped → no duplicate work).
 * If a stage throws, the document is marked `failed` with the reason and partial chunks
 * are cleaned up (FR-ING-008). Returns the final document.
 */
export async function runIngestion(doc: IngestDoc, opts: RunOptions): Promise<IngestDoc> {
  let current: IngestDoc = { ...doc };

  while (!isTerminal(current.state) && current.state !== 'failed') {
    const stage = opts.stages[current.state];
    try {
      if (stage) await stage(current);
      current = { ...current, state: nextState(current.state) };
      await opts.persist(current);
    } catch (err) {
      current = {
        ...current,
        state: 'failed',
        failedReason: err instanceof Error ? err.message : String(err)
      };
      await opts.cleanupPartial?.(current);
      await opts.persist(current);
      break;
    }
  }

  return current;
}

/** User retry of a failed document: clean partial chunks, then requeue (DATA-MODEL §5). */
export async function retryFailed(
  doc: IngestDoc,
  cleanupPartial?: (doc: IngestDoc) => void | Promise<void>
): Promise<IngestDoc> {
  if (doc.state !== 'failed') return doc;
  await cleanupPartial?.(doc);
  return { id: doc.id, state: 'queued' };
}
