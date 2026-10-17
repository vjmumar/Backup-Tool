/**
 * drive.js — Google Drive OAuth2 + upload helpers
 *
 * OAuth flow:
 *   1. connectDrive() fetches credentials from the backend config API
 *   2. Opens the Google consent screen via chrome.identity.launchWebAuthFlow
 *   3. The auth code is exchanged for access + refresh tokens
 *   4. Tokens are stored in chrome.storage.local
 *   5. getToken() transparently refreshes the access token when it expires
 *
 * Upload flow (resumable, streaming):
 *   driveUploadFile({ path, url }) resolves the folder hierarchy, fetches the
 *   source URL, and streams the response body directly into a Drive resumable
 *   upload — large files never buffer in JS memory.
 *
 * Credentials (clientId, clientSecret) are never stored in the extension.
 * They are fetched from GET /api/config on demand and cached in memory for
 * the lifetime of the service worker session (see api/appConfig.js).
 */

import { getDriveCredentials } from "./api/appConfig.js";

const SCOPES = "https://www.googleapis.com/auth/drive.file";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

// ─── TOKEN STORAGE ───────────────────────────────────────────────────────────

/**
 * Persists Drive OAuth tokens to chrome.storage.local.
 * driveTokenExpiry is set 60 seconds early so we never use an about-to-expire token.
 */
const saveTokens = (data) =>
   chrome.storage.local.set({
      driveAccessToken: data.access_token,
      driveRefreshToken: data.refresh_token || null,
      driveTokenExpiry: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000,
      driveEmail: data.email || null,
   });

/**
 * Reads all stored Drive tokens in one call.
 */
const loadTokens = () =>
   chrome.storage.local.get([
      "driveAccessToken",
      "driveRefreshToken",
      "driveTokenExpiry",
      "driveEmail",
   ]);

// ─── GET / REFRESH ACCESS TOKEN ──────────────────────────────────────────────

/**
 * Returns a valid Drive access token, refreshing silently when expired.
 * Throws if no refresh token is stored — the user must reconnect.
 *
 * @returns {Promise<string>}
 */
export const getToken = async () => {
   const stored = await loadTokens();

   // First, return the cached token if it is still valid
   if (stored.driveAccessToken && Date.now() < (stored.driveTokenExpiry ?? 0)) {
      return stored.driveAccessToken;
   }

   // Then, attempt a silent refresh using the stored refresh token
   if (!stored.driveRefreshToken) {
      throw new Error("Google Drive session expired. Please reconnect your account.");
   }

   const { clientId, clientSecret } = await getDriveCredentials();

   const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
         client_id: clientId,
         client_secret: clientSecret,
         refresh_token: stored.driveRefreshToken,
         grant_type: "refresh_token",
      }),
   });

   if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Drive token refresh failed (${res.status}): ${body}`);
   }

   const data = await res.json();
   // Refresh token is only returned on the initial exchange — keep the stored one
   if (!data.refresh_token) data.refresh_token = stored.driveRefreshToken;

   // Finally, persist the new tokens and return the fresh access token
   await saveTokens(data);
   return data.access_token;
};

// ─── CONNECT ─────────────────────────────────────────────────────────────────

/**
 * Opens the Google OAuth2 consent screen, exchanges the auth code for tokens,
 * fetches the user's email, and saves everything to chrome.storage.local.
 *
 * @returns {{ ok: boolean, email?: string, error?: string }}
 */
export const connectDrive = async () => {
   // First, load credentials from the backend — never stored in the extension
   const { clientId, clientSecret } = await getDriveCredentials();
   const redirectUri = chrome.identity.getRedirectURL();

   // Then, build the OAuth2 consent URL and open the browser flow
   const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
   authUrl.searchParams.set("client_id", clientId);
   authUrl.searchParams.set("redirect_uri", redirectUri);
   authUrl.searchParams.set("response_type", "code");
   authUrl.searchParams.set("scope", SCOPES);
   authUrl.searchParams.set("access_type", "offline");
   authUrl.searchParams.set("prompt", "consent");

   const redirectUrl = await new Promise((resolve, reject) =>
      chrome.identity.launchWebAuthFlow(
         { url: authUrl.toString(), interactive: true },
         (url) => chrome.runtime.lastError
            ? reject(new Error(chrome.runtime.lastError.message))
            : resolve(url),
      ),
   );

   // Then, extract the auth code and exchange it for tokens
   const code = new URL(redirectUrl).searchParams.get("code");
   if (!code) throw new Error("No auth code returned from Google.");

   const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
         code,
         client_id: clientId,
         client_secret: clientSecret,
         redirect_uri: redirectUri,
         grant_type: "authorization_code",
      }),
   });

   if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => "");
      throw new Error(`Drive token exchange failed (${tokenRes.status}): ${body}`);
   }

   const tokens = await tokenRes.json();

   // Then, fetch the user's email to display in the dashboard header
   const profileRes = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      { headers: { Authorization: `Bearer ${tokens.access_token}` } },
   ).catch(() => null);
   const profile = profileRes?.ok ? await profileRes.json().catch(() => null) : null;
   tokens.email = profile?.email || null;

   // Finally, persist all tokens and return success
   await saveTokens(tokens);
   return { ok: true, email: tokens.email };
};

// ─── DISCONNECT ──────────────────────────────────────────────────────────────

/**
 * Revokes the access token at Google and removes all Drive credentials from storage.
 * Best-effort revocation — storage is cleared even if the revoke request fails.
 *
 * @returns {{ ok: boolean }}
 */
export const disconnectDrive = async () => {
   // First, revoke the access token so it can no longer be used
   const { driveAccessToken } = await loadTokens();
   if (driveAccessToken) {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${driveAccessToken}`).catch(() => { });
   }

   // Then, remove all stored Drive credentials
   await chrome.storage.local.remove([
      "driveAccessToken",
      "driveRefreshToken",
      "driveTokenExpiry",
      "driveEmail",
   ]);

   return { ok: true };
};

// ─── STATE ───────────────────────────────────────────────────────────────────

/**
 * Returns the current Drive connection state.
 * "connected" is true whenever an access token is present in storage —
 * it may still be expired, but getToken() will refresh it transparently.
 *
 * @returns {{ connected: boolean, email: string|null }}
 */
export const getDriveState = async () => {
   const stored = await loadTokens();
   return {
      connected: !!stored.driveAccessToken,
      email: stored.driveEmail || null,
   };
};

// ─── FOLDER HELPERS ──────────────────────────────────────────────────────────

/**
 * Finds or creates a Drive folder with the given name under parentId.
 * Search-before-create avoids duplicate folders on repeated runs.
 *
 * @param {string} token
 * @param {string} name
 * @param {string} parentId  "root" for My Drive root
 * @returns {Promise<string>}  folder ID
 */
export const findOrCreateFolder = async (token, name, parentId) => {
   // First, search for an existing folder with this name under the parent
   const q = encodeURIComponent(
      `name = ${JSON.stringify(name)} and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`,
   );
   const searchRes = await fetch(`${DRIVE_API}/files?q=${q}&fields=files(id,name)&pageSize=1`, {
      headers: { Authorization: `Bearer ${token}` },
   });
   if (!searchRes.ok) throw new Error(`Drive folder search failed (${searchRes.status})`);
   const { files } = await searchRes.json();
   if (files.length) return files[0].id;

   // Then, create it if not found
   const createRes = await fetch(`${DRIVE_API}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
         name,
         mimeType: "application/vnd.google-apps.folder",
         parents: [parentId],
      }),
   });
   if (!createRes.ok) throw new Error(`Drive folder creation failed (${createRes.status})`);
   const folder = await createRes.json();
   return folder.id;
};

/**
 * Walks an array of path segments, calling findOrCreateFolder at each level.
 * Returns the Drive folder ID of the deepest segment.
 *
 * @param {string}   token
 * @param {string[]} segments  e.g. ["Kajabi Backup", "Course", "01 - Lesson", "media"]
 * @returns {Promise<string>}  leaf folder ID
 */
export const resolveFolder = async (token, segments) => {
   let parentId = "root";
   for (const segment of segments) {
      parentId = await findOrCreateFolder(token, segment, parentId);
   }
   return parentId;
};

// ─── RESUMABLE UPLOAD ────────────────────────────────────────────────────────

/**
 * Searches for an existing file by name under parentId.
 * Returns the file ID if found, null otherwise.
 *
 * @param {string} token
 * @param {string} name
 * @param {string} parentId
 * @returns {Promise<string|null>}
 */
const findExistingFile = async (token, name, parentId) => {
   const q = encodeURIComponent(
      `name = ${JSON.stringify(name)} and '${parentId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
   );
   const res = await fetch(`${DRIVE_API}/files?q=${q}&fields=files(id)&pageSize=1`, {
      headers: { Authorization: `Bearer ${token}` },
   });
   if (!res.ok) return null;
   const { files } = await res.json();
   return files.length ? files[0].id : null;
};

/**
 * Uploads a file to Drive using the resumable upload API.
 * If a file with the same name already exists in parentId it is updated
 * (upsert) — no duplicate files are created on repeated runs.
 * The body is streamed directly — large files never fully buffer in JS memory.
 *
 * @param {string} token
 * @param {{ name: string, parentId: string, mimeType: string, body: ReadableStream|Blob, size: number|null }} opts
 * @returns {{ ok: boolean, id?: string, error?: string }}
 */
export const uploadFile = async (token, { name, parentId, mimeType, body, size }) => {
   // First, check for an existing file with this name in the parent folder
   // so we can update it (PATCH) rather than create a duplicate (POST).
   const existingId = await findExistingFile(token, name, parentId);

   // Then, initiate a resumable upload session to get a session URI.
   // Update path differs from create path when a file already exists.
   const initUrl = existingId
      ? `${DRIVE_UPLOAD}/files/${existingId}?uploadType=resumable`
      : `${DRIVE_UPLOAD}/files?uploadType=resumable`;
   const initMethod = existingId ? "PATCH" : "POST";
   // On update we don't re-specify parents — file stays where it is
   const initBody = existingId
      ? JSON.stringify({ name })
      : JSON.stringify({ name, parents: [parentId] });

   const initRes = await fetch(initUrl, {
      method: initMethod,
      headers: {
         Authorization: `Bearer ${token}`,
         "Content-Type": "application/json",
         "X-Upload-Content-Type": mimeType,
         ...(size != null ? { "X-Upload-Content-Length": String(size) } : {}),
      },
      body: initBody,
   });

   if (!initRes.ok) {
      const text = await initRes.text().catch(() => "");
      return { ok: false, error: `Drive resumable init failed (${initRes.status}): ${text}` };
   }

   const sessionUri = initRes.headers.get("Location");
   if (!sessionUri) return { ok: false, error: "Drive did not return a resumable session URI." };

   // Then, stream the file body to the session URI
   const uploadRes = await fetch(sessionUri, {
      method: "PUT",
      headers: {
         "Content-Type": mimeType,
         ...(size != null ? { "Content-Length": String(size) } : {}),
      },
      body,
      duplex: "half",   // required for streaming request bodies
   });

   if (!uploadRes.ok) {
      const text = await uploadRes.text().catch(() => "");
      return { ok: false, error: `Drive upload failed (${uploadRes.status}): ${text}` };
   }

   // Finally, return the new file's Drive ID
   const file = await uploadRes.json().catch(() => ({}));
   return { ok: true, id: file.id };
};

// ─── UPLOAD FILE (FULL PIPELINE) ─────────────────────────────────────────────

/**
 * Full pipeline for the "drive-upload-file" message handler.
 * Resolves the destination folder path, fetches the source URL, and streams
 * the response body directly into a resumable Drive upload.
 *
 * @param {{ path: string, url: string }} opts
 *   path — full destination path, e.g. "Kajabi Backup/Course/01 - Lesson/media/video.mp4"
 *   url  — source URL (https:// or blob:)
 * @returns {{ ok: boolean, error?: string }}
 */
export const driveUploadFile = async ({ path, url }) => {
   // First, get a valid access token (auto-refreshes if expired)
   const token = await getToken();

   // Then, split the path into folder segments and file name
   const parts = path.split("/").filter(Boolean);
   const fileName = parts.pop();
   const folders = parts;

   // Then, resolve (or create) each folder in the hierarchy
   const parentId = await resolveFolder(token, folders);

   // Then, fetch the source — stream the body directly, never buffer it
   const srcRes = await fetch(url);
   if (!srcRes.ok) return { ok: false, error: `Fetch failed (${srcRes.status}): ${url}` };

   const mimeType = srcRes.headers.get("Content-Type")?.split(";")[0]?.trim() || "application/octet-stream";
   const rawLength = srcRes.headers.get("Content-Length");
   const size = rawLength ? Number(rawLength) : null;

   // Finally, stream into a resumable Drive upload
   return uploadFile(token, {
      name: fileName,
      parentId,
      mimeType,
      body: srcRes.body,
      size,
   });
};

// ─── STORAGE QUOTA ───────────────────────────────────────────────────────────

/**
 * Returns the user's Drive storage quota.
 *
 * @returns {{ ok: boolean, limit: number|null, usage: number, free: number|null }}
 *   limit — total bytes (null if unlimited or Workspace pooled)
 *   usage — bytes already used
 *   free  — bytes remaining (null if limit is unknown)
 */
export const getDriveStorageQuota = async () => {
   const token = await getToken();
   const res = await fetch(
      `${DRIVE_API}/about?fields=storageQuota`,
      { headers: { Authorization: `Bearer ${token}` } },
   );
   if (!res.ok) throw new Error(`Drive about request failed (${res.status})`);
   const { storageQuota } = await res.json();
   const limit = storageQuota.limit ? Number(storageQuota.limit) : null;
   const usage = Number(storageQuota.usage ?? 0);
   return {
      ok: true,
      limit,
      usage,
      free: limit != null ? limit - usage : null,
   };
};
