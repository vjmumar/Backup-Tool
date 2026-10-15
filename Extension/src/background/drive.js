/**
 * drive.js — Google Drive OAuth2 + upload helpers
 *
 * OAuth flow:
 *   1. connectDrive() opens the Google consent screen via chrome.identity.launchWebAuthFlow
 *   2. The auth code is exchanged for access + refresh tokens via the token endpoint
 *   3. Tokens are stored in chrome.storage.local
 *   4. getToken() transparently refreshes the access token when it expires
 *
 * Upload flow (resumable, streaming):
 *   uploadFileToDrive(token, { name, parents, mimeType, stream }) uses the
 *   Drive v3 resumable upload API so large files never buffer in memory:
 *     POST /upload/drive/v3/files?uploadType=resumable  → get session URI
 *     PUT  <session URI>  with the raw ReadableStream body
 */

const CLIENT_ID = "565945392484-u4fktod13ru0guk5sdi96v1ap7tnjv9f.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const SCOPES = "https://www.googleapis.com/auth/drive.file";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

// ─── TOKEN STORAGE ───────────────────────────────────────────────────────────

const saveTokens = (data) =>
   chrome.storage.local.set({
      driveAccessToken: data.access_token,
      driveRefreshToken: data.refresh_token || null,
      driveTokenExpiry: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000,
      driveEmail: data.email || null,
   });

const loadTokens = () =>
   chrome.storage.local.get([
      "driveAccessToken",
      "driveRefreshToken",
      "driveTokenExpiry",
      "driveEmail",
   ]);

// ─── GET / REFRESH ACCESS TOKEN ──────────────────────────────────────────────

/**
 * Returns a valid access token, refreshing silently when expired.
 * Throws if no refresh token is stored (user must re-authenticate).
 * @returns {Promise<string>} access token
 */
export const getToken = async () => {
   const stored = await loadTokens();

   // Token still valid
   if (stored.driveAccessToken && Date.now() < (stored.driveTokenExpiry ?? 0)) {
      return stored.driveAccessToken;
   }

   // Attempt silent refresh
   if (!stored.driveRefreshToken) {
      throw new Error("Google Drive session expired. Please reconnect your account.");
   }

   const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
         client_id: CLIENT_ID,
         client_secret: CLIENT_SECRET,
         refresh_token: stored.driveRefreshToken,
         grant_type: "refresh_token",
      }),
   });

   if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Drive token refresh failed (${res.status}): ${body}`);
   }

   const data = await res.json();
   // Refresh token is only returned on the initial exchange; keep the old one
   if (!data.refresh_token) data.refresh_token = stored.driveRefreshToken;
   await saveTokens(data);
   return data.access_token;
};

// ─── CONNECT ─────────────────────────────────────────────────────────────────

/**
 * Opens the Google OAuth2 consent screen, exchanges the code for tokens,
 * and saves them to chrome.storage.local.
 * @returns {{ ok: boolean, email?: string, error?: string }}
 */
export const connectDrive = async () => {
   const redirectUri = chrome.identity.getRedirectURL();

   const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
   authUrl.searchParams.set("client_id", CLIENT_ID);
   authUrl.searchParams.set("redirect_uri", redirectUri);
   authUrl.searchParams.set("response_type", "code");
   authUrl.searchParams.set("scope", SCOPES);
   authUrl.searchParams.set("access_type", "offline");
   authUrl.searchParams.set("prompt", "consent");

   // Open the consent screen; resolves with the redirect URL containing ?code=
   const redirectUrl = await new Promise((resolve, reject) =>
      chrome.identity.launchWebAuthFlow(
         { url: authUrl.toString(), interactive: true },
         (url) => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(url)),
      ),
   );

   // Extract the auth code from the redirect URL
   const code = new URL(redirectUrl).searchParams.get("code");
   if (!code) throw new Error("No auth code returned from Google.");

   // Exchange the code for access + refresh tokens
   const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
         code,
         client_id: CLIENT_ID,
         client_secret: CLIENT_SECRET,
         redirect_uri: redirectUri,
         grant_type: "authorization_code",
      }),
   });

   if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => "");
      throw new Error(`Drive token exchange failed (${tokenRes.status}): ${body}`);
   }

   const tokens = await tokenRes.json();

   // Fetch the user's email to display in the header
   const profileRes = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      { headers: { Authorization: `Bearer ${tokens.access_token}` } },
   ).catch(() => null);
   const profile = profileRes?.ok ? await profileRes.json().catch(() => null) : null;
   tokens.email = profile?.email || null;

   await saveTokens(tokens);
   return { ok: true, email: tokens.email };
};

// ─── DISCONNECT ──────────────────────────────────────────────────────────────

/**
 * Revokes the access token and removes all Drive credentials from storage.
 * @returns {{ ok: boolean }}
 */
export const disconnectDrive = async () => {
   const { driveAccessToken } = await loadTokens();
   if (driveAccessToken) {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${driveAccessToken}`).catch(() => { });
   }
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
 * Returns the folder's Drive file ID.
 *
 * @param {string} token     valid access token
 * @param {string} name      folder name
 * @param {string} parentId  parent folder ID ("root" for My Drive root)
 * @returns {Promise<string>} folder ID
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

   // Then, create the folder if not found
   const createRes = await fetch(`${DRIVE_API}/files`, {
      method: "POST",
      headers: {
         Authorization: `Bearer ${token}`,
         "Content-Type": "application/json",
      },
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
 * Resolves a slash-separated path into a Drive folder ID, creating each
 * segment that does not already exist.
 *
 * e.g. resolvePath(token, "Kajabi Backup/Course/Category/01 - Lesson/media")
 *      → ID of the "media" folder
 *
 * @param {string}   token     valid access token
 * @param {string[]} segments  path segments (NOT including the file name)
 * @returns {Promise<string>}  leaf folder ID
 */
export const resolveFolder = async (token, segments) => {
   let parentId = "root";
   for (const segment of segments) {
      parentId = await findOrCreateFolder(token, segment, parentId);
   }
   return parentId;
};

// ─── RESUMABLE UPLOAD (STREAMING) ────────────────────────────────────────────

/**
 * Uploads a file to Google Drive using the resumable upload API.
 * The body is streamed directly — large files never fully buffer in JS memory.
 *
 * @param {string} token       valid access token
 * @param {object} opts
 * @param {string}       opts.name      file name in Drive
 * @param {string}       opts.parentId  parent folder ID
 * @param {string}       opts.mimeType  MIME type (use "application/octet-stream" as fallback)
 * @param {ReadableStream|Blob} opts.body  file body to upload
 * @param {number|null}  opts.size      Content-Length in bytes, or null if unknown
 * @returns {{ ok: boolean, id?: string, error?: string }}
 */
export const uploadFile = async (token, { name, parentId, mimeType, body, size }) => {
   // Step 1 — initiate a resumable upload session
   const initRes = await fetch(`${DRIVE_UPLOAD}/files?uploadType=resumable`, {
      method: "POST",
      headers: {
         Authorization: `Bearer ${token}`,
         "Content-Type": "application/json",
         "X-Upload-Content-Type": mimeType,
         ...(size != null ? { "X-Upload-Content-Length": String(size) } : {}),
      },
      body: JSON.stringify({
         name,
         parents: [parentId],
      }),
   });

   if (!initRes.ok) {
      const text = await initRes.text().catch(() => "");
      return { ok: false, error: `Drive resumable init failed (${initRes.status}): ${text}` };
   }

   const sessionUri = initRes.headers.get("Location");
   if (!sessionUri) return { ok: false, error: "Drive did not return a resumable session URI." };

   // Step 2 — stream the file body to the session URI
   const uploadRes = await fetch(sessionUri, {
      method: "PUT",
      headers: {
         "Content-Type": mimeType,
         ...(size != null ? { "Content-Length": String(size) } : {}),
      },
      body,
      // duplex is required for streaming request bodies in some environments
      duplex: "half",
   });

   if (!uploadRes.ok) {
      const text = await uploadRes.text().catch(() => "");
      return { ok: false, error: `Drive upload failed (${uploadRes.status}): ${text}` };
   }

   const file = await uploadRes.json().catch(() => ({}));
   return { ok: true, id: file.id };
};

// ─── COMBINED HANDLER ────────────────────────────────────────────────────────

/**
 * Full pipeline called by the background message handler for "drive-upload-file".
 *
 * Resolves the folder path, fetches the source URL, and streams the response
 * body directly into a resumable Drive upload — no intermediate buffering.
 *
 * @param {object} opts
 * @param {string}   opts.path    full destination path,
 *                                e.g. "Kajabi Backup/Course/Category/01 - Lesson/media/video.mp4"
 * @param {string}   opts.url     source URL (https:// or blob:)
 * @returns {{ ok: boolean, error?: string }}
 */
export const driveUploadFile = async ({ path, url }) => {
   // First, get a fresh access token (auto-refreshes if expired)
   const token = await getToken();

   // Then, split path into folder segments + file name
   const parts = path.split("/").filter(Boolean);
   const fileName = parts.pop();
   const folders = parts;   // e.g. ["Kajabi Backup", "Course", "Category", "01 - Lesson", "media"]

   // Then, resolve (create if needed) each folder in the hierarchy
   const parentId = await resolveFolder(token, folders);

   // Then, fetch the source file — stream the body directly to Drive
   const srcRes = await fetch(url);
   if (!srcRes.ok) return { ok: false, error: `Fetch failed (${srcRes.status}): ${url}` };

   // Infer MIME type and size from the source response headers
   const mimeType = srcRes.headers.get("Content-Type")?.split(";")[0]?.trim() || "application/octet-stream";
   const rawLength = srcRes.headers.get("Content-Length");
   const size = rawLength ? Number(rawLength) : null;

   // Finally, stream the response body into a resumable Drive upload
   return uploadFile(token, {
      name: fileName,
      parentId,
      mimeType,
      body: srcRes.body,   // ReadableStream — never buffered
      size,
   });
};

// ─── STORAGE QUOTA ───────────────────────────────────────────────────────────

/**
 * Returns the user's Drive storage quota.
 * @returns {{ limit: number|null, usage: number, free: number|null }}
 *   limit — total storage in bytes (null if unlimited/Workspace pooled)
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
      limit,
      usage,
      free: limit != null ? limit - usage : null,
   };
};
