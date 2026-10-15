/**
 * handoff.js — scan handoff
 * Receives the parsed courses one at a time from the Kajabi content script,
 * saves them into IndexedDB, and records the final count + timestamp.
 *
 * The handoff is a three-step sequence:
 *   handoff-start  → clear any previous scan + sizes cache
 *   handoff-course → save one course at its index
 *   handoff-end    → write the meta record so the dashboard knows the scan is complete
 *
 * Course objects written to the "scan" store are immutable after this point.
 * The dashboard never writes back to "scan" — it only reads from it.
 * File sizes are cached separately in the "sizes" store (keyed by fileId).
 * Download statuses live in memory only and are never persisted.
 */

import { dbClear, dbDelete, dbPut } from "./db.js";

/**
 * Clears the previous scan and size cache from IndexedDB so a fresh one can
 * be written. Called once at the start of every new scrape.
 */
export const startHandoff = async () => {
   // Remove all previously saved courses
   await dbClear("scan");
   // Remove the meta record so the dashboard does not show stale data
   await dbDelete("meta", "scan");
   // Clear the file size cache — sizes are tied to fileIds from the old scrape
   await dbClear("sizes");
   // Note: localStorage is not available in service workers.
   // Stale download statuses are detected and cleared by the dashboard on load
   // by comparing the scan's savedAt timestamp against the persisted value.
};

/**
 * Saves one parsed course at a given index.
 * @param {number} index  — 0-based position in the courses array
 * @param {object} course — parsed course object from scraper.js
 */
export const saveCourse = (index, course) => dbPut("scan", index, course);

/**
 * Writes the final meta record once all courses have been received.
 * @param {number} count — total number of courses saved
 */
export const endHandoff = (count) =>
   dbPut("meta", "scan", { count, savedAt: Date.now() });
