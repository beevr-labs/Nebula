// Durable store for proxy-note SOURCE binaries (ADR-027) — the untouched original PDF/CSV/… that a
// Markdown Proxy Note links back to (FR-ING-012) and that Export Vault packs under `sources/`
// (FR-DATA-006). These bytes can't live in the SurrealDB note table (binaries bloat it and serialize
// poorly), and an in-memory array is lost on refresh — so Export would hand back a proxy with no
// original. IndexedDB stores typed arrays natively, so this thin wrapper (no dependency) keeps them.
//
// Browser-only (IndexedDB); the app imports it dynamically in onMount. Not exercised by the Node
// test suites for the same reason the embed Worker isn't — it's a thin IO seam over a browser API.

const DB_NAME = 'nebula-sources';
const STORE = 'sources';

interface SourceRow {
  path: string;
  bytes: Uint8Array;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  return (dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'path' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

/** Persist (or overwrite) a source binary keyed by its vault path (e.g. `sources/report.pdf`). */
export async function putSource(path: string, bytes: Uint8Array): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ path, bytes } satisfies SourceRow);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** All persisted source binaries, for rehydrating Export on startup. */
export async function allSources(): Promise<SourceRow[]> {
  const db = await openDb();
  return new Promise<SourceRow[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () =>
      resolve((req.result as SourceRow[]).map((r) => ({ path: r.path, bytes: r.bytes })));
    req.onerror = () => reject(req.error);
  });
}

/** Forget a source binary (e.g. when its proxy note is deleted). */
export async function deleteSource(path: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(path);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
