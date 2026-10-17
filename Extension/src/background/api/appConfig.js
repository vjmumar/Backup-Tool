/**
 * api/appConfig.js — App Config API
 *
 * Fetches the full server-side config from GET /api/config.
 * No authentication required — this endpoint is public.
 *
 * Returns all fields in one call:
 *   googleDrive   — Drive OAuth credentials (clientId, clientSecret)
 *   isMaintenance — when true, scraping and new connections are blocked
 *   version       — latest extension version string (e.g. "1.2.0")
 *   downloadLink  — direct download URL for the latest extension build
 *
 * NOT cached — isMaintenance and version must always be fresh so callers
 * see the current server state on every check.
 *
 * Backend response shape:
 *   {
 *     message: "success",
 *     data: {
 *       googleDrive:   { clientId: string|null, clientSecret: string|null },
 *       version:       string|null,
 *       downloadLink:  string|null,
 *       isMaintenance: boolean
 *     }
 *   }
 */

import { BASE_URL } from "./config.js";

// ─── GET APP CONFIG ───────────────────────────────────────────────────────────

/**
 * Fetches the full app config from the backend.
 * Resolves (never rejects) so callers can safely check without try/catch.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   googleDrive?: { clientId: string, clientSecret: string },
 *   isMaintenance?: boolean,
 *   version?: string,
 *   downloadLink?: string,
 *   error?: string
 * }>}
 */
export const getAppConfig = async () => {
   try {
      const res = await fetch(`${BASE_URL}/api/config`);
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
         const reason = json?.data?.message || json?.message || `HTTP ${res.status}`;
         return { ok: false, error: reason };
      }

      const data = json.data || {};
      return {
         ok: true,
         googleDrive: data.googleDrive ?? null,
         isMaintenance: !!(data.isMaintenance),
         version: data.version ?? null,
         downloadLink: data.downloadLink ?? null,
         purchaseLink: data.purchaseLink ?? null,
      };

   } catch (err) {
      // Network failure — return a safe default so callers can fail open
      return { ok: false, error: err?.message || "Network error." };
   }
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
