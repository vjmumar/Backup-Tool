/**
 * KartraOrchestrator — orchestrator.js
 *
 * Walks selected memberships, builds the folder/file paths per the Kartra
 * data spec, and calls writer.write(path, url) for every file.
 *
 * Folder structure produced:
 *   <Membership name>/
 *     00 Welcome/
 *       01 Home/
 *         lesson.html
 *         content.txt
 *         lessonFiles/video-1.mp4
 *         lessonFiles/image-1.png
 *         downloads/filename.pdf
 *     01 <Category>/
 *       01 <Subcategory>/          ← only when category has subcategories
 *         01 <Post>/
 *           lesson.html
 *           content.txt
 *           lessonFiles/...
 *           downloads/...
 *       02 <Post>/                 ← posts directly in category (no subcategory)
 *
 * Key Kartra rules:
 *   - categories[0] is always Welcome (id: 0) — rendered as "00 Welcome"
 *   - A category has either posts OR subcategories (render both just in case)
 *   - Duplicate post names in same folder are disambiguated by their number prefix
 *   - file.url for video is a Kartra player page — must be resolved to MP4 first
 *   - lesson.html and content.txt are written AFTER all media files for a post
 *   - admin_login_url is never present (stripped by scraper.js)
 *
 * writer interface:
 *   { write(path: string, url: string): Promise<{ ok: boolean, error?: string }> }
 *
 * onProgress({ done, total, status, courseId, categoryId, lessonId, lessonTitle, fileName })
 * onFileStatus(filePath, status, error?)
 * getFileStatus(filePath) → "done"|"failed"|"downloading"|undefined
 */

class KartraOrchestrator {
   constructor({
      memberships, selected, writer, rootFolder,
      onProgress, onDone, onError, onFileStatus, getFileStatus,
      resumeAtPostId,
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
         .replace(/[/\\:*?"<>|]+/g, "-")
         .replace(/[\x00-\x1f]/g, "")
         .replace(/[-.\s]+$/, "")
         .replace(/\s+/g, " ")
         .trim();
      if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(s)) s = `_${s}`;
      return s.slice(0, 120) || "Untitled";
   };

   _folderName = (index, name) =>
      `${String(index).padStart(2, "0")} ${this._safe(name)}`;

   _ext = (url, fallback = "") => {
      const base = url.split("?")[0].split("/").pop();
      const dot = base.lastIndexOf(".");
      return dot > 0 ? base.slice(dot).toLowerCase() : fallback;
   };

   // ─── VIDEO RESOLUTION ─────────────────────────────────────────────────────

   /**
    * Fetches the Kartra player page and extracts the real MP4 URL.
    * Returns { url, name, duration } or null if not found.
    */
   _resolveVideo = async (playerUrl) => {
      try {
         const html = await fetch(playerUrl).then((r) => r.text());
         const src = html.match(/sources:\s*\[\s*\{\s*src:\s*['"]([^'"]+)['"]/);
         if (!src) return null;
         const name = html.match(/name:\s*['"]([^'"]+)['"]\s*,\s*mediaid/)?.[1] || "";
         const duration = Number(html.match(/duration:\s*(\d+)/)?.[1]) || 0;
         return { url: src[1].replace(/\\\//g, "/"), name, duration };
      } catch (_) {
         return null;
      }
   };

   // ─── PROGRESS ─────────────────────────────────────────────────────────────

   _report = (status, ctx) => {
      this.onProgress({ done: this.done, total: this.total, status, ...ctx });
   };

   // ─── WRITE HELPER ─────────────────────────────────────────────────────────

   _write = async (path, sourceUrl, ctx, fileName, filePath) => {
      const hasPath = !!filePath;

      const currentStatus = hasPath ? this.getFileStatus(filePath) : undefined;
      if (hasPath && currentStatus === "done") {
         this.done++;
         this.saved++;
         this._report("done", { ...ctx, fileName });
         return;
      }

      if (hasPath) this.onFileStatus(filePath, "downloading");
      this._report("downloading", { ...ctx, fileName });

      const result = await this.writer.write(path, sourceUrl);
      this.done++;

      if (result.ok) {
         this.saved++;
         if (hasPath) this.onFileStatus(filePath, "done");
         this._report("done", { ...ctx, fileName });
      } else {
         this.failed++;
         if (hasPath) this.onFileStatus(filePath, "failed", result.error);
         const failKey = ctx.lessonId;
         if (failKey) this._lessonFails.set(failKey, (this._lessonFails.get(failKey) || 0) + 1);
         this._report("failed", { ...ctx, fileName, error: result.error });
      }
   };

   // ─── LESSON HTML BUILDER ──────────────────────────────────────────────────

   /**
    * Builds an offline-readable lesson.html from the post's blocks.
    * Each block type is rendered per the Kartra spec.
    *
    * @param {string} title   Post name
    * @param {Block[]} blocks  data.blocks from the post
    * @param {LessonFile[]} files  data.files — needed to resolve file.path by index
    * @returns {string}  Full HTML document
    */
   _buildLessonHtml = (title, blocks, files) => {
      const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) =>
         ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

      const renderBlock = (block) => {
         switch (block.type) {
            case "text": return block.html || "";
            case "video": {
               const file = files[block.fileIndex];
               // file.path is already updated to the real filename by the time lesson.html is written
               return file ? `<video src="./${esc(file.path)}" controls style="max-width:100%"></video>` : "";
            }
            case "image": {
               const file = files[block.fileIndex];
               return file ? `<img src="./${esc(file.path)}" alt="" style="max-width:100%">` : "";
            }
            case "audio": {
               const file = files[block.fileIndex];
               return file ? `<audio src="./${esc(file.path)}" controls></audio>` : "";
            }
            case "download": {
               const file = files[block.fileIndex];
               if (!file) return "";
               const name = file.name || file.path.split("/").pop();
               return `<a href="./${esc(file.path)}" download>${esc(name)}</a>`;
            }
            case "embed":
               return `<p><a href="${esc(block.url)}" target="_blank" rel="noopener noreferrer">▶ View embedded content: ${esc(block.url)}</a></p>`;
            case "divider":
               return "<hr>";
            default:
               return "";
         }
      };

      const body = (blocks || []).map(renderBlock).filter(Boolean).join("\n");

      return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { max-width: 760px; margin: 40px auto; padding: 0 20px; font-family: system-ui, sans-serif; font-size: 16px; line-height: 1.6; color: #1a1a1a; }
  h1 { font-size: 1.6em; margin-bottom: 1em; }
  img, video { display: block; margin: 1em 0; }
  audio { display: block; margin: 1em 0; width: 100%; }
  a { color: #0070f3; }
  hr { border: none; border-top: 1px solid #ddd; margin: 2em 0; }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
${body}
</body>
</html>`;
   };

   /**
    * Builds a plain-text content.txt from the post's blocks.
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

   _findResumePoint = () => {
      for (const membership of this.memberships) {
         for (const cat of membership.categories) {
            const allPosts = [
               ...(cat.posts || []),
               ...(cat.subcategories || []).flatMap((s) => s.posts || []),
            ].filter((p) => this.selected.has(p._id));

            for (const post of allPosts) {
               for (const file of (post.data?.files || [])) {
                  if (file.path && this.getFileStatus(file.path) === "failed") {
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
         const queue = await this._buildQueue();
         this.total = queue.filter((t) => !t._isSentinel).length;
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

   _buildQueue = async () => {
      const tasks = [];

      const push = (path, url, ctx, fileName, filePath) =>
         tasks.push(() => this._write(path, url, ctx, fileName, filePath));

      const pushBlob = (path, text, ctx, fileName) =>
         tasks.push(async () => {
            const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
            const blobUrl = URL.createObjectURL(blob);
            await this._write(path, blobUrl, ctx, fileName, null);
            URL.revokeObjectURL(blobUrl);
         });

      const pushHtml = (path, html, ctx, fileName) =>
         tasks.push(async () => {
            const blob = new Blob([html], { type: "text/html;charset=utf-8" });
            const blobUrl = URL.createObjectURL(blob);
            await this._write(path, blobUrl, ctx, fileName, null);
            URL.revokeObjectURL(blobUrl);
         });

      const pushSentinel = (fn) => {
         const s = fn; s._isSentinel = true; tasks.push(s);
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

         let catIndex = 0; // 0 = Welcome, then 1, 2, 3…

         for (const cat of membership.categories) {
            const isWelcome = cat.id === 0;
            const catFolder = this._folderName(catIndex, cat.name || "Category");
            const catPath = `${memPath}${catFolder}/`;
            const catCtx = { courseId: membership.id, categoryId: cat._id };
            catIndex++;

            // All selectable posts in this category
            const directPosts = (cat.posts || []).filter((p) => this.selected.has(p._id));
            const subPosts = (cat.subcategories || []).flatMap((s) =>
               (s.posts || []).filter((p) => this.selected.has(p._id)));
            if (!directPosts.length && !subPosts.length) continue;

            // Resume check
            const isResumeCat = rp && rp.catId === cat._id;
            const beforeResume = rp && !isResumeCat &&
               (() => {
                  for (const c of this.memberships.flatMap((m) => m.categories)) {
                     if (c._id === rp.catId) return false;
                     if (c._id === cat._id) return true;
                  }
                  return false;
               })();
            if (beforeResume) continue;

            // ── Direct posts (category has posts, no subcategories) ───────────
            if (directPosts.length) {
               let postIndex = isWelcome ? 0 : 1;
               let passedResume = !rp || !isResumeCat || rp.postId === null;

               for (const post of directPosts) {
                  if (!passedResume && post._id === rp.postId) passedResume = true;
                  if (!passedResume) { postIndex++; continue; }

                  const postFolder = this._folderName(postIndex, post.name || "Post");
                  const postPath = `${catPath}${postFolder}/`;
                  const postCtx = { courseId: membership.id, categoryId: cat._id, lessonId: post._id, lessonTitle: post.name };
                  postIndex++;

                  // Clone files array so we can mutate path for videos
                  const files = (post.data?.files || []).map((f) => ({ ...f }));

                  await this._pushPostTasks({ tasks, push, pushBlob, pushHtml, pushSentinel, post, files, postPath, postCtx });
               }
            }

            // ── Subcategories ─────────────────────────────────────────────────
            let subIndex = 1;
            for (const sub of (cat.subcategories || [])) {
               const selSubPosts = (sub.posts || []).filter((p) => this.selected.has(p._id));
               if (!selSubPosts.length) { subIndex++; continue; }

               const subFolder = this._folderName(subIndex, sub.name || "Subcategory");
               const subPath = `${catPath}${subFolder}/`;
               subIndex++;

               let postIndex = 1;
               let passedResume = !rp || rp.catId !== cat._id;

               for (const post of selSubPosts) {
                  if (!passedResume && post._id === rp.postId) passedResume = true;
                  if (!passedResume) { postIndex++; continue; }

                  const postFolder = this._folderName(postIndex, post.name || "Post");
                  const postPath = `${subPath}${postFolder}/`;
                  const postCtx = { courseId: membership.id, categoryId: sub._id, lessonId: post._id, lessonTitle: post.name };
                  postIndex++;

                  const files = (post.data?.files || []).map((f) => ({ ...f }));

                  await this._pushPostTasks({ tasks, push, pushBlob, pushHtml, pushSentinel, post, files, postPath, postCtx });
               }
            }
         }
      }

      return tasks;
   };

   /**
    * Pushes all write tasks for one post (files + lesson.html + content.txt).
    * Videos are resolved to MP4 URLs here before being pushed.
    * lesson.html is written via a sentinel AFTER all file tasks for the post.
    */
   _pushPostTasks = async ({ tasks, push, pushBlob, pushHtml, pushSentinel, post, files, postPath, postCtx }) => {
      // Resolve video URLs now (async, before building queue tasks)
      for (const file of files) {
         if (file.type !== "video") continue;
         const resolved = await this._resolveVideo(file.url);
         if (resolved?.url) {
            // Update path to use the real filename with correct extension
            const ext = this._ext(resolved.url, ".mp4");
            const baseName = this._safe(resolved.name || file.path.split("/").pop().replace(/\.[^.]+$/, ""));
            file.resolvedUrl = resolved.url;
            file.path = `${file.path.split("/")[0]}/${baseName}${ext}`;
         }
      }

      // Push file tasks
      for (const file of files) {
         if (!file.url) continue;
         const destPath = `${postPath}${file.path}`;
         const srcUrl = file.resolvedUrl || file.url;
         push(destPath, srcUrl, postCtx, file.path.split("/").pop(), file.path);
      }

      // Sentinel — writes lesson.html and content.txt after all files are done
      // Uses the (possibly updated) file.path values so links are correct
      pushSentinel(async () => {
         const hasFails = (this._lessonFails.get(post._id) || 0) > 0;

         const lessonHtml = this._buildLessonHtml(post.name || "Post", post.data?.blocks || [], files);
         const contentTxt = this._buildContentTxt(post.name || "Post", post.data?.blocks || []);

         const blobHtml = new Blob([lessonHtml], { type: "text/html;charset=utf-8" });
         const blobTxt = new Blob([contentTxt], { type: "text/plain;charset=utf-8" });

         const urlHtml = URL.createObjectURL(blobHtml);
         const urlTxt = URL.createObjectURL(blobTxt);

         await this._write(`${postPath}lesson.html`, urlHtml, postCtx, "lesson.html", null);
         await this._write(`${postPath}content.txt`, urlTxt, postCtx, "content.txt", null);

         URL.revokeObjectURL(urlHtml);
         URL.revokeObjectURL(urlTxt);

         this._report(hasFails ? "lesson-failed" : "lesson-done", postCtx);
      });
   };
}
