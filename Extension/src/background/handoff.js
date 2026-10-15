/**
 * handoff.js — scan handoff
 * Receives the parsed courses one at a time from the Kajabi content script,
 * saves them into IndexedDB, and records the final count + timestamp.
 *
 * The handoff is a three-step sequence:
 *   handoff-start  → clear any previous scan
 *   handoff-course → save one course at its index
 *   handoff-end    → write the meta record so the dashboard knows the scan is complete
 */

import { dbClear, dbDelete, dbPut } from "./db.js";

/**
 * Clears the previous scan from IndexedDB so a fresh one can be written.
 * Called once at the start of every new scrape.
 */
export const startHandoff = async () => {
   // First, remove all previously saved courses
   await dbClear("scan");
   // Then, remove the meta record so the dashboard does not show stale data
   await dbDelete("meta", "scan");
   // Finally, clear the file size cache so stale sizes don't show for new content
   await dbClear("sizes");
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
