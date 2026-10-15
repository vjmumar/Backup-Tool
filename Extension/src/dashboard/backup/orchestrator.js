/**
 * BackupOrchestrator — orchestrator.js
 *
 * Shared backup logic for ALL destinations (local, Google Drive, …).
 * Walks the selected courses, builds the folder/file paths, and calls
 * writer.write(path, urlOrBlob) for every file.
 *
 * The writer is the only thing that changes between destinations:
 *   local   → sends chrome.downloads message to background
 *   drive   → uploads via Google Drive API
 *
 * writer interface:
 *   {
 *     write(path: string, url: string): Promise<{ ok: boolean, error?: string }>
 *   }
 *
 * Folder structure produced (same for every destination):
 *   Kajabi Backup/
 *     <course title>/
 *       cover.<ext>
 *       <category title>/
 *         thumbnail.<ext>
 *         category-info.txt           title + description
 *         01 - <lesson title>/
 *           content.txt               title + body
 *           media/
 *             <lesson title>.<ext>    video
 *             thumbnail.<ext>
 *             <original name>         downloads
 *       <empty category>/             folder only
 *
 * onProgress({ done, total, courseId, categoryId, lessonId, lessonTitle, fileName, status })
 *   status: "downloading" | "done" | "failed" | "lesson-done" | "lesson-failed" |
 *           "empty-done" | "empty-failed"
 *
 * onFileStatus(url, status, error?)
 *   Called after every file attempt so the caller can stamp the result directly
 *   onto the source model object. url is the original CDN/S3 url (not blob urls).
 *   status: "downloading" | "done" | "failed"
 */

class BackupOrchestrator {
   constructor({ courses, selected, empties, writer, rootFolder,
      onProgress, onDone, onError, onFileStatus, getFileStatus }) {
      // First, the course data and selection state from the dashboard
      this.courses = courses;
      this.selected = selected;
      this.empties = empties;

      // Then, the destination writer — swapped out per destination
      this.writer = writer;

      // Then, the root folder name (user-editable, defaults to "Kajabi Backup")
      this.rootFolder = (rootFolder || "Kajabi Backup").trim() || "Kajabi Backup";

      // Then, UI callbacks
      this.onProgress = onProgress || (() => { });
      this.onDone = onDone || (() => { });
      this.onError = onError || (() => { });

      // Then, per-file status callback and getter
      // onFileStatus(fileId, status) — called to update status in the dashboard
      // getFileStatus(fileId) → "done"|"failed"|"downloading"|undefined
      // Files already "done" are skipped (counted as saved) without re-downloading
      this.onFileStatus = onFileStatus || (() => { });
      this.getFileStatus = getFileStatus || (() => undefined);

      // Then, progress and summary counters
      this.total = 0;
      this.done = 0;
      this.saved = 0;
      this.failed = 0;

      // Per-lesson failure counter — used to determine lesson-done vs lesson-failed
      this._lessonFails = new Map();

      // Finally, start immediately
      this._run();
   }

   // ─── CANCEL ──────────────────────────────────────────────────────────────────

   cancel = () => {
      this.cancelled = true;
      // Resolve the race promise so _run exits immediately without waiting
      // for the current in-flight task to finish
      this._cancelResolve?.();
   };

   // ─── SAFE NAMES ──────────────────────────────────────────────────────────────

   /**
    * Sanitises a string for use as a file or folder name on Windows and macOS.
    * Strips forbidden characters, control characters, reserved names, and trailing dots/spaces.
    * @param {string} name
    */
   _safe = (name) => {
      let s = String(name || "Untitled")
         .replace(/[/\\:*?"<>|]/g, "-")
         .replace(/[\x00-\x1f]/g, "")
         .replace(/\.+$/, "")
         .replace(/\s+$/, "")
         .replace(/\s+/g, " ")
         .trim();
      if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(s)) s = `_${s}`;
      return s.slice(0, 200) || "Untitled";
   };

   /**
    * Infers a file extension from the URL path (before the query string).
    * Falls back to the given default when the URL has no recognisable extension.
    * @param {string} url
    * @param {string} fallback
    */
   _ext = (url, fallback = "") => {
      const base = url.split("?")[0].split("/").pop();
      const dot = base.lastIndexOf(".");
      return dot > 0 ? base.slice(dot).toLowerCase() : fallback;
   };

   // ─── PROGRESS ────────────────────────────────────────────────────────────────

   _report = (status, ctx) => {
      this.onProgress({ done: this.done, total: this.total, status, ...ctx });
   };

   // ─── WRITE HELPER ────────────────────────────────────────────────────────────

   /**
    * Calls writer.write and updates the counters and progress regardless of outcome.
    * A failed write does not stop the backup — it is counted and reported.
    *
    * For CDN/S3 urls, calls onFileStatus so the dashboard can stamp
    * file.downloadStatus directly on the matching model object.
    * Blob urls (content.txt etc.) are skipped — no model object to stamp.
    *
    * @param {string}  path       destination path
    * @param {string}  sourceUrl  original CDN/S3 url (may be a blob: url for text files)
    * @param {object}  ctx        { courseId, categoryId?, lessonId?, lessonTitle? }
    * @param {string}  fileName
    */
   _write = async (path, sourceUrl, ctx, fileName, fileId) => {
      const hasFileId = !!fileId;

      // Skip files already successfully downloaded in a previous run
      const currentStatus = hasFileId ? this.getFileStatus(fileId) : undefined;
      console.log("[write]", fileName, "| fileId:", fileId, "| status:", currentStatus);
      if (hasFileId && currentStatus === "done") {
         console.log("[orchestrator] skipping done file:", fileId);
         this.done++;
         this.saved++;
         this._report("done", { ...ctx, fileName });
         return;
      }

      if (hasFileId) this.onFileStatus(fileId, "downloading");
      this._report("downloading", { ...ctx, fileName });

      const result = await this.writer.write(path, sourceUrl);
      this.done++;

      if (result.ok) {
         this.saved++;
         if (hasFileId) this.onFileStatus(fileId, "done");
         this._report("done", { ...ctx, fileName });
      } else {
         this.failed++;
         if (hasFileId) this.onFileStatus(fileId, "failed", result.error);
         const failKey = ctx.lessonId || ctx.emptyId;
         if (failKey) {
            this._lessonFails.set(failKey, (this._lessonFails.get(failKey) || 0) + 1);
         }
         this._report("failed", { ...ctx, fileName, error: result.error });
      }
   };

   // ─── RUN ─────────────────────────────────────────────────────────────────────

   /**
    * Collects every file that needs to be written into a flat queue,
    * then drains the queue one at a time.
    * Each queue entry is a zero-arg async function that calls _write.
    */
   _run = async () => {
      try {
         // First, build the full flat list of write tasks
         const queue = this._buildQueue();
         this.total = queue.filter((t) => !t._isSentinel).length;
         this._report("downloading", { courseId: "", fileName: "" });

         // Set up a cancel promise — resolves immediately when cancel() is called
         const cancelPromise = new Promise((resolve) => { this._cancelResolve = resolve; });

         // Then, run every task sequentially — one file at a time
         // Sentinels run directly; file tasks race against the cancel signal
         for (const task of queue) {
            if (this.cancelled) break;
            if (task._isSentinel) { task(); continue; }
            await Promise.race([task(), cancelPromise]);
            if (this.cancelled) break;
         }

         // Finally, notify completion or cancellation
         this.onDone({ saved: this.saved, failed: this.failed, cancelled: this.cancelled });

      } catch (error) {
         console.error("[Course Backup] backup error", error);
         this.onError(error);
      }
   };

   /**
    * Builds the flat ordered list of write tasks without executing any of them.
    * Course cover → category thumbnail → lesson content.txt → lesson media files.
    * @returns {Array<() => Promise<void>>}
    */
   _buildQueue = () => {
      const tasks = [];

      const push = (path, url, ctx, fileName, fileId) => {
         tasks.push(() => this._write(path, url, ctx, fileName, fileId));
      };

      // Sentinel tasks fire after all files for a lesson — not counted in total
      const pushSentinel = (fn) => {
         const sentinel = fn;
         sentinel._isSentinel = true;
         tasks.push(sentinel);
      };

      const pushBlob = (path, text, ctx, fileName) => {
         tasks.push(async () => {
            const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
            const blobUrl = URL.createObjectURL(blob);
            await this._write(path, blobUrl, ctx, fileName, null);
            URL.revokeObjectURL(blobUrl);
         });
      };

      const rootPath = `${this.rootFolder}/`;

      for (const course of this.courses) {
         const coursePath = `${rootPath}${this._safe(course.text)}/`;
         const courseCtx = { courseId: course.id };

         // First, course cover image
         for (const file of (course.files || [])) {
            if (!file.url) continue;
            const fileName = `cover${this._ext(file.url, ".jpg")}`;
            push(`${coursePath}${fileName}`, file.url, courseCtx, fileName, file.fileId);
         }

         for (const category of course.categories) {
            const posts = category.posts || [];
            const isEmptySel = category.emptyId && this.selected.has(category.emptyId);
            const selPosts = posts.filter((p) => this.selected.has(p.id));
            if (!isEmptySel && !selPosts.length) continue;

            const catPath = `${coursePath}${this._safe(category.title)}/`;
            const catCtx = { courseId: course.id, categoryId: category.id };

            // Then, category thumbnail
            for (const file of (category.files || [])) {
               if (!file.url) continue;
               const fileName = `thumbnail${this._ext(file.url, ".jpg")}`;
               push(`${catPath}${fileName}`, file.url, catCtx, fileName, file.fileId);
            }

            // Then, category info — title and description if present
            if (category.title || category.description) {
               const text = `Title: ${category.title || ""}\n\nDescription:\n${category.description || ""}`;
               pushBlob(`${catPath}category-info.txt`, text, catCtx, "category-info.txt");
            }

            // For empty categories (no posts), write a placeholder so the folder is created
            if (isEmptySel && !selPosts.length) {
               pushBlob(`${catPath}empty-folder.txt`, "This folder was empty in Kajabi.", catCtx, "empty-folder.txt");
               pushSentinel(() => {
                  const hasFails = (this._lessonFails.get(category.emptyId) || 0) > 0;
                  this._report(hasFails ? "empty-failed" : "empty-done", { ...catCtx, emptyId: category.emptyId });
               });
            }

            // Then, each selected lesson
            let idx = 1;
            const pad = Math.max(2, String(selPosts.length).length);
            for (const post of selPosts) {
               const lessonName = `${String(idx++).padStart(pad, "0")} - ${this._safe(post.title)}`;
               const lessonPath = `${catPath}${lessonName}/`;
               const lessonCtx = { courseId: course.id, categoryId: category.id, lessonId: post.id, lessonTitle: post.title };

               // content.txt
               if (post.title || post.body) {
                  const text = `Title: ${post.title || ""}\n\nPublishStatus: ${post.publishing?.status || "unknown"}\n\nContent:\n${post.body || ""}`;
                  pushBlob(`${lessonPath}content.txt`, text, lessonCtx, "content.txt");
               }

               // media files
               for (const file of (post.files || [])) {
                  if (!file.url) continue;
                  let fileName;
                  if (file.type === "thumbnail") fileName = `thumbnail${this._ext(file.url, ".jpg")}`;
                  else if (file.type === "video") fileName = `${this._safe(post.title)}${this._ext(file.url, ".mp4")}`;
                  else fileName = this._safe(file.name || file.url.split("?")[0].split("/").pop() || "download");
                  push(`${lessonPath}media/${fileName}`, file.url, lessonCtx, fileName, file.fileId);
               }

               // Sentinel: fires after all files for this lesson are written
               pushSentinel(() => {
                  const hasFails = (this._lessonFails.get(post.id) || 0) > 0;
                  this._report(hasFails ? "lesson-failed" : "lesson-done", lessonCtx);
               });
            }
         }
      }

      return tasks;
   };
}
