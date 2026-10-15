/**
 * db.js — IndexedDB helpers
 * The single place that opens and talks to the "course-backup" database.
 * All other background modules import from here — nothing else opens IndexedDB.
 *
 * Stores:
 *   "scan"  — one course per numeric index, written during the handoff
 *   "meta"  — a single "scan" key: { count, savedAt }
 *   "sizes" — file-size cache: key (URL without query string) → bytes
 */

const DB_NAME    = "course-backup";
const DB_VERSION = 2;

// First, open the database once and reuse the connection
let _db = null;
const openDb = () => {
   if (_db) return Promise.resolve(_db);
   return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
         // Create any missing stores — safe to call on an existing database
         ["sizes", "scan", "meta"].forEach((name) => {
            if (!request.result.objectStoreNames.contains(name)) {
               request.result.createObjectStore(name);
            }
         });
      };
      request.onsuccess = () => { _db = request.result; resolve(_db); };
      request.onerror   = () => reject(request.error);
   });
};

/**
 * Runs one IndexedDB action inside a transaction and resolves with the result.
 * @param {string}   store  — store name
 * @param {string}   mode   — "readonly" | "readwrite"
 * @param {function} action — receives the IDBObjectStore, returns an IDBRequest
 */
export const run = async (store, mode, action) => {
   const db = await openDb();
   return new Promise((resolve, reject) => {
      const tx      = db.transaction(store, mode);
      const request = action(tx.objectStore(store));
      tx.oncomplete = () => resolve(request && request.result);
      tx.onerror    = () => reject(tx.error);
   });
};

// Shorthand helpers used by other modules
export const dbGet = (store, key)        => run(store, "readonly",  (s) => s.get(key));
export const dbGetAll = (store)          => run(store, "readonly",  (s) => s.getAll());
export const dbPut = (store, key, value) => run(store, "readwrite", (s) => s.put(value, key));
export const dbDelete = (store, key)     => run(store, "readwrite", (s) => s.delete(key));
export const dbClear = (store)           => run(store, "readwrite", (s) => s.clear());
