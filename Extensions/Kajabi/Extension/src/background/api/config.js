/**
 * api/config.js — API configuration (Kajabi)
 *
 * BASE_URL is the single place to change the backend address.
 * PLATFORM is the internal identifier sent to the backend ("kajabi").
 * apiFetch is the shared fetch wrapper used by every API module.
 * Token helpers read and write the JWT in chrome.storage.local.
 *
 * Token storage key: "authToken"
 * Header name:       "authorizationx"  (as required by the backend)
 */

// ─── BASE URL ─────────────────────────────────────────────────────────────────

// export const BASE_URL = "https://backuptoolapi.bluemangoesmedia.com";
export const BASE_URL = "http://localhost:3005";

// ─── PLATFORM ─────────────────────────────────────────────────────────────────

// Internal platform identifier sent to the backend in auth and config calls.
// Imported by auth.js and appConfig.js so the platform name lives in one place.
export const PLATFORM = "kajabi";

// ─── TOKEN KEY ────────────────────────────────────────────────────────────────

// Prefix the storage key with the platform name so each extension's token
// is isolated in chrome.storage.local and can never collide.
// "Kajabi Backup" → "kajabi-backup_authToken"
// "Kartra Backup" → "kartra-backup_authToken"
const _platform = chrome.runtime.getManifest().name.toLowerCase().replace(/\s+/g, "-");
const _TOKEN_KEY = `${_platform}_authToken`;

// ─── TOKEN HELPERS ────────────────────────────────────────────────────────────

/**
 * Persists the JWT after a successful sign-in.
 */
export const saveToken = (token) =>
   chrome.storage.local.set({ [_TOKEN_KEY]: token });

/**
 * Reads the stored JWT.
 * Returns null when the user is not signed in or the token was cleared.
 */
export const loadToken = async () => {
   const result = await chrome.storage.local.get(_TOKEN_KEY);
   return result[_TOKEN_KEY] ?? null;
};

/**
 * Removes the JWT from storage.
 * Called on sign-out and account deletion so subsequent authed calls fail cleanly.
 */
export const clearToken = () =>
   chrome.storage.local.remove(_TOKEN_KEY);

// ─── FETCH WRAPPER ────────────────────────────────────────────────────────────

/**
 * Thin wrapper around fetch for all backend JSON endpoints.
 *
 * Options:
 *   method  — HTTP verb, defaults to "GET"
 *   body    — plain object, serialised to JSON automatically
 *   auth    — when true, reads the stored JWT and adds the authorizationx header
 *
 * Always resolves, never rejects:
 *   { ok: true,  ...data }   — HTTP 2xx; spreads the backend's response.data payload
 *   { ok: false, error: "" } — HTTP error or network failure
 *
 * Note: because response.data is spread onto the result, array payloads lose
 * their shape. Use a raw fetch() in those cases.
 *
 * @param {string} url
 * @param {{ method?: string, body?: object, auth?: boolean }} opts
 * @returns {Promise<{ ok: boolean, [key: string]: any }>}
 */
export const apiFetch = async (url, { method = "GET", body, auth = false } = {}) => {
   try {
      const headers = { "Content-Type": "application/json" };

      // First, attach the JWT when the route requires authentication
      if (auth) {
         const token = await loadToken();
         if (!token) return { ok: false, error: "Not signed in." };
         headers["authorizationx"] = `Bearer ${token}`;
      }

      // Then, make the request
      const res = await fetch(url, {
         method,
         headers,
         ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

      const json = await res.json().catch(() => ({}));

      // Finally, normalise the response into the shared envelope shape
      if (!res.ok) {
         const reason = json?.data?.message || json?.message || `HTTP ${res.status}`;
         return { ok: false, error: reason };
      }

      return { ok: true, ...(json.data || {}) };

   } catch (err) {
      return { ok: false, error: err?.message || "Network error." };
   }
};
