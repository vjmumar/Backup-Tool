/**
 * KartraDashboard — dashboard.js
 *
 * Reads the scan the background saved into IndexedDB, draws the membership
 * tree with checkboxes, measures every file size, and shows sizes live.
 *
 * Kartra data shape (stored in IndexedDB "scan" store, one membership per index):
 *   Membership {
 *     id: string,
 *     attributes: { name, image, global_id, status },   // admin_login_url stripped at scrape time
 *     categories: [{
 *       id: number,         // 0 = Welcome
 *       _id: string,        // "cat-<mi>-<ci>"  — stable ID stamped by scraper.js
 *       name: string,
 *       posts: [Post],      // posts directly in the category
 *       subcategories: [{
 *         id: number,
 *         _id: string,      // "sub-<mi>-<ci>-<si>"
 *         name: string,
 *         posts: [Post]
 *       }]
 *     }]
 *   }
 *   Post {
 *     id: string,           // String(original id)
 *     _id: string,          // "post-<mi>-<ci>-<pi>" or "post-<mi>-<ci>-<si>-<pi>"
 *     name: string,
 *     type?: "home",
 *     data: {
 *       blocks: Block[],
 *       files: [{ type, url, path, name?, size? }]
 *     }
 *   }
 *
 * Selection units are post._id strings.
 * Files use post.data.files[n].path as the unique file key for sizes cache.
 *
 * Data responsibilities:
 *   "scan"  — raw membership objects, immutable after scrape.
 *   "sizes" — file size cache, keyed by file path (unique per post). Written once.
 *   this.fileStatus — Map<filePath, "downloading"|"done"|"failed">. In memory + localStorage.
 */

const _PLATFORM = chrome.runtime.getManifest().name.toLowerCase().replace(/\s+/g, "-");
const LS_KEY = `${_PLATFORM}_fileStatus`;
const LS_DEST_KEY = `${_PLATFORM}_destination`;
const LS_ROOT_KEY = `${_PLATFORM}_rootFolder`;
const LS_SELECTED_KEY = `${_PLATFORM}_selected`;

class KartraDashboard {
   constructor() {
      this.TRIES = 3;

      this.$ = (sel) => document.querySelector(sel);
      this.esc = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
      this.plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
      this.chevron = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';

      // Tree state — memberships[] each with categories[] each with subcategories[]/posts[]
      this.model = [];
      this.selected = new Set();
      this.open = new Set();
      this.rafId = 0;

      // Download status — in memory + localStorage
      this.fileStatus = new Map();

      // Backup state
      this._backupRunning = false;
      this.backupActivePostId = null;
      this._activeBackup = null;

      // Measuring state
      this._measureTotal = 0;
      this._measureDone = 0;

      this._start();
   }

   // ─── DATABASE ──────────────────────────────────────────────────────────────

   _openDb = () =>
   (this._dbPromise ||= new Promise((resolve, reject) => {
      const dbName = chrome.runtime.getManifest().name.toLowerCase().replace(/\s+/g, "-");
      const request = indexedDB.open(dbName, 5);
      request.onupgradeneeded = (e) => {
         const db = e.target.result;
         if (!db.objectStoreNames.contains("scan")) db.createObjectStore("scan");
         if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
         if (!db.objectStoreNames.contains("sizes")) db.createObjectStore("sizes");
         if (db.objectStoreNames.contains("backup")) db.deleteObjectStore("backup");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
   }));

   _dbRead = async (store, action) => {
      const db = await this._openDb();
      return new Promise((resolve) => {
         const request = action(db.transaction(store).objectStore(store));
         request.onsuccess = () => resolve(request.result);
         request.onerror = () => resolve(undefined);
      });
   };

   _dbGet = (store, key) => this._dbRead(store, (s) => s.get(key));
   _dbAll = (store) => this._dbRead(store, (s) => s.getAll());
   _dbSet = (store, key, value) => {
      this._openDb().then((db) => {
         db.transaction(store, "readwrite").objectStore(store).put(value, key);
      }).catch((err) => console.warn("[db] _dbSet failed:", store, key, err));
   };

   // ─── PERSISTENCE ──────────────────────────────────────────────────────────

   _saveFileStatus = () => {
      try {
         localStorage.setItem(LS_KEY, JSON.stringify({
            savedAt: this._scanSavedAt,
            entries: [...this.fileStatus.entries()],
         }));
      } catch (_) { }
   };

   _loadFileStatus = () => {
      try {
         const raw = localStorage.getItem(LS_KEY);
         if (!raw) return;
         const data = JSON.parse(raw);
         if (!data || !Array.isArray(data.entries)) return;
         if (data.savedAt !== this._scanSavedAt) {
            localStorage.removeItem(LS_KEY);
            localStorage.removeItem(LS_DEST_KEY);
            localStorage.removeItem(LS_ROOT_KEY);
            return;
         }
         data.entries.forEach(([filePath, status]) => {
            if (this._fileIndex?.has(filePath)) {
               this.fileStatus.set(filePath, status === "downloading" ? "failed" : status);
            }
         });
         this._saveFileStatus();
      } catch (_) { }
   };

   _saveSelected = () => {
      try {
         localStorage.setItem(LS_SELECTED_KEY, JSON.stringify({
            savedAt: this._scanSavedAt,
            ids: [...this.selected],
         }));
      } catch (_) { }
   };

   _loadSelected = () => {
      try {
         const raw = localStorage.getItem(LS_SELECTED_KEY);
         if (!raw) return false;
         const data = JSON.parse(raw);
         if (!data || !Array.isArray(data.ids)) return false;
         if (data.savedAt !== this._scanSavedAt) {
            localStorage.removeItem(LS_SELECTED_KEY);
            return false;
         }
         const allUnits = new Set(this.model.flatMap((m) => this._membershipUnits(m)));
         this.selected = new Set(data.ids.filter((id) => allUnits.has(id)));
         return true;
      } catch (_) {
         return false;
      }
   };

   // ─── FILE INDEX ───────────────────────────────────────────────────────────
   // Keyed by file.path (unique per post per file) — used for size cache + status lookup.

   _buildFileIndex = () => {
      this._fileIndex = new Map();
      this.model.forEach(({ membership }) => {
         const register = (files) => (files || []).forEach((file) => {
            if (file.path) this._fileIndex.set(file.path, file);
         });
         membership.categories.forEach((cat) => {
            (cat.posts || []).forEach((post) => register(post.data?.files));
            (cat.subcategories || []).forEach((sub) =>
               (sub.posts || []).forEach((post) => register(post.data?.files)));
         });
      });
   };

   // ─── MEASURING ────────────────────────────────────────────────────────────
   // Note: Kartra video files need URL resolution before measuring — the url
   // field on a video file is a player page, not a direct CDN link. We skip
   // size measurement for video files here and let the orchestrator resolve
   // them. Images, audio, and downloads can be measured directly.

   _probeSize = async (url) => {
      const controller = new AbortController();
      try {
         const res = await fetch(url, { headers: { Range: "bytes=0-0" }, signal: controller.signal });
         if (res.status === 429 || res.status >= 500) return { retry: true };
         if (res.status !== 200 && res.status !== 206) return { size: null };
         const range = res.headers.get("Content-Range");
         const total = range ? Number(range.split("/")[1]) : Number(res.headers.get("Content-Length"));
         return { size: Number.isFinite(total) && total > 0 ? total : null };
      } finally {
         controller.abort();
      }
   };

   _getFileSize = async (url) => {
      for (let attempt = 0; attempt < this.TRIES; attempt++) {
         try {
            const result = await this._probeSize(url);
            if (!result.retry) return result.size;
         } catch (_) { }
         await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
      return null;
   };

   _collectMeasureWork = () => {
      // Collect all measurable files (skip video — needs player page resolution)
      const byUrl = new Map();
      const visit = (files) => (files || []).forEach((file) => {
         if (!file.url || !file.path || file.type === "video") return;
         const key = file.url.split("?")[0];
         if (!byUrl.has(key)) byUrl.set(key, { url: file.url, paths: [], alreadySized: true });
         byUrl.get(key).paths.push(file.path);
         if (file.size === undefined) byUrl.get(key).alreadySized = false;
      });
      this.model.forEach(({ membership }) => {
         membership.categories.forEach((cat) => {
            (cat.posts || []).forEach((post) => visit(post.data?.files));
            (cat.subcategories || []).forEach((sub) =>
               (sub.posts || []).forEach((post) => visit(post.data?.files)));
         });
      });
      const todo = [];
      let alreadyDone = 0;
      for (const entry of byUrl.values()) {
         if (entry.alreadySized) alreadyDone++;
         else todo.push(entry);
      }
      return { todo, total: byUrl.size, alreadyDone };
   };

   _measureAll = async () => {
      // Load cached sizes
      this.model.forEach(({ membership }) => {
         const load = (files) => (files || []).forEach(async (file) => {
            if (!file.path || file.size !== undefined) return;
            const cached = await this._dbGet("sizes", file.path);
            if (cached !== undefined) {
               file.size = cached;
               this._measureDone++;
               this._schedule();
            }
         });
         membership.categories.forEach((cat) => {
            (cat.posts || []).forEach((post) => load(post.data?.files));
            (cat.subcategories || []).forEach((sub) =>
               (sub.posts || []).forEach((post) => load(post.data?.files)));
         });
      });

      await new Promise((r) => setTimeout(r, 50));
      const { todo, total, alreadyDone } = this._collectMeasureWork();
      this._measureTotal = total;
      this._measureDone = alreadyDone;
      this._schedule();

      let next = 0;
      const worker = async () => {
         while (next < todo.length) {
            const { url, paths } = todo[next++];
            const size = await this._getFileSize(url);
            const val = size ?? null;
            paths.forEach((p) => {
               const file = this._fileIndex?.get(p);
               if (file) file.size = val;
               this._dbSet("sizes", p, val);
            });
            this._measureDone++;
            this._schedule();
         }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      this._schedule();
   };

   // ─── SIZE HELPERS ─────────────────────────────────────────────────────────

   _format = (bytes) => {
      const units = ["B", "KB", "MB", "GB", "TB"];
      let n = bytes, i = 0;
      while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
      return `${i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
   };

   _sumFiles = (files = []) =>
      files.reduce((total, file) => {
         if (!file.url) return total;
         // Videos are not measured here — show as unknown
         if (file.type === "video") { total.unknown++; return total; }
         if (file.size === undefined) total.pending++;
         else if (file.size === null) total.unknown++;
         else total.bytes += file.size;
         return total;
      }, { bytes: 0, pending: 0, unknown: 0 });

   _addStat = (a, b) => ({ bytes: a.bytes + b.bytes, pending: a.pending + b.pending, unknown: a.unknown + b.unknown });
   _empty = () => ({ bytes: 0, pending: 0, unknown: 0 });

   _postStat = (post) => this._sumFiles(post.data?.files || []);

   _subStat = (sub) => (sub.posts || []).reduce((t, p) => this._addStat(t, this._postStat(p)), this._empty());

   _catStat = (cat) => {
      const fromPosts = (cat.posts || []).reduce((t, p) => this._addStat(t, this._postStat(p)), this._empty());
      const fromSubs = (cat.subcategories || []).reduce((t, s) => this._addStat(t, this._subStat(s)), this._empty());
      return this._addStat(fromPosts, fromSubs);
   };

   _membershipStat = (m) =>
      m.membership.categories.reduce((t, cat) => this._addStat(t, this._catStat(cat)), this._empty());

   _sizeHtml = (stat) =>
      stat.pending
         ? '<span class="meas" aria-label="measuring"></span>'
         : this._format(stat.bytes) + (stat.unknown ? '<span class="unk" title="Video sizes are resolved during backup"> +?</span>' : "");

   // ─── TREE MODEL ───────────────────────────────────────────────────────────

   _buildModel = (memberships, skipDefaultSelection = false) => {
      this.model = memberships.map((membership) => ({ membership }));

      if (!skipDefaultSelection) {
         this.selected = new Set(this.model.flatMap((m) => this._membershipUnits(m)));
      }
      if (this.model.length) this.open.add(this.model[0].membership.id);
      this._buildFileIndex();
   };

   // Returns all selectable post._id values in a membership
   _membershipUnits = (m) =>
      m.membership.categories.flatMap((cat) => this._catUnits(cat));

   _catUnits = (cat) => [
      ...(cat.posts || []).map((p) => p._id),
      ...(cat.subcategories || []).flatMap((sub) => (sub.posts || []).map((p) => p._id)),
   ];

   _subUnits = (sub) => (sub.posts || []).map((p) => p._id);

   _stateOf = (ids) => {
      const n = ids.filter((i) => this.selected.has(i)).length;
      return n === 0 ? "none" : n === ids.length ? "all" : "some";
   };

   _selectionStat = () => {
      let total = this._empty();
      this.model.forEach((m) => {
         m.membership.categories.forEach((cat) => {
            (cat.posts || []).forEach((post) => {
               if (this.selected.has(post._id)) total = this._addStat(total, this._postStat(post));
            });
            (cat.subcategories || []).forEach((sub) => {
               (sub.posts || []).forEach((post) => {
                  if (this.selected.has(post._id)) total = this._addStat(total, this._postStat(post));
               });
            });
         });
      });
      return total;
   };

   // ─── HTML BUILDERS ────────────────────────────────────────────────────────

   _chevHtml = (id) =>
      `<button class="chev" data-toggle="${id}" aria-expanded="${this.open.has(id)}" aria-label="${this.open.has(id) ? "Collapse" : "Expand"}">${this.chevron}</button>`;

   _checkHtml = (ids, label) =>
      `<label class="chk"><input type="checkbox" data-ids="${this.esc(ids.join(","))}" data-state="${this._stateOf(ids)}"><span class="ct">${this.esc(label)}</span></label>`;

   _tagsOf = (post) => {
      const files = post.data?.files || [];
      const byType = (t) => files.filter((f) => f.type === t).length;
      const tags = [];
      if (post.type === "home") tags.push('<span class="tag">Welcome</span>');
      if (byType("video")) tags.push(`<span class="tag">Video</span>`);
      if (byType("image")) tags.push(`<span class="tag">Image</span>`);
      if (byType("audio")) tags.push(`<span class="tag">Audio</span>`);
      if (byType("download")) tags.push(`<span class="tag">Downloads (${byType("download")})</span>`);
      return tags.join("");
   };

   _postDownloadStatus = (post) => {
      const files = (post.data?.files || []).filter((f) => f.path);
      if (!files.length) return undefined;
      const statuses = files.map((f) => this.fileStatus.get(f.path));
      if (statuses.some((s) => s === "downloading")) return "downloading";
      if (statuses.some((s) => s === "failed")) return "failed";
      if (statuses.every((s) => s === "done")) return "done";
      return undefined;
   };

   _postHtml = (post) => {
      const status = this._postDownloadStatus(post);
      const isActive = this.backupActivePostId === post._id;

      let badge = "";
      if (isActive || status === "downloading") badge = '<span class="tag bk-active">Downloading…</span>';
      else if (status === "done") badge = '<span class="tag bk-done">✓ Saved</span>';
      else if (status === "failed") badge = '<span class="tag bk-fail">✗ Failed</span>';

      const retryBtn = !this._backupRunning && status === "failed"
         ? `<button class="btn-retry-lesson" data-retry-post="${this.esc(post._id)}" title="Retry this post">↺ Retry</button>`
         : "";

      const rowClass = isActive || status === "downloading" ? " bk-row"
         : status === "done" ? " bk-row-done"
            : status === "failed" ? " bk-row-fail" : "";

      return `
      <div class="lesson${rowClass}">
         ${this._checkHtml([post._id], post.name || "Untitled post")}
         ${this._tagsOf(post)}
         ${badge}
         ${retryBtn}
         <span class="meta">${this._sizeHtml(this._postStat(post))}</span>
      </div>`;
   };

   _subHtml = (sub) => {
      const units = this._subUnits(sub);
      const picked = units.filter((id) => this.selected.has(id)).length;
      const count = `${picked ? picked + " of " : ""}${this.plural(units.length, "post", "posts")}`;
      const allDone = this._backupRunning && units.length > 0 &&
         units.every((id) => {
            const post = this._findPost(id);
            return post && this._postDownloadStatus(post) === "done";
         });

      return `
      <div class="cat${allDone ? " bk-cat-done" : ""}">
         <div class="crow">${this._chevHtml(sub._id)}${this._checkHtml(units, sub.name || "Untitled subcategory")}<span class="meta">${count} &middot; ${this._sizeHtml(this._subStat(sub))}</span></div>
         ${this.open.has(sub._id)
            ? `<div class="lessons">${units.length
               ? (sub.posts || []).map((p) => this._postHtml(p)).join("")
               : '<p class="skipped">No posts in this subcategory.</p>'
            }</div>`
            : ""}
      </div>`;
   };

   _catHtml = (cat) => {
      const units = this._catUnits(cat);
      const picked = units.filter((id) => this.selected.has(id)).length;
      const postCount = (cat.posts || []).length +
         (cat.subcategories || []).reduce((n, s) => n + (s.posts || []).length, 0);
      const subCount = (cat.subcategories || []).length;
      const detail = subCount
         ? `${this.plural(subCount, "subcategory", "subcategories")} &middot; ${picked ? picked + " of " : ""}${this.plural(postCount, "post", "posts")}`
         : `${picked ? picked + " of " : ""}${this.plural(postCount, "post", "posts")}`;
      const allDone = this._backupRunning && units.length > 0 &&
         units.every((id) => {
            const post = this._findPost(id);
            return post && this._postDownloadStatus(post) === "done";
         });

      const inner = [
         ...(cat.posts || []).map((p) => this._postHtml(p)),
         ...(cat.subcategories || []).map((s) => this._subHtml(s)),
      ].join("");

      return `
      <div class="cat${allDone ? " bk-cat-done" : ""}">
         <div class="crow">${this._chevHtml(cat._id)}${this._checkHtml(units, cat.name || "Untitled category")}<span class="meta">${detail} &middot; ${this._sizeHtml(this._catStat(cat))}</span></div>
         ${this.open.has(cat._id)
            ? `<div class="lessons">${inner || '<p class="skipped">No posts in this category.</p>'}</div>`
            : ""}
      </div>`;
   };

   _membershipHtml = (m) => {
      const { membership } = m;
      const units = this._membershipUnits(m);
      const picked = units.filter((id) => this.selected.has(id)).length;
      const isDraft = membership.attributes?.status === "0";
      const count = `${this.plural(membership.categories.length, "category", "categories")} &middot; ${picked ? picked + " of " : ""}${this.plural(units.length, "post", "posts")}`;
      const allDone = this._backupRunning && units.length > 0 &&
         units.every((id) => {
            const post = this._findPost(id);
            return post && this._postDownloadStatus(post) === "done";
         });

      return `
      <div class="course${allDone ? " bk-course-done" : ""}">
         <div class="crow">
            ${this._chevHtml(membership.id)}
            ${this._checkHtml(units, membership.attributes?.name || "Untitled membership")}
            ${isDraft ? '<span class="tag draft">Draft</span>' : ""}
            <span class="meta">${count} &middot; ${this._sizeHtml(this._membershipStat(m))}</span>
         </div>
         ${this.open.has(membership.id)
            ? `<div class="cats">${membership.categories.map((c) => this._catHtml(c)).join("")}</div>`
            : ""}
      </div>`;
   };

   // O(n) lookup — used for status checks; called infrequently
   _findPost = (postId) => {
      for (const { membership } of this.model) {
         for (const cat of membership.categories) {
            for (const post of (cat.posts || [])) {
               if (post._id === postId) return post;
            }
            for (const sub of (cat.subcategories || [])) {
               for (const post of (sub.posts || [])) {
                  if (post._id === postId) return post;
               }
            }
         }
      }
      return null;
   };

   // ─── DRAW ─────────────────────────────────────────────────────────────────

   _draw = () => {
      const scrollY = window.scrollY;

      this.$("#tree").innerHTML = this.model.map((m) => this._membershipHtml(m)).join("")
         || '<div class="state"><p>No memberships found.</p></div>';

      document.querySelectorAll("input[data-state]").forEach((input) => {
         input.checked = input.dataset.state === "all";
         input.indeterminate = input.dataset.state === "some";
         input.disabled = this._backupRunning;
      });
      const folderInput = this.$("#root-folder");
      if (folderInput) folderInput.disabled = this._backupRunning;

      const allUnits = this.model.flatMap((m) => this._membershipUnits(m));
      const nSelected = allUnits.filter((id) => this.selected.has(id)).length;
      const selectAll = this.$("#select-all-checkbox");
      if (selectAll) {
         selectAll.disabled = this._backupRunning;
         selectAll.checked = allUnits.length > 0 && nSelected === allUnits.length;
         selectAll.indeterminate = nSelected > 0 && nSelected < allUnits.length;
      }
      const selectAllRow = this.$("#select-all-row");
      if (selectAllRow) selectAllRow.hidden = this.model.length === 0;
      window.scrollTo({ top: scrollY, behavior: "instant" });

      if (this._backupRunning) return;

      const stat = this._selectionStat();
      const measuring = this._measureDone < this._measureTotal;
      const note = measuring
         ? `Measuring sizes &middot; ${this._measureDone} of ${this._measureTotal} files (${Math.round((this._measureDone / this._measureTotal) * 100)}%)`
         : "Video sizes are measured during backup.";

      const canBackup = nSelected > 0;
      const hasStatus = this.fileStatus.size > 0;
      const savedDest = (() => { try { return localStorage.getItem(LS_DEST_KEY); } catch (_) { return null; } })();
      const btnLabel = hasStatus ? "Resume backup" : "Start backup";
      const sizeLabel = stat.pending
         ? `<span class="meas"></span>`
         : `<span class="sum-size">${this._format(stat.bytes).replace(/\s/, "<em>")}B</em></span>`;

      this.$("#bottom-in").innerHTML = `
         <div class="sum">
            ${sizeLabel}
            <span class="sum-detail">${this.plural(nSelected, "post", "posts")} selected</span>
            <p class="muted small" style="margin-left:auto">${note}</p>
         </div>
         <button class="btn primary" id="btn-backup" ${canBackup ? "" : "disabled"}>${btnLabel}</button>`;

      if (canBackup) {
         this.$("#btn-backup").addEventListener("click", () => {
            if (hasStatus && savedDest) this._showResumeModal(savedDest);
            else this._showDestinationPicker();
         });
      }
      this.$("#bottom").hidden = false;
   };

   _schedule = () => {
      if (this.rafId) return;
      this.rafId = requestAnimationFrame(() => { this.rafId = 0; this._draw(); });
   };

   // ─── RETRY ────────────────────────────────────────────────────────────────

   _retryPost = (postId) => {
      const post = this._findPost(postId);
      if (!post) return;
      (post.data?.files || []).forEach((file) => {
         if (file.path && this.fileStatus.get(file.path) === "failed") {
            this.fileStatus.delete(file.path);
         }
      });
      this._saveFileStatus();
      const savedDest = (() => { try { return localStorage.getItem(LS_DEST_KEY); } catch (_) { return null; } })();
      if (savedDest === "drive") this._onPickDrive({ resumeAtPostId: postId });
      else this._onPickLocal({ resumeAtPostId: postId });
   };

   // ─── EVENTS ───────────────────────────────────────────────────────────────

   _initEvents = () => {
      this.$("#select-all-checkbox").addEventListener("change", (e) => {
         if (this._backupRunning) return;
         const allUnits = this.model.flatMap((m) => this._membershipUnits(m));
         if (e.target.checked) allUnits.forEach((id) => this.selected.add(id));
         else allUnits.forEach((id) => this.selected.delete(id));
         this._saveSelected();
         this._draw();
      });

      this.$("#tree").addEventListener("click", (e) => {
         const toggle = e.target.closest("[data-toggle]");
         if (toggle) {
            const id = toggle.dataset.toggle;
            this.open.has(id) ? this.open.delete(id) : this.open.add(id);
            return this._draw();
         }
         const retryBtn = e.target.closest("[data-retry-post]");
         if (retryBtn && !this._backupRunning) {
            this._retryPost(retryBtn.dataset.retryPost);
            return;
         }
         if (this._backupRunning) return;
         const input = e.target.closest("input[data-ids]");
         if (input) {
            input.dataset.ids.split(",").forEach((i) =>
               input.checked ? this.selected.add(i) : this.selected.delete(i));
            this._saveSelected();
            this._draw();
         }
      });

      this.$("#dest-close").addEventListener("click", () => this._hideDestinationPicker());
      this.$("#dest-scrim").addEventListener("click", (e) => {
         if (e.target === this.$("#dest-scrim")) this._hideDestinationPicker();
      });
      document.addEventListener("keydown", (e) => {
         if (e.key === "Escape" && !this.$("#dest-scrim").hidden) this._hideDestinationPicker();
         if (e.key === "Escape" && !this.$("#setup-scrim").hidden) this._hideSetupModal();
         if (e.key === "Escape" && !this.$("#drive-scrim").hidden) this._hideDriveModal();
      });

      this.$("#resume-yes").addEventListener("click", () => {
         this._hideResumeModal();
         const savedDest = (() => { try { return localStorage.getItem(LS_DEST_KEY); } catch (_) { return null; } })();
         if (savedDest === "drive") this._onPickDrive();
         else this._onPickLocal();
      });
      this.$("#resume-no").addEventListener("click", () => {
         this._hideResumeModal();
         this.fileStatus.clear();
         this._saveFileStatus();
         this._showDestinationPicker();
      });

      this.$("#setup-open-settings").addEventListener("click", () =>
         chrome.runtime.sendMessage({ type: "open-chrome-settings" }));
      this.$("#setup-cancel").addEventListener("click", () => this._hideSetupModal());
      this.$("#setup-confirm").addEventListener("click", () => {
         this._hideSetupModal();
         this._startLocalBackup();
      });

      this.$("#drive-switch-account").addEventListener("click", () => {
         chrome.runtime.sendMessage({ type: "connect-drive" }, () => this._populateDriveModal());
      });
      this.$("#drive-continue").addEventListener("click", () => {
         this._hideDriveModal();
         this._startDriveBackup();
      });
      this.$("#drive-close").addEventListener("click", () => this._hideDriveModal());
   };

   // ─── DESTINATION PICKER ───────────────────────────────────────────────────

   _showDestinationPicker = () => { this.$("#dest-scrim").hidden = false; };
   _hideDestinationPicker = () => {
      this.$("#dest-scrim").hidden = true;
      this.$("#dest-local").disabled = false;
      this.$("#dest-drive").disabled = false;
   };

   _onPickLocal = (opts = {}) => {
      this._hideDestinationPicker();
      chrome.runtime.sendMessage({ type: "check-download-setting" }, (res) => {
         if (res?.askEachTime) this._showSetupModal(opts);
         else this._startLocalBackup(opts);
      });
   };

   _onPickDrive = (opts = {}) => {
      this._hideDestinationPicker();
      this._showDriveModal(opts);
   };

   // ─── SETUP MODAL ──────────────────────────────────────────────────────────

   _showSetupModal = (opts = {}) => {
      this._pendingLocalOpts = opts;
      this.$("#setup-scrim").hidden = false;
   };
   _hideSetupModal = () => { this.$("#setup-scrim").hidden = true; };

   // ─── DRIVE MODAL ──────────────────────────────────────────────────────────

   _showDriveModal = (opts = {}) => {
      this._pendingDriveOpts = opts;
      this.$("#drive-scrim").hidden = false;
      this._populateDriveModal();
   };
   _hideDriveModal = () => { this.$("#drive-scrim").hidden = true; };

   _populateDriveModal = () => {
      chrome.runtime.sendMessage({ type: "get-drive-state" }, (res) => {
         const accountRow = this.$("#drive-account-row");
         const accountEmail = this.$("#drive-account-email");
         if (res?.email) {
            accountEmail.textContent = res.email;
            accountRow.hidden = false;
         } else {
            accountRow.hidden = true;
         }
      });
      chrome.runtime.sendMessage({ type: "get-drive-storage-quota" }, (res) => {
         this.$("#drive-storage-row").innerHTML = res?.ok ? this._driveQuotaHtml(res) : "";
      });
   };

   _driveQuotaHtml = ({ usedBytes, totalBytes, selectionBytes }) => {
      const fmt = (b) => this._format(b || 0);
      const pctU = totalBytes ? Math.min(100, (usedBytes / totalBytes) * 100) : 0;
      const pctS = totalBytes ? Math.min(100 - pctU, (selectionBytes / totalBytes) * 100) : 0;
      const over = usedBytes + selectionBytes > totalBytes;
      const cls = over ? "bad" : selectionBytes > totalBytes * 0.3 ? "warn" : "good";
      return `
      <div class="drive-quota-bar-wrap">
         <div class="drive-quota-bar">
            <div class="drive-quota-used" style="width:${pctU}%"></div>
            <div class="drive-quota-sel${over ? " over" : ""}" style="width:${pctS}%"></div>
         </div>
         <div class="drive-quota-labels">
            <span>${fmt(usedBytes)} used of ${fmt(totalBytes)}</span>
            <span class="drive-quota-sel-label${over ? " bad" : ""}">+${fmt(selectionBytes)} this backup</span>
         </div>
         <p class="drive-quota-warn ${cls}">
            ${over ? "⚠ Not enough space — this backup may fail." : cls === "warn" ? "Large backup — make sure you have enough space." : "Enough space available."}
         </p>
      </div>`;
   };

   // ─── RESUME MODAL ─────────────────────────────────────────────────────────

   _showResumeModal = (savedDest) => {
      this.$("#resume-dest-hint").textContent =
         savedDest === "drive" ? "Last destination: Google Drive" : "Last destination: Local downloads";
      this.$("#resume-scrim").hidden = false;
   };
   _hideResumeModal = () => { this.$("#resume-scrim").hidden = true; };

   // ─── BACKUP ───────────────────────────────────────────────────────────────

   _getRootFolder = () => {
      try { return localStorage.getItem(LS_ROOT_KEY) || this.$("#root-folder")?.value || "Kartra Backup"; }
      catch (_) { return "Kartra Backup"; }
   };

   _startLocalBackup = (opts = {}) => {
      const rootFolder = this._getRootFolder();
      try { localStorage.setItem(LS_DEST_KEY, "local"); } catch (_) { }
      try { localStorage.setItem(LS_ROOT_KEY, rootFolder); } catch (_) { }

      const writer = {
         write: (path, url) => new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: "download-file", url, filename: path }, (res) => {
               resolve(res || { ok: false, error: "No response from background." });
            });
         }),
      };
      this._runBackup(writer, rootFolder, opts);
   };

   _startDriveBackup = (opts = {}) => {
      const rootFolder = this._getRootFolder();
      try { localStorage.setItem(LS_DEST_KEY, "drive"); } catch (_) { }
      try { localStorage.setItem(LS_ROOT_KEY, rootFolder); } catch (_) { }

      const writer = {
         write: (path, url) => new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: "drive-upload-file", path, url }, (res) => {
               resolve(res || { ok: false, error: "No response from background." });
            });
         }),
      };
      this._runBackup(writer, rootFolder, opts);
   };

   _runBackup = (writer, rootFolder, opts = {}) => {
      if (this._backupRunning) return;
      this._backupRunning = true;
      this._schedule();

      // Collect selected memberships (only those with at least one selected post)
      const selectedMemberships = this.model
         .map((m) => m.membership)
         .filter((mem) => mem.categories.some((cat) =>
            (cat.posts || []).some((p) => this.selected.has(p._id)) ||
            (cat.subcategories || []).some((sub) => (sub.posts || []).some((p) => this.selected.has(p._id)))
         ));

      this._activeBackup = new KartraOrchestrator({
         memberships: selectedMemberships,
         selected: this.selected,
         writer,
         rootFolder,
         resumeAtPostId: opts.resumeAtPostId || null,
         onProgress: ({ lessonId, status }) => {
            if (lessonId) {
               this.backupActivePostId = status === "lesson-done" || status === "lesson-failed" ? null : lessonId;
            }
            this._schedule();
         },
         onFileStatus: (filePath, status) => {
            this.fileStatus.set(filePath, status);
            this._saveFileStatus();
         },
         getFileStatus: (filePath) => this.fileStatus.get(filePath),
         onDone: ({ saved, failed, cancelled }) => {
            this._backupRunning = false;
            this.backupActivePostId = null;
            this._activeBackup = null;
            this._schedule();
            this._showDoneBar(saved, failed, cancelled);
         },
         onError: (err) => {
            this._backupRunning = false;
            this._activeBackup = null;
            console.error("[Kartra Backup] backup error", err);
            this._schedule();
         },
      });
   };

   _showDoneBar = (saved, failed, cancelled) => {
      const msg = cancelled
         ? `Backup cancelled — ${saved} file${saved === 1 ? "" : "s"} saved.`
         : failed
            ? `Backup finished with ${failed} failure${failed === 1 ? "" : "s"} — ${saved} saved.`
            : `All ${saved} file${saved === 1 ? "" : "s"} saved successfully.`;
      const el = this.$("#bottom-in");
      if (el) el.innerHTML = `<div class="sum"><span class="sum-detail">${this.esc(msg)}</span></div>
         <button class="btn primary" id="btn-new-backup">Back up again</button>`;
      this.$("#btn-new-backup")?.addEventListener("click", () => {
         this.fileStatus.clear();
         this._saveFileStatus();
         this._showDestinationPicker();
      });
   };

   // ─── HEADER ───────────────────────────────────────────────────────────────

   _buildHeader = (meta, me) => {
      const total = this.model.reduce((n, m) =>
         n + m.membership.categories.reduce((nc, cat) =>
            nc + (cat.posts || []).length +
            (cat.subcategories || []).reduce((ns, s) => ns + (s.posts || []).length, 0), 0), 0);
      const sub = `${this.plural(this.model.length, "membership", "memberships")} · ${this.plural(total, "post", "posts")}`;
      const subEl = this.$("#sub");
      if (subEl) subEl.textContent = sub;

      const actions = this.$("#top-actions");
      if (!actions) return;

      actions.innerHTML = `
         <button class="btn" id="btn-sign-out" title="Sign out">Sign out</button>`;

      this.$("#btn-sign-out")?.addEventListener("click", async () => {
         await chrome.runtime.sendMessage({ type: "auth-sign-out" });
         window.close();
      });

      // Root folder persistence
      const folderInput = this.$("#root-folder");
      if (folderInput) {
         const saved = (() => { try { return localStorage.getItem(LS_ROOT_KEY); } catch (_) { return null; } })();
         if (saved) folderInput.value = saved;
         folderInput.addEventListener("input", () => {
            try { localStorage.setItem(LS_ROOT_KEY, folderInput.value); } catch (_) { }
         });
      }

      // Destination picker events
      this.$("#dest-local")?.addEventListener("click", () => this._onPickLocal());
      this.$("#dest-drive")?.addEventListener("click", () => this._onPickDrive());
   };

   // ─── START ────────────────────────────────────────────────────────────────

   _start = async () => {
      try {
         // Load scan from IndexedDB
         const [meta, memberships] = await Promise.all([
            this._dbGet("meta", "scan"),
            this._dbAll("scan"),
         ]);

         if (!memberships?.length) {
            this.$("#sub").textContent = "No scan found — run Back up memberships first.";
            this.$("#tree").innerHTML = '<div class="state"><p>No memberships found. Use the extension button on Kartra to scan first.</p></div>';
            return;
         }

         this._scanSavedAt = meta?.savedAt;

         // Build model
         this._buildModel(memberships);

         // Restore persisted selection or select all
         const hadSelection = this._loadSelected();
         if (!hadSelection) {
            this.selected = new Set(this.model.flatMap((m) => this._membershipUnits(m)));
         }

         // Open first membership
         if (this.model.length) this.open.add(this.model[0].membership.id);

         this._initEvents();
         this._buildHeader(meta);
         this._loadFileStatus();
         this._schedule();
         this._measureAll();

      } catch (err) {
         console.error("[Kartra Backup] _start error", err);
         this.$("#sub").textContent = "Error loading scan.";
      }
   };
}

new KartraDashboard();
