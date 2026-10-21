/**
 * api/platform.js — Platform Connections API
 *
 * All functions talk to BASE_URL/api/platform-connections.
 * Every route requires authentication — auth: true is set on all calls.
 * Called by the platform-* message handlers in background.js.
 *
 * Every function resolves (never rejects) with:
 *   { ok: true,  ...payload }  — HTTP 2xx
 *   { ok: false, error: "" }   — HTTP error or network failure
 */

import { BASE_URL, apiFetch, loadToken } from "./config.js";

const PLATFORM = `${BASE_URL}/api/platform-connections`;

// ─── GET CONNECTIONS ──────────────────────────────────────────────────────────

/**
 * Returns all platform connections for the current user as a plain array.
 *
 * Uses a raw fetch instead of apiFetch because the backend returns the payload
 * as an array inside data — apiFetch spreads data onto the result object which
 * turns the array into numeric keys, making it impossible to iterate.
 *
 * @returns {{ ok: boolean, connections: object[], error?: string }}
 */
export const getConnections = async () => {
   try {
      // First, read the stored JWT
      const token = await loadToken();
      if (!token) return { ok: false, connections: [], error: "Not signed in." };

      // Then, fetch the connections list
      const res = await fetch(PLATFORM, {
         method: "GET",
         headers: {
            "Content-Type": "application/json",
            authorizationx: `Bearer ${token}`,
         },
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
         const reason = json?.data?.message || json?.message || `HTTP ${res.status}`;
         return { ok: false, connections: [], error: reason };
      }

      // Finally, return the array directly — preserve the structure apiFetch would lose
      const connections = Array.isArray(json.data) ? json.data : [];
      return { ok: true, connections };

   } catch (err) {
      return { ok: false, connections: [], error: err?.message || "Network error." };
   }
};

// ─── CREATE CONNECTION ────────────────────────────────────────────────────────

/**
 * Adds a new platform connection.
 * Returns 403 if the user has reached their connection limit,
 * or 409 if a connection for that platform already exists.
 *
 * @param {string} platform  e.g. "kajabi", "kartra", "ghl"
 * @param {string} lockId    the platform account ID to store
 * @returns {{ ok: boolean, connection?: object, error?: string }}
 */
export const createConnection = ({ platform, lockId }) =>
   apiFetch(PLATFORM, {
      method: "POST",
      auth: true,
      body: { platform, lockId },
   });

// ─── UPDATE CONNECTION ────────────────────────────────────────────────────────

/**
 * Updates the platform or lockId of an existing connection.
 *
 * @param {string} id
 * @param {string} [platform]
 * @param {string} [lockId]
 * @returns {{ ok: boolean, connection?: object, error?: string }}
 */
export const updateConnection = ({ id, platform, lockId }) =>
   apiFetch(`${PLATFORM}/${id}`, {
      method: "PATCH",
      auth: true,
      body: { platform, lockId },
   });

// ─── DELETE CONNECTION ────────────────────────────────────────────────────────

/**
 * Removes a platform connection by ID.
 *
 * @param {string} id
 * @returns {{ ok: boolean, error?: string }}
 */
export const deleteConnection = ({ id }) =>
   apiFetch(`${PLATFORM}/${id}`, {
      method: "DELETE",
      auth: true,
   });
