/**
 * background.js — service worker entry point
 *
 * This file is the message router only.
 * Every piece of real logic lives in its own module:
 *
 *   db.js              IndexedDB open + helpers
 *   handoff.js         receive the scan from the Kajabi page and save it
 *   navigation.js      open the dashboard tab, open Chrome settings
 *   download.js        chrome.downloads — stream files to disk
 *   drive.js           Google Drive OAuth + upload
 *   api/config.js      BASE_URL + shared fetch wrapper + token helpers
 *   api/auth.js        sign-up, sign-in, change-password, me
 *   api/platform.js    platform connection CRUD
 *   api/scrapers.js     fetch raw scraper script by name (auth required)
 *   api/appConfig.js   fetch server-side config (Drive credentials etc.)
 */

import { startHandoff, saveCourse, endHandoff } from "./handoff.js";
import { openDashboard, openChromeSettings } from "./navigation.js";
import { downloadFile, checkDownloadSetting } from "./download.js";
import { connectDrive, disconnectDrive, getDriveState, driveUploadFile, getDriveStorageQuota } from "./drive.js";
import { saveToken, clearToken, loadToken } from "./api/config.js";
import { signIn, changePassword, getMe, updateEmail, deleteAccount, forgotPassword } from "./api/auth.js";
import { getConnections, createConnection, updateConnection, deleteConnection } from "./api/platform.js";
import { getScraperScript } from "./api/scrapers.js";
import { getPlatforms } from "./api/platforms.js";
import { getAppConfig } from "./api/appConfig.js";

// ─── ALLOWED ORIGINS ─────────────────────────────────────────────────────────

const KAJABI_ORIGIN = "https://app.kajabi.com/admin/";
const DASHBOARD_ORIGIN = chrome.runtime.getURL("src/dashboard/");
const POPUP_ORIGIN = chrome.runtime.getURL("src/popup/");

const isAllowed = (sender) =>
   sender.id === chrome.runtime.id &&
   sender.url &&
   (sender.url.startsWith(KAJABI_ORIGIN) ||
      sender.url.startsWith(DASHBOARD_ORIGIN) ||
      sender.url.startsWith(POPUP_ORIGIN));

// ─── MESSAGE ROUTER ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
   // First, only accept messages from our own extension pages
   if (!isAllowed(sender)) return;

   // Then, look up the job for this message type
   const jobs = {
      // Scan handoff — Kajabi page → background
      "handoff-start": () => startHandoff(),
      "handoff-course": () => saveCourse(message.index, message.course),
      "handoff-end": () => endHandoff(message.count),

      // Navigation
      "open-dashboard": () => openDashboard(),
      "open-chrome-settings": () => openChromeSettings(),

      // Local downloads — dashboard → background
      "download-file": () => downloadFile(message.url, message.filename),
      "check-download-setting": () => checkDownloadSetting(),

      // Google Drive — dashboard → background
      "connect-drive": () => connectDrive(),
      "disconnect-drive": () => disconnectDrive(),
      "get-drive-state": () => getDriveState(),
      "get-drive-storage-quota": () => getDriveStorageQuota(),
      "drive-upload-file": () => driveUploadFile({ path: message.path, url: message.url }),

      // Auth — popup → background → API
      "auth-sign-in": async () => {
         const result = await signIn({ email: message.email, password: message.password });
         // Persist the token on success so every subsequent authed call works immediately
         if (result.ok && result.token) await saveToken(result.token);
         return result;
      },
      "auth-change-password": () => changePassword({
         currentPassword: message.currentPassword,
         newPassword: message.newPassword,
      }),
      "auth-get-me": () => getMe(),
      "auth-update-email": () => updateEmail({ email: message.email }),
      "auth-delete-account": async () => {
         const result = await deleteAccount();
         if (result.ok) await clearToken();
         return result;
      },
      "auth-sign-out": async () => {
         await clearToken();
         return { ok: true };
      },
      "auth-get-token": async () => {
         const token = await loadToken();
         return { ok: true, token };
      },
      "auth-forgot-password": () => forgotPassword({ email: message.email }),

      // Platform connections — popup/dashboard → background → API
      "platform-get-connections": () => getConnections(),
      "platform-create-connection": () => createConnection({
         platform: message.platform,
         lockId: message.lockId,
      }),
      "platform-update-connection": () => updateConnection({
         id: message.id,
         platform: message.platform,
         lockId: message.lockId,
      }),
      "platform-delete-connection": () => deleteConnection({ id: message.id }),

      // Connection check — content script → background
      // Reads all connections for the signed-in user and checks whether
      // any lockId matches the platform account_id from the page.
      "check-connection": async () => {
         const { accountId } = message;
         if (!accountId) return { ok: false, error: "No account ID provided." };

         const result = await getConnections();
         if (!result.ok) return { ok: false, error: result.error || "Could not fetch connections." };

         const match = result.connections.some((c) => String(c.lockId) === String(accountId));
         return { ok: true, allowed: match };
      },

      // Links — popup → background → API (no auth required)
      // purchaseLink now comes from GET /api/config — no separate links endpoint.
      "get-links": () => getAppConfig(),

      // Scrapers — content script → background → API
      // Fetches the raw script text for a named scraper.
      // The script is returned as-is and eval'd in the MAIN world by content.js.
      "get-scraper": () => getScraperScript(message.name),

      // Platforms — content script → background → API
      // Fetches the list of platform descriptors so platformChecker.js can build
      // platform objects without any platform-specific code in the extension.
      "get-platforms": () => getPlatforms(),

      // App config — content script → background → API (no auth required)
      // Returns isMaintenance, version, downloadLink, and googleDrive credentials.
      // Also injects the installed extension version from the manifest so MAIN
      // world content scripts can do the version check without chrome.runtime access.
      // Checked before scraping and before adding a platform connection.
      // Fails open on network error so users are not blocked by a flaky connection.
      "get-app-config": async () => {
         const config = await getAppConfig();
         return {
            ...config,
            extensionVersion: chrome.runtime.getManifest().version,
         };
      },
   };

   const job = jobs[message.type];
   if (!job) return;

   // Finally, run the job and send back { ok, error?, ...data }
   job().then(
      (data) => sendResponse({ ok: true, ...(data || {}) }),
      (error) => sendResponse({ ok: false, error: String(error?.message || error) }),
   );

   // Return true so Chrome keeps the message channel open for the async response
   return true;
});
