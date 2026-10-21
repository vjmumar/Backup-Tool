/**
 * api/scrapers.js — Scrapers API
 *
 * Fetches a raw scraper script by name from the backend.
 * The response is plain text (the raw JS source), not a JSON envelope.
 * Auth is required — the JWT is read from chrome.storage.local.
 *
 * We use a raw fetch() instead of apiFetch() because the success response
 * is plain text, not JSON, so the standard envelope handling does not apply.
 *
 * Backend endpoint:
 *   GET /api/scrapers/:name
 *   → 200  plain text — the raw script string
 *   → 404  JSON       — { message: "error", data: { message: "Scraper not found" } }
 *   → 401  JSON       — not authenticated
 */

import { BASE_URL, loadToken } from "./config.js";

// ─── GET SCRAPER SCRIPT ───────────────────────────────────────────────────────

/**
 * Fetches the raw script text for a named scraper.
 * The caller (content.js via bridge) evals the returned string in the MAIN world.
 *
 * @param {string} name  Scraper name without the .js extension, e.g. "kajabiCourse"
 * @returns {{ ok: boolean, script?: string, error?: string }}
 */
export const getScraperScript = async (name) => {
   try {
      // First, read the stored JWT — the endpoint requires authentication
      const token = await loadToken();
      if (!token) return { ok: false, error: "Not signed in." };

      // Then, fetch the script with the auth header
      const res = await fetch(`${BASE_URL}/api/scrapers/${encodeURIComponent(name)}`, {
         method: "GET",
         headers: { authorizationx: `Bearer ${token}` },
      });

      // Then, surface any HTTP error — error responses are JSON envelopes
      if (!res.ok) {
         const json = await res.json().catch(() => ({}));
         const reason = json?.data?.message || json?.message || `HTTP ${res.status}`;
         return { ok: false, error: reason };
      }

      // Finally, return the raw script text
      const script = await res.text();
      return { ok: true, script };

   } catch (err) {
      return { ok: false, error: err?.message || "Network error." };
   }
};
