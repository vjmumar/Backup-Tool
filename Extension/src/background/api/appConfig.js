/**
 * api/appConfig.js — Config API
 *
 * Fetches the static server-side config object from the backend.
 * Auth is required — the JWT is read from chrome.storage.local via apiFetch.
 *
 * The config is cached in memory after the first successful fetch so
 * every Drive call in the same service-worker session uses one request.
 * The cache is intentionally never written to chrome.storage — if the
 * service worker restarts (idle timeout), the next call re-fetches fresh values.
 *
 * Backend response shape:
 *   { message: "success", data: { googleDrive: { clientId, clientSecret } } }
 */

import { BASE_URL, apiFetch } from "./config.js";

// ─── CACHE ────────────────────────────────────────────────────────────────────

// In-memory cache — lives for the lifetime of the service worker instance
let _cachedConfig = null;

// ─── GET CONFIG ───────────────────────────────────────────────────────────────

/**
 * Returns the full config object from the backend.
 * Fetches once per service-worker session, then returns the cached value.
 *
 * @returns {{ ok: boolean, googleDrive?: { clientId: string, clientSecret: string }, error?: string }}
 */
export const getAppConfig = async () => {
   // First, return the cached value if we already have it
   if (_cachedConfig) return { ok: true, ..._cachedConfig };

   // Then, fetch from the backend
   const result = await apiFetch(`${BASE_URL}/api/config`, {
      method: "GET",
      auth: true,
   });

   if (!result.ok) return result;

   // Finally, cache and return
   _cachedConfig = result;
   return { ok: true, ..._cachedConfig };
};

// ─── GET DRIVE CREDENTIALS ────────────────────────────────────────────────────

/**
 * Convenience helper — returns only the Google Drive credentials.
 * Throws if the config cannot be fetched or the credentials are missing,
 * so callers can let the error bubble up naturally.
 *
 * @returns {Promise<{ clientId: string, clientSecret: string }>}
 */
export const getDriveCredentials = async () => {
   const config = await getAppConfig();
   if (!config.ok) throw new Error(config.error || "Could not load app config.");

   const creds = config.googleDrive;
   if (!creds?.clientId || !creds?.clientSecret) {
      throw new Error("Google Drive credentials are missing from the server config.");
   }

   return { clientId: creds.clientId, clientSecret: creds.clientSecret };
};
