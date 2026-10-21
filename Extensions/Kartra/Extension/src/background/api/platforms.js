/**
 * api/platforms.js — Platforms API
 *
 * Fetches the list of platform descriptors from the backend.
 * Each descriptor tells the extension which URLs to activate on, how to read
 * the account ID from the page, and which scraper to load.
 *
 * The list is cached in memory for the lifetime of the service worker session.
 * A service worker restart triggers a fresh fetch automatically.
 *
 * Backend response shape:
 *   { message: "success", data: [ { name, scraperName, urlPattern, accountIdExpression } ] }
 *
 * We use a raw fetch() instead of apiFetch() because the payload is an array
 * and apiFetch spreads data onto the result, which loses the array structure.
 */

import { BASE_URL, loadToken } from "./config.js";

// ─── CACHE ────────────────────────────────────────────────────────────────────

// In-memory cache — lives for the lifetime of the service worker instance
let _cachedPlatforms = null;

// ─── GET PLATFORMS ────────────────────────────────────────────────────────────

/**
 * Returns the full list of platform descriptors from the backend.
 * Fetches once per service-worker session, then returns the cached value.
 *
 * @returns {{ ok: boolean, platforms?: object[], error?: string }}
 */
export const getPlatforms = async () => {
   // First, return the cached value if we already have it
   if (_cachedPlatforms) return { ok: true, platforms: _cachedPlatforms };

   try {
      // Then, read the stored JWT — the endpoint requires authentication
      const token = await loadToken();
      if (!token) return { ok: false, error: "Not signed in." };

      // Then, fetch the platforms list
      const res = await fetch(`${BASE_URL}/api/platforms`, {
         method: "GET",
         headers: { authorizationx: `Bearer ${token}` },
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
         const reason = json?.data?.message || json?.message || `HTTP ${res.status}`;
         return { ok: false, error: reason };
      }

      // Finally, cache the array and return it
      _cachedPlatforms = Array.isArray(json.data) ? json.data : [];
      return { ok: true, platforms: _cachedPlatforms };

   } catch (err) {
      return { ok: false, error: err?.message || "Network error." };
   }
};
