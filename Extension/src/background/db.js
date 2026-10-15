/**
 * db.js — IndexedDB helpers
 * The single place that opens and talks to the "course-backup" database.
 * All other background modules import from here — nothing else opens IndexedDB.
 *
 * Stores:
 *   "scan"  — one course per numeric index, written during the handoff.
 *             Course objects are immutable after scrape — never mutated by the dashboard.
 *             File objects carry a stable fileId stamped by the scraper.
 *   "meta"  — a single "scan" key: { count, savedAt }
 *   "sizes" — file size cache: key = fileId → bytes (number) or null
 *             Written once per file during measuring. Cleared on fresh scrape.
 *             Download statuses are NOT stored here — they live in memory only.
 */

const DB_NAME = "course-backup";
const DB_VERSION = 5;

// First, open the database once and reuse the connection
let _db = null;
const openDb = () => {
   if (_db) return Promise.resolve(_db);
   return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => {
         const db = e.target.result;
         // Create required stores if missing
         if (!db.objectStoreNames.contains("scan")) db.createObjectStore("scan");
         if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
         if (!db.objectStoreNames.contains("sizes")) db.createObjectStore("sizes");
         // Drop legacy "backup" store if present from an older version
         if (db.objectStoreNames.contains("backup")) db.deleteObjectStore("backup");
      };
      request.onsuccess = () => { _db = request.result; resolve(_db); };
      request.onerror = () => reject(request.error);
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
      const tx = db.transaction(store, mode);
      const request = action(tx.objectStore(store));
      tx.oncomplete = () => resolve(request && request.result);
      tx.onerror = () => reject(tx.error);
   });
};

// Shorthand helpers used by other modules
export const dbGet = (store, key) => run(store, "readonly", (s) => s.get(key));
export const dbGetAll = (store) => run(store, "readonly", (s) => s.getAll());
export const dbPut = (store, key, value) => run(store, "readwrite", (s) => s.put(value, key));
export const dbDelete = (store, key) => run(store, "readwrite", (s) => s.delete(key));
export const dbClear = (store) => run(store, "readwrite", (s) => s.clear());
