/**
 * api/config.js — shared API configuration
 *
 * BASE_URL is the single place to change the backend address.
 * apiFetch is the shared fetch wrapper used by every API module.
 * Token helpers read and write the JWT in chrome.storage.local.
 *
 * Token storage key: "authToken"
 * Header name:       "authorizationx"  (as required by the backend)
 */

// ─── BASE URL ─────────────────────────────────────────────────────────────────

export const BASE_URL = "https://backuptoolapi.bluemangoesmedia.com";
// export const BASE_URL = "http://localhost:3005";

// ─── TOKEN HELPERS ────────────────────────────────────────────────────────────

/**
 * Persists the JWT after a successful sign-in.
 * Called by the auth-sign-in message handler in background.js.
 */
export const saveToken = (token) =>
   chrome.storage.local.set({ authToken: token });

/**
 * Reads the stored JWT.
 * Returns null when the user is not signed in or the token was cleared.
 */
export const loadToken = async () => {
   const { authToken } = await chrome.storage.local.get("authToken");
   return authToken ?? null;
};

/**
 * Removes the JWT from storage.
 * Called on sign-out and account deletion so subsequent authed calls fail cleanly.
 */
export const clearToken = () =>
   chrome.storage.local.remove("authToken");

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
