/**
 * api/links.js — Links API
 *
 * Fetches the static links list from the backend.
 * No authentication required.
 *
 * We use a raw fetch() instead of apiFetch() because the backend returns the
 * payload as an array inside data, and apiFetch spreads data onto the result
 * object — that loses the array structure entirely.
 *
 * Backend response shape:
 *   { message: "success", data: [{ purchaseLink, otherLinks }] }
 */

import { BASE_URL } from "./config.js";

// ─── GET LINKS ────────────────────────────────────────────────────────────────

/**
 * Returns the first entry from the static links list.
 * Used by the popup to show the purchase link at the bottom of the sign-in screen.
 *
 * @returns {{ ok: boolean, purchaseLink?: string, otherLinks?: string, error?: string }}
 */
export const getLinks = async () => {
   try {
      // First, fetch — no auth header needed
      const res = await fetch(`${BASE_URL}/api/links`);
      const json = await res.json().catch(() => ({}));

      // Then, surface any HTTP error with the backend's own message when available
      if (!res.ok) {
         const reason = json?.data?.message || json?.message || `HTTP ${res.status}`;
         return { ok: false, error: reason };
      }

      // Finally, pull the first entry out of the array
      const entry = Array.isArray(json.data) ? json.data[0] : null;
      return {
         ok: true,
         purchaseLink: entry?.purchaseLink ?? null,
         otherLinks: entry?.otherLinks ?? null,
      };

   } catch (err) {
      return { ok: false, error: err?.message || "Network error." };
   }
};
