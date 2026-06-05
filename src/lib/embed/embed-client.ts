// Main-thread client for the embedding Worker (ADR-023). Wraps postMessage in promises and routes
// `progress` callbacks, so callers `await client.indexText(...)` while the heavy work runs off-thread.

import type { EmbeddedChunk } from './embed.worker';

export interface EmbedClient {
  embedQuery: (text: string) => Promise<number[]>;
  indexText: (
    text: string,
    opts: { size: number; overlap: number },
    onProgress?: (done: number, total: number) => void
  ) => Promise<EmbeddedChunk[]>;
  terminate: () => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (done: number, total: number) => void;
}

/** Create the Worker + a promise-based client. One worker handles all embed/index requests serially. */
export function createEmbedClient(): EmbedClient {
  const worker = new Worker(new URL('./embed.worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, Pending>();
  let nextId = 1;

  worker.onmessage = (e: MessageEvent) => {
    const { id, ok, result, error, progress } = e.data;
    const p = pending.get(id);
    if (!p) return;
    if (progress) {
      p.onProgress?.(progress.done, progress.total);
      return;
    }
    pending.delete(id);
    if (ok) p.resolve(result);
    else p.reject(new Error(error));
  };

  function call<T>(
    type: string,
    payload: unknown,
    onProgress?: (done: number, total: number) => void
  ): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      worker.postMessage({ id, type, payload });
    });
  }

  return {
    embedQuery: (text) => call<number[]>('embedQuery', { text }),
    indexText: (text, opts, onProgress) =>
      call<EmbeddedChunk[]>(
        'indexText',
        { text, size: opts.size, overlap: opts.overlap },
        onProgress
      ),
    terminate: () => worker.terminate()
  };
}
