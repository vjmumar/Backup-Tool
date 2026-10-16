/**
 * api/maintenance.js — Maintenance API
 *
 * Checks whether the server is in maintenance mode.
 * No authentication required — this must be checkable before sign-in.
 *
 * When isMaintenance is true, scraping and adding new platform connections
 * are blocked. Existing backups are unaffected since the scraper script
 * is not fetched during a backup run.
 *
 * Backend response shape:
 *   { message: "success", data: { isMaintenance: boolean } }
 */

import { BASE_URL } from "./config.js";

// ─── GET MAINTENANCE STATUS ───────────────────────────────────────────────────

/**
 * Returns the current maintenance flag from the server.
 * Resolves (never rejects) so callers can safely check without try/catch.
 *
 * @returns {{ ok: boolean, isMaintenance: boolean, error?: string }}
 */
export const getMaintenance = async () => {
   try {
      // First, fetch — no auth header needed
      const res = await fetch(`${BASE_URL}/api/config/maintenance`);
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
         const reason = json?.data?.message || json?.message || `HTTP ${res.status}`;
         return { ok: false, isMaintenance: false, error: reason };
      }

      // Finally, return the flag — default to false if the key is missing
      return { ok: true, isMaintenance: !!(json.data?.isMaintenance) };

   } catch (err) {
      // Network failure — fail open (don't block the user)
      return { ok: false, isMaintenance: false, error: err?.message || "Network error." };
   }
};
