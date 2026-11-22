/**
 * Where the refresh token lives: IndexedDB in the extension's own origin. Content scripts run in the web page's origin,
 * so unlike storage.local (which they can read and write) a compromised AWS console page can neither read the token
 * nor plant one of its own. Falls back to memory where IndexedDB isn't available (tests, or a browser that refuses it):
 * the player then signs in again after a restart.
 */
const DB_NAME = 'aws-city-auth';
const STORE = 'secrets';

let memory = new Map<string, string>();
let opening: Promise<IDBDatabase | undefined> | undefined;

const open = () =>
  (opening ??= new Promise<IDBDatabase | undefined>((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(undefined);
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
      req.onblocked = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  }));

const run = <T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

/** Runs on IndexedDB, or on memory if it's missing or fails: signing in must never break because of storage. */
const withDb = async <T>(onDb: (db: IDBDatabase) => Promise<T>, onMemory: () => T): Promise<T> => {
  const db = await open();
  if (!db) return onMemory();
  try {
    return await onDb(db);
  } catch {
    return onMemory();
  }
};

export const vault = {
  async get(key: string): Promise<string | undefined> {
    const value = await withDb<unknown>((db) => run(db, 'readonly', (s) => s.get(key)), () => undefined);
    return typeof value === 'string' ? value : memory.get(key);
  },
  async set(key: string, value: string): Promise<void> {
    memory.set(key, value);
    await withDb(
      (db) => run(db, 'readwrite', (s) => s.put(value, key)).then(() => void memory.delete(key)),
      () => undefined,
    );
  },
  async remove(key: string): Promise<void> {
    memory.delete(key);
    await withDb(
      (db) => run(db, 'readwrite', (s) => s.delete(key)).then(() => undefined),
      () => undefined,
    );
  },
};

/** Tests: start from an empty vault. */
export const resetVault = () => {
  memory = new Map();
};
