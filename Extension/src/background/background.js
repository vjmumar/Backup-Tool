/**
 * background.js — service worker entry point
 *
 * This file is the message router only.
 * Every piece of real logic lives in its own module:
 *
 *   db.js          IndexedDB open + helpers
 *   handoff.js     receive the scan from the Kajabi page and save it
 *   navigation.js  open the dashboard tab, open Chrome settings
 *   download.js    chrome.downloads — stream files to disk
 *   drive.js       Google Drive OAuth + upload (placeholder)
 */

import { startHandoff, saveCourse, endHandoff } from "./handoff.js";
import { openDashboard, openChromeSettings } from "./navigation.js";
import { downloadFile, checkDownloadSetting } from "./download.js";
import { connectDrive, disconnectDrive, getDriveState, driveUploadFile, getDriveStorageQuota } from "./drive.js";

// ─── ALLOWED ORIGINS ─────────────────────────────────────────────────────────

const KAJABI_ORIGIN = "https://app.kajabi.com/admin/";
const DASHBOARD_ORIGIN = chrome.runtime.getURL("src/dashboard/");

const isAllowed = (sender) =>
   sender.id === chrome.runtime.id &&
   sender.url &&
   (sender.url.startsWith(KAJABI_ORIGIN) || sender.url.startsWith(DASHBOARD_ORIGIN));

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
