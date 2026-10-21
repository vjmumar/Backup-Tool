/**
 * download.js — local file download helpers
 * All chrome.downloads calls live here.
 *
 * Why this is in the background:
 *   chrome.downloads is only available in extension background/service worker
 *   contexts. The dashboard page sends a message here for each file it wants
 *   to save. Chrome streams the response directly to disk — JS memory never
 *   holds the file bytes for https:// URLs.
 */

/**
 * Downloads one file into the user's Downloads folder.
 *
 * @param {string} url      — the file URL (https:// or blob:)
 * @param {string} filename — relative path inside Downloads, e.g.
 *                            "Kajabi Backup/Course/Category/01 - Lesson/media/video.mp4"
 *                            Chrome creates every folder in the path automatically.
 * @returns {{ ok: boolean, error?: string }}
 */
export const downloadFile = (url, filename) =>
   new Promise((resolve) => {
      // First, start the download with saveAs:false so no dialog appears
      // (requires the user to have disabled "Ask where to save" in Chrome settings)
      chrome.downloads.download(
         { url, filename, saveAs: false, conflictAction: "overwrite" },
         (id) => {
            if (chrome.runtime.lastError || id === undefined) {
               return resolve({
                  ok: false,
                  error: chrome.runtime.lastError?.message || "Download failed to start",
               });
            }

            // Then, watch for the download to complete or fail
            const onChanged = (delta) => {
               if (delta.id !== id) return;
               if (delta.state?.current === "complete") {
                  chrome.downloads.onChanged.removeListener(onChanged);
                  resolve({ ok: true });
               } else if (delta.state?.current === "interrupted") {
                  chrome.downloads.onChanged.removeListener(onChanged);
                  resolve({ ok: false, error: delta.error?.current || "Interrupted" });
               }
               // Finally, ignore intermediate events (e.g. progress updates)
            };
            chrome.downloads.onChanged.addListener(onChanged);
         },
      );
   });

/**
 * Checks whether "Ask where to save each file before downloading" is enabled.
 *
 * Strategy: download a 1-byte blob and watch what Chrome does.
 *   - Completes immediately  → setting is OFF → { askEnabled: false }
 *   - USER_CANCELED          → setting is ON  → { askEnabled: true }
 *
 * The test file is removed from disk and the download shelf afterwards.
 *
 * @returns {{ askEnabled: boolean }}
 */
export const checkDownloadSetting = () =>
   new Promise((resolve) => {
      // First, create a minimal blob so we have something to "download"
      const blob = new Blob([" "], { type: "text/plain" });
      const blobUrl = URL.createObjectURL(blob);

      chrome.downloads.download(
         { url: blobUrl, filename: "Kajabi Backup/.setting-check", saveAs: false },
         (id) => {
            URL.revokeObjectURL(blobUrl);

            if (chrome.runtime.lastError || id === undefined) {
               // Cannot start at all — assume the setting is on to be safe
               return resolve({ askEnabled: true });
            }

            // Then, listen for the first meaningful state change
            const onChanged = (delta) => {
               if (delta.id !== id) return;

               const state = delta.state?.current;
               const error = delta.error?.current;
               if (!state) return; // intermediate update — keep waiting

               chrome.downloads.onChanged.removeListener(onChanged);

               // Finally, clean up: remove from shelf and from disk
               chrome.downloads.erase({ id });
               if (state === "complete") chrome.downloads.removeFile(id, () => { });

               if (state === "complete") {
                  resolve({ askEnabled: false });
               } else if (state === "interrupted" && error === "USER_CANCELED") {
                  resolve({ askEnabled: true });
               } else {
                  // Any other interruption (network error etc.) — assume off
                  // and let real downloads surface their own errors
                  resolve({ askEnabled: false });
               }
            };
            chrome.downloads.onChanged.addListener(onChanged);
         },
      );
   });

/**
 * Cancels an in-progress download by its Chrome download ID.
 * Used when the user clicks Cancel during a local backup.
 * @param {number} id  Chrome download ID
 * @returns {{ ok: boolean }}
 */
export const cancelDownload = (id) =>
   new Promise((resolve) => {
      chrome.downloads.cancel(id, () => resolve({ ok: true }));
   });
