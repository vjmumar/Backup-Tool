/**
 * drive-backup.js — Google Drive backup writer
 *
 * Implements the writer interface expected by BackupOrchestrator:
 *   { write(path, url): Promise<{ ok, error? }> }
 *
 * Each write sends a "drive-upload-file" message to background/drive.js,
 * which resolves the folder hierarchy in Drive (creating any missing folders),
 * then streams the source URL response body directly into a resumable Drive
 * upload — no JS-side buffering of file bytes.
 *
 * Path format produced by BackupOrchestrator:
 *   "Kajabi Backup/Course/Category/01 - Lesson/media/video.mp4"
 *   → Drive: My Drive > Kajabi Backup > Course > … > video.mp4
 */

class DriveBackup {
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
    *
    * Sends each file to background/drive.js via "drive-upload-file".
    * The background resolves the Drive folder path, fetches the source URL,
    * and streams the response body into a resumable Drive upload session.
    *
    * Retries up to 3 times on transient errors (rate limits, server errors).
    */
   _writer = {
      write: async (path, url) => {
         const MAX_TRIES = 3;

         for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
            try {
               const result = await chrome.runtime.sendMessage({
                  type: "drive-upload-file",
                  path,
                  url,
               });

               if (result?.ok) return { ok: true };

               const err = result?.error || "Unknown Drive error";
               const retryable = /429|500|503|rate.?limit|timeout|network/i.test(err);
               if (!retryable || attempt === MAX_TRIES - 1) {
                  return { ok: false, error: err };
               }

            } catch (error) {
               // sendMessage throws if the service worker is inactive
               if (attempt === MAX_TRIES - 1) {
                  return { ok: false, error: error.message };
               }
            }

            // Exponential back-off before retrying
            await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
         }

         return { ok: false, error: "Failed after 3 attempts" };
      },
   };

   // ─── RUN ─────────────────────────────────────────────────────────────────────

   _run = async () => {
      try {
         // First, verify Drive is connected before starting
         const state = await chrome.runtime.sendMessage({ type: "get-drive-state" });
         if (!state?.connected) {
            return this.onError(
               new Error("Google Drive is not connected. Click the Drive option and sign in, then try again."),
            );
         }

         // Then, run the backup using the shared orchestrator with the Drive writer
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
         console.error("[Course Backup] Drive backup error", error);
         this.onError(error);
      }
   };

   cancel = () => this._orchestrator?.cancel();
}
