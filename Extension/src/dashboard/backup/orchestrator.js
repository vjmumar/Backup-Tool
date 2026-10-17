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
      onProgress, onDone, onError, onFileStatus, getFileStatus,
      resumeAtPostId }) {
      // First, the course data and selection state from the dashboard
      this.courses = courses;
      this.selected = selected;
      this.empties = empties;

      // Then, the destination writer — swapped out per destination
      this.writer = writer;

      // Then, the root folder name (user-editable, defaults to "Course Backup")
      this.rootFolder = (rootFolder || "Course Backup").trim() || "Course Backup";

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

      // Optional: when set, _buildQueue jumps directly to this post and skips
      // _findResumePoint entirely. Used by the per-lesson retry button so only
      // the retried lesson runs, not everything from the first failed file.
      this.resumeAtPostId = resumeAtPostId || null;

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

   // ─── RESUME POINT ────────────────────────────────────────────────────────────

   /**
    * Walks courses/categories/posts in the same order _buildQueue uses and
    * returns the position of the first file whose status is "failed".
    *
    * Returned shape:
    *   null                                — nothing failed, start from scratch
    *   { courseId, categoryId, postId: null } — failed file is a category-level
    *                                            file (thumbnail etc.)
    *   { courseId, categoryId, postId }    — failed file is inside a lesson
    *
    * "First" means first in queue order, so skipping everything before it is safe.
    */
   _findResumePoint = () => {
      for (const course of this.courses) {
         for (const category of course.categories) {
            const posts = category.posts || [];
            const selPosts = posts.filter((p) => this.selected.has(p.id));
            const isEmptySel = category.emptyId && this.selected.has(category.emptyId);
            if (!isEmptySel && !selPosts.length) continue;

            // Check category-level files first (thumbnail etc.)
            for (const file of (category.files || [])) {
               if (file.fileId && this.getFileStatus(file.fileId) === "failed") {
                  return { courseId: course.id, categoryId: category.id, postId: null };
               }
            }

            // Then check each lesson's files in order
            for (const post of selPosts) {
               for (const file of (post.files || [])) {
                  if (file.fileId && this.getFileStatus(file.fileId) === "failed") {
                     return { courseId: course.id, categoryId: category.id, postId: post.id };
                  }
               }
            }
         }
      }
      return null; // nothing failed — normal fresh run
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
    *
    * On resume, _findResumePoint() locates the first failed file in queue order.
    * Everything before that point is skipped at the task-group level:
    *   - Courses whose files are all done → skipped entirely
    *   - Categories before the resume category → skipped entirely
    *   - The resume category → header (thumbnail + category-info.txt) always
    *     re-runs so the folder exists, then lessons before the resume lesson
    *     are skipped, resume lesson and everything after runs normally
    *   - Categories after the resume category → run fully from the top
    *     (they haven't been touched yet)
    *
    * Individual _write calls still check getFileStatus so any "done" files
    * inside the resumed lesson are skipped without re-downloading.
    *
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

      // Pre-pass: find where the previous run broke off.
      // resumeAtPostId is set by the per-lesson retry button — it means "jump
      // straight to this post, skip _findResumePoint". Otherwise fall back to
      // scanning for the first failed file in queue order.
      // null means no failures → fresh run, include everything.
      let rp = null;
      if (this.resumeAtPostId) {
         // Find which course + category owns this post so we can apply the
         // same skip logic as a normal resume point.
         outer: for (const course of this.courses) {
            for (const category of course.categories) {
               const selPosts = (category.posts || []).filter((p) => this.selected.has(p.id));
               for (const post of selPosts) {
                  if (String(post.id) === String(this.resumeAtPostId)) {
                     rp = { courseId: course.id, categoryId: category.id, postId: post.id };
                     break outer;
                  }
               }
            }
         }
      } else {
         rp = this._findResumePoint();
      }

      /**
       * Returns true when every CDN file in a list is already "done".
       * Used to decide whether a course cover or category can be skipped.
       */
      const allDone = (files = []) =>
         files.length > 0 &&
         files.every((f) => !f.url || !f.fileId || this.getFileStatus(f.fileId) === "done");

      const rootPath = `${this.rootFolder}/`;

      for (const course of this.courses) {
         const coursePath = `${rootPath}${this._safe(course.text)}/`;
         const courseCtx = { courseId: course.id };

         // ── Resume check: is this course at or after the resume point? ──────
         // If we have a resume point and this course comes before it, its
         // cover files are all "done" — skip the cover and move to categories.
         const isResumeCourse = rp && course.id === rp.courseId;
         const beforeResumeCourse = rp && !isResumeCourse &&
            // courses are ordered; any course seen before we hit rp.courseId is before it
            (() => {
               for (const c of this.courses) {
                  if (c.id === rp.courseId) return false;
                  if (c.id === course.id) return true;
               }
               return false;
            })();

         // Course cover image — skip only when all covers are done
         if (!beforeResumeCourse || !allDone(course.files || [])) {
            for (const file of (course.files || [])) {
               if (!file.url) continue;
               const fileName = `cover${this._ext(file.url, ".jpg")}`;
               push(`${coursePath}${fileName}`, file.url, courseCtx, fileName, file.fileId);
            }
         }

         // Track whether we have passed the resume category inside this course
         let passedResumeCategory = !rp; // true from the start on a fresh run

         for (const category of course.categories) {
            const posts = category.posts || [];
            const isEmptySel = category.emptyId && this.selected.has(category.emptyId);
            const selPosts = posts.filter((p) => this.selected.has(p.id));
            if (!isEmptySel && !selPosts.length) continue;

            const catPath = `${coursePath}${this._safe(category.title)}/`;
            const catCtx = { courseId: course.id, categoryId: category.id };

            const isResumeCat = rp && course.id === rp.courseId && category.id === rp.categoryId;

            if (isResumeCat) passedResumeCategory = true;

            // ── Skip entire category when it comes before the resume category ──
            // All its files are already "done" — nothing to write here.
            if (!passedResumeCategory) continue;

            // ── Category header ───────────────────────────────────────────────
            // Always written for the resume category and every category after it.
            // This ensures the folder exists even on a fresh resume.

            // Category thumbnail
            for (const file of (category.files || [])) {
               if (!file.url) continue;
               const fileName = `thumbnail${this._ext(file.url, ".jpg")}`;
               push(`${catPath}${fileName}`, file.url, catCtx, fileName, file.fileId);
            }

            // Category info
            if (category.title || category.description) {
               const text = `Title: ${category.title || ""}\n\nDescription:\n${category.description || ""}`;
               pushBlob(`${catPath}category-info.txt`, text, catCtx, "category-info.txt");
            }

            // Empty category placeholder
            if (isEmptySel && !selPosts.length) {
               pushBlob(`${catPath}empty-folder.txt`, "This folder was empty in Kajabi.", catCtx, "empty-folder.txt");
               pushSentinel(() => {
                  const hasFails = (this._lessonFails.get(category.emptyId) || 0) > 0;
                  this._report(hasFails ? "empty-failed" : "empty-done", { ...catCtx, emptyId: category.emptyId });
               });
            }

            // ── Lessons ───────────────────────────────────────────────────────
            // Inside the resume category, skip lessons that come before the
            // resume post — they are fully done. From the resume post onward,
            // run everything normally (_write skips individual done files).

            let idx = 1;
            const pad = Math.max(2, String(selPosts.length).length);
            let passedResumeLesson = !isResumeCat || rp.postId === null;
            // postId === null means the failure was a category-level file,
            // so all lessons in this category still need to run.

            for (const post of selPosts) {
               const lessonName = `${String(idx++).padStart(pad, "0")} - ${this._safe(post.title)}`;
               const lessonPath = `${catPath}${lessonName}/`;
               const lessonCtx = { courseId: course.id, categoryId: category.id, lessonId: post.id, lessonTitle: post.title };

               if (!passedResumeLesson && post.id === rp.postId) passedResumeLesson = true;

               // Skip lessons that are entirely before the resume post
               if (!passedResumeLesson) continue;

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
