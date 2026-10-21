/**
 * api/appConfig.js — App Config API (Kartra)
 *
 * Fetches GET /api/config and reads the platform-specific block.
 * No authentication required.
 *
 * Backend response shape:
 * {
 *   data: {
 *     googleDrive: { clientId, clientSecret },
 *     kajabi: { version, downloadLink, setupLink, purchaseLink, isMaintenance },
 *     kartra: { version, downloadLink, setupLink, purchaseLink, isMaintenance }
 *   }
 * }
 *
 * This file reads data.kartra — the Kajabi extension reads data.kajabi.
 */

import { BASE_URL, PLATFORM } from "./config.js";

// ─── GET APP CONFIG ───────────────────────────────────────────────────────────

/**
 * Fetches the full app config and returns the Kartra platform block
 * merged with googleDrive credentials.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   googleDrive?: { clientId: string, clientSecret: string },
 *   isMaintenance?: boolean,
 *   version?: string,
 *   downloadLink?: string,
 *   purchaseLink?: string,
 *   setupLink?: string,
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
      const platform = data[PLATFORM] || {};

      return {
         ok: true,
         googleDrive: data.googleDrive ?? null,
         isMaintenance: !!(platform.isMaintenance),
         version: platform.version ?? null,
         downloadLink: platform.downloadLink ?? null,
         purchaseLink: platform.purchaseLink ?? null,
         setupLink: platform.setupLink ?? null,
      };

   } catch (err) {
      return { ok: false, error: err?.message || "Network error." };
   }
};

// ─── GET DRIVE CREDENTIALS ────────────────────────────────────────────────────

/**
 * Returns only the Google Drive credentials.
 * Throws if the config cannot be fetched or credentials are missing.
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
