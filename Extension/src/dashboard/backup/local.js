/**
 * local.js — local backup writer
 *
 * Implements the writer interface expected by BackupOrchestrator:
 *   { write(path, url): Promise<{ ok, error? }> }
 *
 * Before starting, checks whether Chrome's "Ask where to save each file"
 * setting is enabled. If it is, the backup is aborted and the user is
 * guided to turn it off.
 *
 * Each write sends a "download-file" message to background/download.js,
 * which calls chrome.downloads.download(). Chrome streams the file directly
 * from the CDN/S3 URL to disk — no JS memory buffering for remote files.
 * Blob URLs (used for content.txt) are the only exception.
 */

class LocalBackup {
   constructor({ courses, selected, empties, rootFolder,
      onProgress, onDone, onError, onFileStatus, getFileStatus }) {
      this.courses = courses;
      this.selected = selected;
      this.empties = empties;
      this.rootFolder = rootFolder;
      this.onProgress = onProgress || (() => { });
      this.onDone = onDone || (() => { });
      this.onError = onError || (() => { });
      this.onFileStatus = onFileStatus || (() => { });
      this.getFileStatus = getFileStatus || (() => undefined);
      this._run();
   }

   // ─── WRITER ──────────────────────────────────────────────────────────────────

   /**
    * The writer object passed to BackupOrchestrator.
    * Sends each file to the background service worker via chrome.runtime.sendMessage.
    * Retries up to 3 times on transient errors.
    */
   _writer = {
      write: async (path, url) => {
         const MAX_TRIES = 3;
         for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
            try {
               const result = await chrome.runtime.sendMessage({
                  type: "download-file",
                  url,
                  filename: path,
               });
               if (result?.ok) return { ok: true };

               const err = result?.error || "Unknown error";
               const retryable = /network|interrupted|timeout|crash/i.test(err);
               if (!retryable) return { ok: false, error: err };

            } catch (error) {
               // sendMessage can throw if the service worker is inactive
               if (attempt === MAX_TRIES - 1) return { ok: false, error: error.message };
            }
            // Wait before retrying, doubling each time
            await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
         }
         return { ok: false, error: "Failed after 3 attempts" };
      },
   };

   // ─── RUN ─────────────────────────────────────────────────────────────────────

   /**
    * Pre-flight check, then hands off to BackupOrchestrator with the local writer.
    */
   _run = async () => {
      try {
         // First, check if "Ask where to save each file" is enabled in Chrome
         const check = await chrome.runtime.sendMessage({ type: "check-download-setting" });
         if (check?.askEnabled) {
            const err = new Error(
               'Chrome is set to ask where to save each file. ' +
               'Turn off "Ask where to save each file before downloading" in ' +
               'chrome://settings/downloads, then click Start backup again.',
            );
            err.settingEnabled = true;
            return this.onError(err);
         }

         // Finally, run the backup using the shared orchestrator with the local writer
         this._orchestrator = new BackupOrchestrator({
            courses: this.courses,
            selected: this.selected,
            empties: this.empties,
            rootFolder: this.rootFolder,
            writer: this._writer,
            onFileStatus: this.onFileStatus,
            getFileStatus: this.getFileStatus,
            onProgress: this.onProgress,
            onDone: this.onDone,
            onError: this.onError,
         });

      } catch (error) {
         console.error("[Course Backup] local backup error", error);
         this.onError(error);
      }
   };

   cancel = () => this._orchestrator?.cancel();
}
