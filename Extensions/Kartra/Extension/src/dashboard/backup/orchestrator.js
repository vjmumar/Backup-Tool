/**
 * KartraOrchestrator — orchestrator.js
 *
 * Walks selected memberships, builds the folder/file paths, and calls
 * writer.write(path, url) for every file.
 *
 * Kartra structure:
 *   membership
 *     categories[]
 *       posts[]          — posts directly in the category
 *       subcategories[]
 *         posts[]        — posts inside a subcategory
 *
 * All posts have the same shape regardless of where they sit:
 *   post._id, post.name, post.data.files[], post.data.blocks[]
 *
 * Folder structure produced:
 *   <Membership name>/
 *     00 Welcome/
 *       01 Home/
 *         content.txt
 *         lessonFiles/video-1.mp4
 *         lessonFiles/image-1.png
 *         downloads/filename.pdf
 *     01 <Category>/
 *       01 <Post>/               — direct category post
 *         content.txt
 *         lessonFiles/...
 *       02 <Subcategory>/
 *         01 <Post>/
 *           content.txt
 *           lessonFiles/...
 *
 * writer interface:
 *   { write(path: string, url: string): Promise<{ ok: boolean, error?: string }> }
 *
 * onProgress({ done, total, status, courseId, categoryId, lessonId, lessonTitle, fileName })
 * onFileStatus(fileId, status, error?)
 * getFileStatus(fileId) → "done"|"failed"|"downloading"|undefined
 */

class KartraOrchestrator {
   constructor({
      memberships, selected, writer, rootFolder,
      onProgress, onDone, onError, onFileStatus, getFileStatus,
      resumeAtPostId, retryPostId,
   }) {
      this.memberships = memberships;
      this.selected = selected;
      this.writer = writer;
      this.rootFolder = (rootFolder || "Kartra Backup").trim() || "Kartra Backup";
      this.onProgress = onProgress || (() => { });
      this.onDone = onDone || (() => { });
      this.onError = onError || (() => { });
      this.onFileStatus = onFileStatus || (() => { });
      this.getFileStatus = getFileStatus || (() => undefined);
      this.resumeAtPostId = resumeAtPostId || null;
      this.retryPostId = retryPostId || null;

      this.total = 0;
      this.done = 0;
      this.saved = 0;
      this.failed = 0;
      this._lessonFails = new Map();

      this._run();
   }

   // ─── CANCEL ───────────────────────────────────────────────────────────────

   cancel = () => {
      this.cancelled = true;
      this._cancelResolve?.();
   };

   // ─── SAFE NAMES ───────────────────────────────────────────────────────────

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

   _folderName = (name) => this._safe(name);

   _ext = (url, fallback = "") => {
      const base = url.split("?")[0].split("/").pop();
      const dot = base.lastIndexOf(".");
      return dot > 0 ? base.slice(dot).toLowerCase() : fallback;
   };

   // ─── PROGRESS ─────────────────────────────────────────────────────────────

   _report = (status, ctx) => {
      this.onProgress({ done: this.done, total: this.total, status, ...ctx });
   };

   // ─── WRITE HELPER ─────────────────────────────────────────────────────────

   _write = async (path, sourceUrl, ctx, fileName, fileId) => {
      const hasFileId = !!fileId;

      const currentStatus = hasFileId ? this.getFileStatus(fileId) : undefined;
      // Already saved — skip silently (not counted in total, so don't touch done)
      if (hasFileId && currentStatus === "done") {
         this.saved++;
         return;
      }
      // Per-post retry: skip failed files that belong to a different post
      // (not counted in total either, so don't touch done)
      if (hasFileId && this.retryPostId && currentStatus === "failed" && ctx.lessonId !== this.retryPostId) {
         return;
      }

      if (hasFileId) this.onFileStatus(fileId, "downloading");
      this._report("downloading", { ...ctx, fileName });

      const result = await this.writer.write(path, sourceUrl);

      // Only count CDN files (hasFileId) in done/saved/failed — blob writes
      // like content.txt have no fileId and are not counted in this.total.
      if (hasFileId) this.done++;

      if (result.ok) {
         if (hasFileId) this.saved++;
         if (hasFileId) this.onFileStatus(fileId, "done");
         this._report("done", { ...ctx, fileName });
      } else {
         if (hasFileId) this.failed++;
         if (hasFileId) this.onFileStatus(fileId, "failed", result.error);
         const failKey = ctx.lessonId;
         if (failKey) this._lessonFails.set(failKey, (this._lessonFails.get(failKey) || 0) + 1);
         this._report("failed", { ...ctx, fileName, error: result.error });
      }
   };

   // ─── CONTENT TXT ──────────────────────────────────────────────────────────

   /**
    * Builds a plain-text content.txt from the post's blocks.
    * Kartra posts have blocks[] instead of a body string.
    * Text blocks → "text1: ...", embed blocks → "text1: embed: <url>".
    */
   _buildContentTxt = (title, blocks) => {
      let textIdx = 0;
      const lines = [`Title: ${title || ""}`, ""];
      (blocks || []).forEach((block) => {
         if (block.type === "text" && block.text) {
            textIdx++;
            lines.push(`text${textIdx}: ${block.text}`);
         } else if (block.type === "embed" && block.url) {
            textIdx++;
            lines.push(`text${textIdx}: embed: ${block.url}`);
         }
      });
      return lines.join("\n");
   };

   // ─── RESUME ───────────────────────────────────────────────────────────────

   /**
    * Walks memberships in queue order and returns the position of the first
    * file whose status is "failed". Returns null when nothing failed.
    */
   _findResumePoint = () => {
      for (const membership of this.memberships) {
         for (const cat of membership.categories) {
            const allPosts = [
               ...(cat.posts || []),
               ...(cat.subcategories || []).flatMap((s) => s.posts || []),
            ].filter((p) => this.selected.has(p._id));

            for (const post of allPosts) {
               for (const file of (post.data?.files || [])) {
                  const key = file.fileId;
                  if (key && this.getFileStatus(key) === "failed") {
                     return { membershipId: membership.id, catId: cat._id, postId: post._id };
                  }
               }
            }
         }
      }
      return null;
   };

   // ─── RUN ──────────────────────────────────────────────────────────────────

   _run = async () => {
      try {
         const queue = this._buildQueue();
         // Count only tasks that _write will actually attempt (not already "done"
         // and not skipped by retryPostId), so the progress bar reflects real work.
         this.total = queue.filter((t) => {
            if (t._isSentinel) return false;
            const fid = t._fileId;
            if (!fid) return false;
            const status = this.getFileStatus(fid);
            if (status === "done") return false;
            if (this.retryPostId && status === "failed" && t._lessonId !== this.retryPostId) return false;
            return true;
         }).length;
         this._report("downloading", { courseId: "", fileName: "" });

         const cancelPromise = new Promise((resolve) => { this._cancelResolve = resolve; });

         for (const task of queue) {
            if (this.cancelled) break;
            if (task._isSentinel) { task(); continue; }
            await Promise.race([task(), cancelPromise]);
            if (this.cancelled) break;
         }

         this.onDone({ saved: this.saved, failed: this.failed, cancelled: this.cancelled });
      } catch (error) {
         console.error("[Kartra Backup] orchestrator error", error);
         this.onError(error);
      }
   };

   // ─── BUILD QUEUE ──────────────────────────────────────────────────────────

   _buildQueue = () => {
      const tasks = [];

      const push = (path, url, ctx, fileName, fileId) => {
         const t = () => this._write(path, url, ctx, fileName, fileId);
         t._fileId = fileId;
         t._lessonId = ctx.lessonId;
         tasks.push(t);
      };

      const pushBlob = (path, text, ctx, fileName) =>
         tasks.push(async () => {
            const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
            const blobUrl = URL.createObjectURL(blob);
            await this._write(path, blobUrl, ctx, fileName, null);
            URL.revokeObjectURL(blobUrl);
         });

      const pushSentinel = (fn) => {
         const s = fn;
         s._isSentinel = true;
         tasks.push(s);
      };

      // Find resume point
      let rp = null;
      if (this.resumeAtPostId) {
         outer: for (const membership of this.memberships) {
            for (const cat of membership.categories) {
               const allPosts = [
                  ...(cat.posts || []),
                  ...(cat.subcategories || []).flatMap((s) => s.posts || []),
               ];
               for (const post of allPosts) {
                  if (post._id === this.resumeAtPostId) {
                     rp = { membershipId: membership.id, catId: cat._id, postId: post._id };
                     break outer;
                  }
               }
            }
         }
      } else {
         rp = this._findResumePoint();
      }

      const root = `${this.rootFolder}/`;

      for (const membership of this.memberships) {
         const memName = membership.attributes?.name || "Untitled membership";
         const memPath = `${root}${this._safe(memName)}/`;
         const memCtx = { courseId: membership.id };

         // Resume check at membership level — skip if entirely before resume point
         const isResumeMem = rp && rp.membershipId === membership.id;
         const beforeResumeMem = rp && !isResumeMem && (() => {
            for (const m of this.memberships) {
               if (m.id === rp.membershipId) return false;
               if (m.id === membership.id) return true;
            }
            return false;
         })();
         if (beforeResumeMem) continue;

         for (const cat of membership.categories) {
            const isWelcome = cat.id === 0;
            const catFolder = this._folderName(cat.name || "Category");
            const catPath = `${memPath}${catFolder}/`;
            const catCtx = { courseId: membership.id, categoryId: cat._id };

            // Collect all selected posts in this category (direct + subcategory)
            const directPosts = (cat.posts || []).filter((p) => this.selected.has(p._id));
            const subPosts = (cat.subcategories || []).flatMap((s) =>
               (s.posts || []).filter((p) => this.selected.has(p._id)));
            if (!directPosts.length && !subPosts.length) continue;

            // Resume check at category level
            const isResumeCat = rp && rp.catId === cat._id;
            const beforeResumeCat = rp && !isResumeCat && (() => {
               for (const m of this.memberships) {
                  if (m.id !== rp.membershipId && m.id !== membership.id) continue;
                  for (const c of m.categories) {
                     if (c._id === rp.catId) return false;
                     if (c._id === cat._id) return true;
                  }
               }
               return false;
            })();
            if (beforeResumeCat) continue;

            // ── Direct posts ──────────────────────────────────────────────────
            // passedResumePost is shared across direct posts AND subcategories so
            // once the resume post is found in any section, all subsequent posts
            // (including those in later subcategories) are included.
            let passedResumePost = !rp || !isResumeCat || rp.postId === null;

            if (directPosts.length) {
               for (const post of directPosts) {
                  if (!passedResumePost && post._id === rp.postId) passedResumePost = true;
                  if (!passedResumePost) continue;

                  const postFolder = this._folderName(post.name || "Post");
                  const postPath = `${catPath}${postFolder}/`;
                  const postCtx = { courseId: membership.id, categoryId: cat._id, lessonId: post._id, lessonTitle: post.name };

                  this._pushPostTasks({ push, pushBlob, pushSentinel, post, postPath, postCtx });
               }
            }

            // ── Subcategories ─────────────────────────────────────────────────
            for (const sub of (cat.subcategories || [])) {
               const selSubPosts = (sub.posts || []).filter((p) => this.selected.has(p._id));
               if (!selSubPosts.length) continue;

               const subFolder = this._folderName(sub.name || "Subcategory");
               const subPath = `${catPath}${subFolder}/`;

               for (const post of selSubPosts) {
                  if (!passedResumePost && post._id === rp.postId) passedResumePost = true;
                  if (!passedResumePost) continue;

                  const postFolder = this._folderName(post.name || "Post");
                  const postPath = `${subPath}${postFolder}/`;
                  const postCtx = { courseId: membership.id, categoryId: sub._id, lessonId: post._id, lessonTitle: post.name };

                  this._pushPostTasks({ push, pushBlob, pushSentinel, post, postPath, postCtx });
               }
            }
         }
      }

      return tasks;
   };

   // ─── POST TASKS ───────────────────────────────────────────────────────────

   /**
    * Pushes all write tasks for one post (files + content.txt sentinel).
    * content.txt is written after all files for the post are done.
    */
   _pushPostTasks = ({ push, pushBlob, pushSentinel, post, postPath, postCtx }) => {
      // All file types (video, image, audio, download) go through the same push()
      // The scraper returns direct URLs for all types — no resolution step needed.
      for (const file of (post.data?.files || [])) {
         if (!file.url || !file.path) continue;
         // Use the real filename from file.name when available; fall back to
         // the path basename. Preserve the extension from the URL if file.name
         // has none (e.g. scraper sets name without extension).
         let fileName;
         if (file.name) {
            const safeName = this._safe(file.name);
            const hasExt = safeName.includes(".");
            fileName = hasExt ? safeName : safeName + this._ext(file.url);
         } else {
            fileName = file.path.split("/").pop();
         }
         const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : "";
         push(`${postPath}${dir}${fileName}`, file.url, postCtx, fileName, file.fileId || null);
      }

      // Sentinel — writes content.txt after all files for this post complete
      pushSentinel(async () => {
         const hasFails = (this._lessonFails.get(post._id) || 0) > 0;

         const contentTxt = this._buildContentTxt(post.name || "Post", post.data?.blocks || []);
         const blob = new Blob([contentTxt], { type: "text/plain;charset=utf-8" });
         const blobUrl = URL.createObjectURL(blob);
         await this._write(`${postPath}content.txt`, blobUrl, postCtx, "content.txt", null);
         URL.revokeObjectURL(blobUrl);

         this._report(hasFails ? "lesson-failed" : "lesson-done", postCtx);
      });
   };
}
