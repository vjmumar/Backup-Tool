/**
 * KartraDashboard — dashboard.js
 *
 * Reads the scan the background saved into IndexedDB, draws the membership
 * tree with checkboxes, measures every file size, and shows the sizes live.
 *
 * Kartra structure:
 *   membership → categories[] → posts[] (direct)
 *                             → subcategories[] → posts[]
 *
 * All posts have the same shape: post._id, post.name, post.data.files[], post.data.blocks[]
 *
 * Data responsibilities:
 *   "scan"  store   — raw membership objects, immutable after scrape.
 *   "sizes" store   — file size cache, keyed by fileId. Written once per file.
 *   this.fileStatus — Map<fileId, "downloading"|"done"|"failed">. Persisted to
 *                     localStorage. Cleared on new scrape or new backup run.
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

      this.model = [];
      this.selected = new Set();
      this.open = new Set();
      this.rafId = 0;

      this.fileStatus = new Map();

      this._backupRunning = false;
      this.backupActivePostId = null;
      this._activeBackup = null;

      this._measureTotal = 0;
      this._measureDone = 0;

      this._start();
   }

   // ─── DATABASE ─────────────────────────────────────────────────────────────

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
         data.entries.forEach(([fileId, status]) => {
            // Accept lesson-level keys (lesson:<postId>) and CDN file keys
            if (fileId.startsWith("lesson:") || this._fileIndex?.has(fileId)) {
               this.fileStatus.set(fileId, status === "downloading" ? "failed" : status);
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

   /**
    * Builds Map<fileId, file> for O(1) lookup.
    * Walks the full tree: membership → categories → (posts + subcategories → posts).
    */
   _buildFileIndex = () => {
      this._fileIndex = new Map();
      this.model.forEach(({ membership }) => {
         const register = (files) => (files || []).forEach((file) => {
            if (file.fileId) this._fileIndex.set(file.fileId, file);
         });
         membership.categories.forEach((cat) => {
            (cat.posts || []).forEach((post) => register(post.data?.files));
            (cat.subcategories || []).forEach((sub) =>
               (sub.posts || []).forEach((post) => register(post.data?.files)));
         });
      });
   };

   // ─── MEASURING ────────────────────────────────────────────────────────────

   _probeSize = async (url) => {
      const probe = async (headers) => {
         try {
            const res = await fetch(url, { headers });
            if (res.status === 429 || res.status >= 500) return { retry: true };
            if (res.status !== 200 && res.status !== 206) return { size: null };

            // Content-Range "bytes 0-0/<total>" is the most reliable source.
            // CloudFront/S3 returns this on a GET Range: bytes=0-0 request.
            const range = res.headers.get("Content-Range");
            if (range) {
               const total = Number(range.split("/").pop().trim());
               if (Number.isFinite(total) && total > 0) return { size: total };
            }

            // No Content-Range — use Content-Length.
            // On a 206 this is 1 (our range byte), so only trust it on 200.
            if (res.status === 200) {
               const len = Number(res.headers.get("Content-Length"));
               if (Number.isFinite(len) && len > 0) return { size: len };
            }

            return { size: null };
         } catch (_) {
            return { size: null };
         }
      };

      // First try: GET with Range: bytes=0-0
      // CloudFront responds 206 + Content-Range: bytes 0-0/<total>.
      // Kartra portal URLs may redirect — the redirect target returns 200
      // with Content-Length when Range isn't forwarded.
      const withRange = await probe({ Range: "bytes=0-0" });
      if (withRange.retry) return withRange;
      if (withRange.size !== null) return withRange;

      // Fallback: plain GET — server returns 200 + Content-Length.
      const plain = await probe({});
      if (plain.retry) return { retry: true };
      return plain;
   };

   _getFileSize = async (url) => {
      for (let attempt = 0; attempt < this.TRIES; attempt++) {
         try {
            const result = await this._probeSize(url);
            if (!result.retry) return result.size;
         } catch (_) { }
         await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
      return null;
   };

   _collectMeasureWork = () => {
      const byUrl = new Map();
      const visit = (files) => (files || []).forEach((file) => {
         if (!file.url || !file.fileId) return;
         const key = file.url.split("?")[0];
         if (!byUrl.has(key)) byUrl.set(key, { url: file.url, fileIds: [], alreadySized: true, fallbackSize: null });
         const entry = byUrl.get(key);
         entry.fileIds.push(file.fileId);
         if (file.size === undefined) entry.alreadySized = false;
         // Carry the scraper-supplied byte count as a fallback for servers
         // that return neither Content-Range nor Content-Length.
         if (!entry.fallbackSize && typeof file.fallbackSize === "number" && file.fallbackSize > 0) {
            entry.fallbackSize = file.fallbackSize;
         }
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
      // Count total first so the progress display is correct from the first draw
      const { total } = this._collectMeasureWork();
      this._measureTotal = total;
      this._measureDone = 0;
      this._schedule();

      // Load cached sizes from IDB
      const cacheLoads = [];
      this.model.forEach(({ membership }) => {
         const load = (files) => (files || []).forEach((file) => {
            if (!file.fileId || file.size !== undefined) return;
            cacheLoads.push(
               this._dbGet("sizes", file.fileId).then((cached) => {
                  if (cached !== undefined) {
                     file.size = cached;
                     this._measureDone++;
                     this._schedule();
                  }
               })
            );
         });
         membership.categories.forEach((cat) => {
            (cat.posts || []).forEach((post) => load(post.data?.files));
            (cat.subcategories || []).forEach((sub) =>
               (sub.posts || []).forEach((post) => load(post.data?.files)));
         });
      });
      await Promise.all(cacheLoads);

      // Re-collect after cache hydration
      const { todo, alreadyDone } = this._collectMeasureWork();
      this._measureDone = alreadyDone;
      this._schedule();

      // Measure remaining files via HEAD requests (6 parallel workers)
      let next = 0;
      const worker = async () => {
         while (next < todo.length) {
            const { url, fileIds, fallbackSize } = todo[next++];
            const measured = await this._getFileSize(url);
            let val = measured ?? null;
            // No Content-Length or Content-Range (chunked transfer) — fall back
            // to the byte count the scraper provided on the file object.
            if (val === null && typeof fallbackSize === "number" && fallbackSize > 0) {
               val = fallbackSize;
            }
            if (val === null) {
               console.warn("[Kartra Measure] could not measure:", url, "| fileIds:", fileIds);
            }
            fileIds.forEach((id) => {
               const file = this._fileIndex?.get(id);
               if (file) file.size = val;
               this._dbSet("sizes", id, val);
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
         if (file.size === undefined) total.pending++;
         else if (file.size === null) total.unknown++;
         else total.bytes += file.size;
         return total;
      }, { bytes: 0, pending: 0, unknown: 0 });

   _addStat = (a, b) => ({ bytes: a.bytes + b.bytes, pending: a.pending + b.pending, unknown: a.unknown + b.unknown });
   _empty = () => ({ bytes: 0, pending: 0, unknown: 0 });

   _sizeHtml = (stat) =>
      stat.pending
         ? '<span class="meas" aria-label="measuring"></span>'
         : this._format(stat.bytes) + (stat.unknown ? '<span class="unk" title="A file size could not be read"> +?</span>' : "");

   // ─── TREE MODEL ───────────────────────────────────────────────────────────

   /**
    * Normalises files on load:
    *  - Stamps fileId if missing (fallback for old IDB data)
    */
   _buildModel = (memberships, skipDefaultSelection = false) => {
      memberships.forEach((membership, mi) => {
         membership.categories.forEach((cat, ci) => {
            const normalisePost = (post, pi, prefix) => {
               (post.data?.files || []).forEach((file, fi) => {
                  // Honour the scraper's fileId if already a non-empty string.
                  // Per-post integers like 0, 1, 2 are NOT globally unique so
                  // we always override those with a position-based string key.
                  if (!file.fileId || typeof file.fileId !== "string") {
                     file.fileId = `${prefix}-${pi}:${fi}`;
                  }
               });
            };
            (cat.posts || []).forEach((post, pi) => normalisePost(post, pi, `${mi}-${ci}`));
            (cat.subcategories || []).forEach((sub, si) => {
               (sub.posts || []).forEach((post, pi) => normalisePost(post, pi, `${mi}-${ci}-${si}`));
            });
         });
      });

      this.model = memberships.map((membership) => ({ membership }));

      if (!skipDefaultSelection) {
         this.selected = new Set(this.model.flatMap((m) => this._membershipUnits(m)));
      }
      if (this.model.length) this.open.add(this.model[0].membership.id);
      this._buildFileIndex();
   };

   // ─── SELECTION UNITS ──────────────────────────────────────────────────────
   // Selection is keyed by post._id throughout

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

   // ─── SIZE STATS ───────────────────────────────────────────────────────────

   _postStat = (post) => this._sumFiles(post.data?.files || []);

   _subStat = (sub) =>
      (sub.posts || []).reduce((t, p) => this._addStat(t, this._postStat(p)), this._empty());

   _catStat = (cat) => {
      const fromPosts = (cat.posts || []).reduce((t, p) => this._addStat(t, this._postStat(p)), this._empty());
      const fromSubs = (cat.subcategories || []).reduce((t, s) => this._addStat(t, this._subStat(s)), this._empty());
      return this._addStat(fromPosts, fromSubs);
   };

   _membershipStat = (m) =>
      m.membership.categories.reduce((t, cat) => this._addStat(t, this._catStat(cat)), this._empty());

   _selectionStat = () => {
      let total = this._empty();
      this.model.forEach(({ membership }) => {
         membership.categories.forEach((cat) => {
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

   _chevHtml = (id) =>
      `<button class="chev" data-toggle="${id}" aria-expanded="${this.open.has(id)}" aria-label="${this.open.has(id) ? "Collapse" : "Expand"}">${this.chevron}</button>`;

   _checkHtml = (ids, label) =>
      `<label class="chk"><input type="checkbox" data-ids="${this.esc(ids.join(","))}" data-state="${this._stateOf(ids)}"><span class="ct">${this.esc(label)}</span></label>`;

   _postDownloadStatus = (post) => {
      const files = (post.data?.files || []).filter((f) => f.fileId);
      // No CDN files — check the lesson-level status stamped when the sentinel fires
      if (!files.length) return this.fileStatus.get(`lesson:${post._id}`) ?? undefined;
      const statuses = files.map((f) => this.fileStatus.get(f.fileId));
      if (statuses.some((s) => s === "downloading")) return "downloading";
      if (statuses.some((s) => s === "failed")) return "failed";
      if (statuses.every((s) => s === "done")) return "done";
      // Also check lesson-level — all files done but sentinel not yet fired
      return this.fileStatus.get(`lesson:${post._id}`) ?? undefined;
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

   // O(n) post lookup — used infrequently (status checks, retry)
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

      const remeasureBtn = this.$("#btn-remeasure");
      if (remeasureBtn) {
         const busy = this._backupRunning || this._measuring ||
            (this._measureTotal > 0 && this._measureDone < this._measureTotal);
         remeasureBtn.disabled = busy;
         remeasureBtn.title = busy ? "Measuring in progress…" : "Re-measure file sizes";
      }

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
      const measuring = this._measuring || (this._measureTotal > 0 && this._measureDone < this._measureTotal);

      const unknownCount = (() => {
         let n = 0;
         this.model.forEach(({ membership }) => {
            const count = (files) => (files || []).forEach((f) => { if (f.url && f.size === null) n++; });
            membership.categories.forEach((cat) => {
               (cat.posts || []).forEach((post) => count(post.data?.files));
               (cat.subcategories || []).forEach((sub) =>
                  (sub.posts || []).forEach((post) => count(post.data?.files)));
            });
         });
         return n;
      })();

      const note = measuring
         ? `Measuring sizes &middot; ${this._measureDone} of ${this._measureTotal} files (${this._measureTotal > 0 ? Math.round((this._measureDone / this._measureTotal) * 100) : 0}%)`
         : unknownCount
            ? `${this.plural(unknownCount, "file", "files")} could not be measured and ${unknownCount === 1 ? "is" : "are"} not counted. They are still backed up.`
            : "All sizes measured.";

      const canBackup = nSelected > 0 && !measuring;
      const hasStatus = this.fileStatus.size > 0;
      const savedDest = (() => { try { return localStorage.getItem(LS_DEST_KEY); } catch (_) { return null; } })();
      const btnLabel = hasStatus && savedDest ? "Resume backup" : "Start backup";
      const sizeLabel = stat.pending
         ? `<span class="meas"></span>`
         : `<span class="sum-size">${this._format(stat.bytes).replace(/\s/, "<em>")}B</em></span>`;

      this.$("#bottom-in").innerHTML = `
         <div class="sum">
            ${sizeLabel}
            <span class="sum-detail">${this.plural(nSelected, "post", "posts")} selected</span>
            <p class="muted small" style="margin-left:auto">${note}</p>
         </div>
         <button class="btn primary" id="btn-backup" ${canBackup ? "" : "disabled"} title="${canBackup ? "Choose where to save" : "Waiting for sizes to finish measuring"}">${btnLabel}</button>`;

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

   // ─── PER-POST RETRY ───────────────────────────────────────────────────────

   _retryPost = (postId) => {
      const post = this._findPost(postId);
      if (!post) return;
      // Clear only this post's failed file statuses — other posts' statuses are
      // preserved. The orchestrator receives retryPostId and skips failed files
      // belonging to other posts so they are not re-downloaded.
      (post.data?.files || []).forEach((file) => {
         const key = file.fileId;
         if (key && this.fileStatus.get(key) === "failed") {
            this.fileStatus.delete(key);
         }
      });
      // Also clear the lesson-level sentinel key so the row resets properly
      this.fileStatus.delete(`lesson:${postId}`);
      this._saveFileStatus();
      const savedDest = (() => { try { return localStorage.getItem(LS_DEST_KEY); } catch (_) { return null; } })();
      if (savedDest === "drive") this._onPickDrive({ resumeAtPostId: postId, retryPostId: postId });
      else this._onPickLocal({ resumeAtPostId: postId, retryPostId: postId });
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
         try {
            localStorage.removeItem(LS_KEY);
            localStorage.removeItem(LS_DEST_KEY);
         } catch (_) { }
         this._showDestinationPicker();
      });

      this.$("#dest-local").addEventListener("click", () => {
         this._hideDestinationPicker();
         this._showSetupModal();
      });
      this.$("#dest-drive").addEventListener("click", () => {
         this._hideDestinationPicker();
         this._showDriveModal();
      });

      this.$("#drive-close").addEventListener("click", () => this._hideDriveModal());
      this.$("#drive-scrim").addEventListener("click", (e) => {
         if (e.target === this.$("#drive-scrim")) this._hideDriveModal();
      });
      this.$("#drive-switch-account").addEventListener("click", async () => {
         this._hideDriveModal();
         const ok = await this._connectDrive(true);
         if (ok) this._showDriveModal();
      });
      this.$("#drive-continue").addEventListener("click", async () => {
         this._hideDriveModal();
         await this._onPickDrive();
      });

      this.$("#setup-close").addEventListener("click", () => this._hideSetupModal());
      this.$("#setup-cancel").addEventListener("click", () => this._hideSetupModal());
      this.$("#setup-confirm").addEventListener("click", () => {
         this._hideSetupModal();
         this._onPickLocal();
      });
      this.$("#setup-open-settings").addEventListener("click", () => {
         chrome.runtime.sendMessage({ type: "open-chrome-settings" });
      });
      this.$("#setup-scrim").addEventListener("click", (e) => {
         if (e.target === this.$("#setup-scrim")) this._hideSetupModal();
      });
   };

   // ─── DESTINATION PICKER ───────────────────────────────────────────────────

   _showDestinationPicker = () => { this.$("#dest-scrim").hidden = false; };
   _hideDestinationPicker = () => { this.$("#dest-scrim").hidden = true; };

   // ─── RESUME MODAL ─────────────────────────────────────────────────────────

   _showResumeModal = (savedDest) => {
      const hint = this.$("#resume-dest-hint");
      if (hint) {
         hint.textContent = savedDest === "drive"
            ? "Previous destination: Google Drive."
            : savedDest === "local"
               ? "Previous destination: Local (Downloads folder)."
               : "";
      }
      this.$("#resume-scrim").hidden = false;
   };

   _hideResumeModal = () => { this.$("#resume-scrim").hidden = true; };

   _showSetupModal = () => { this.$("#setup-scrim").hidden = false; };
   _hideSetupModal = () => { this.$("#setup-scrim").hidden = true; };

   // ─── DRIVE MODAL ──────────────────────────────────────────────────────────

   _showDriveModal = async () => {
      this.$("#drive-scrim").hidden = false;
      const storageRow = this.$("#drive-storage-row");
      storageRow.innerHTML = "";

      const state = await chrome.runtime.sendMessage({ type: "get-drive-state" });
      const accountRow = this.$("#drive-account-row");
      if (state?.connected && state.email) {
         this.$("#drive-account-email").textContent = state.email;
         accountRow.hidden = false;
      } else {
         accountRow.hidden = true;
      }
      this.$("#drive-continue").textContent = state?.connected ? "Continue" : "Sign in & continue";

      if (state?.connected) {
         this.$("#drive-continue").disabled = true;
         this.$("#drive-continue").title = "Checking available storage…";
         storageRow.innerHTML = `<p class="drive-quota-warn muted">Checking available storage…</p>`;

         const selBytes = this._selectionStat().bytes;

         try {
            const quota = await chrome.runtime.sendMessage({ type: "get-drive-storage-quota" });
            if (!quota?.ok) throw new Error(quota?.error || "Quota check failed");
            const { limit, usage, free } = quota;
            const DAILY_LIMIT = 750 * 1024 * 1024 * 1024;

            const usedPct = limit ? Math.min(100, Math.round((usage / limit) * 100)) : null;
            const selPct = (limit && selBytes) ? Math.min(100, Math.round((selBytes / limit) * 100)) : null;
            const overStorage = free != null && selBytes > 0 && selBytes > free;
            const overDaily = selBytes > DAILY_LIMIT;

            const barHtml = limit ? `
               <div class="drive-quota-bar-wrap">
                  <div class="drive-quota-bar">
                     <div class="drive-quota-used" style="width:${usedPct}%"></div>
                     ${selPct ? `<div class="drive-quota-sel${overStorage ? " over" : ""}" style="width:${Math.min(selPct, 100 - usedPct)}%"></div>` : ""}
                  </div>
                  <div class="drive-quota-labels">
                     <span>${this._format(usage)} used of ${this._format(limit)}</span>
                     ${selBytes ? `<span class="drive-quota-sel-label${overStorage ? " bad" : ""}">${this._format(selBytes)} selected</span>` : ""}
                  </div>
               </div>` : "";

            const warnHtml = overStorage
               ? `<p class="drive-quota-warn bad">⚠️ Not enough free space. You have ${this._format(free)} free but the selection is ${this._format(selBytes)}.</p>`
               : overDaily
                  ? `<p class="drive-quota-warn warn">⚠️ Selection (${this._format(selBytes)}) exceeds the 750 GB daily upload limit. Split the backup into multiple sessions.</p>`
                  : selBytes && free != null
                     ? `<p class="drive-quota-warn good">✓ ${this._format(free)} free — enough for this backup.</p>`
                     : "";

            storageRow.innerHTML = barHtml + warnHtml;

            if (overStorage) {
               this.$("#drive-continue").disabled = true;
               this.$("#drive-continue").title = "Not enough free space in Google Drive";
            } else {
               this.$("#drive-continue").disabled = false;
               this.$("#drive-continue").title = "";
            }
         } catch (err) {
            storageRow.innerHTML = `<p class="drive-quota-warn bad">⚠️ Could not check available storage. Please close and reopen to retry.</p>`;
            this.$("#drive-continue").disabled = true;
            this.$("#drive-continue").title = "Storage check failed — close and reopen to retry";
         }
      }
   };

   _hideDriveModal = () => { this.$("#drive-scrim").hidden = true; };

   // ─── BACKUP HELPERS ───────────────────────────────────────────────────────

   _makeFileStatusCallback = () => (fileId, status) => {
      this.fileStatus.set(fileId, status);
      this._saveFileStatus();
      this._schedule();
   };

   _cleanupStuckDownloading = () => {
      for (const [fileId, status] of this.fileStatus) {
         if (status === "downloading") this.fileStatus.set(fileId, "failed");
      }
      this._saveFileStatus();
   };

   _makeProgressHandler = () => (info) => {
      if (info.lessonId) {
         if (info.status === "downloading") {
            this.backupActivePostId = info.lessonId;
         } else if (info.status === "lesson-done") {
            this.backupActivePostId = null;
            // Mark the post itself as done so posts with no CDN files still glow
            this.fileStatus.set(`lesson:${info.lessonId}`, "done");
            this._saveFileStatus();
         } else if (info.status === "lesson-failed") {
            this.backupActivePostId = null;
            this.fileStatus.set(`lesson:${info.lessonId}`, "failed");
            this._saveFileStatus();
         }
      }
      this._setBackupProgress(info);
      this._schedule();
   };

   /**
    * After a backup finishes, opens every drawer that contains at least one
    * failed post so the user can immediately see what needs to be retried.
    */
   _openFailedDrawers = () => {
      this.model.forEach(({ membership }) => {
         let memHasFail = false;
         membership.categories.forEach((cat) => {
            let catHasFail = false;
            (cat.subcategories || []).forEach((sub) => {
               const subHasFail = (sub.posts || []).some(
                  (p) => this._postDownloadStatus(p) === "failed"
               );
               if (subHasFail) { this.open.add(sub._id); catHasFail = true; }
            });
            const directFail = (cat.posts || []).some(
               (p) => this._postDownloadStatus(p) === "failed"
            );
            if (directFail) catHasFail = true;
            if (catHasFail) { this.open.add(cat._id); memHasFail = true; }
         });
         if (memHasFail) this.open.add(membership.id);
      });
   };

   _makeOnDone = (dest) => (summary) => {
      this._activeBackup = null;
      this.backupActivePostId = null;
      const wasCancelled = this._cancelling;
      this._cancelling = false;
      this._backupRunning = false;
      if (!wasCancelled && !summary?.cancelled) {
         this._cleanupStuckDownloading();
         this._openFailedDrawers();
      }
      this._draw();
      this._setBackupDone(summary, dest);
   };

   _makeOnError = () => (error) => {
      this._activeBackup = null;
      this.backupActivePostId = null;
      const wasCancelled = this._cancelling;
      this._cancelling = false;
      this._backupRunning = false;
      if (!wasCancelled) {
         this._cleanupStuckDownloading();
         this._openFailedDrawers();
      }
      this._draw();
      this._setBackupError(error);
   };

   // ─── LOCAL DESTINATION ────────────────────────────────────────────────────

   _onPickLocal = async ({ resumeAtPostId = null, retryPostId = null } = {}) => {
      this._hideDestinationPicker();

      try { localStorage.setItem(LS_DEST_KEY, "local"); } catch (_) { }
      this.backupActivePostId = null;
      this._backupRunning = true;
      this._draw();

      const memberships = this.model
         .filter((m) => this._membershipUnits(m).some((id) => this.selected.has(id)))
         .map((m) => m.membership);
      const rootFolder = (this.$("#root-folder")?.value?.trim()) || "Kartra Backup";
      try { localStorage.setItem(LS_ROOT_KEY, rootFolder); } catch (_) { }

      this._setBackupProgress({ done: 0, total: 0 });

      this._activeBackup = new LocalBackup({
         memberships,
         selected: this.selected,
         rootFolder,
         onFileStatus: this._makeFileStatusCallback(),
         getFileStatus: (fileId) => this.fileStatus.get(fileId),
         onProgress: this._makeProgressHandler(),
         onDone: this._makeOnDone("local"),
         onError: this._makeOnError(),
         resumeAtPostId,
         retryPostId,
      });
   };

   // ─── DRIVE DESTINATION ────────────────────────────────────────────────────

   _connectDrive = async (forceNew = false) => {
      if (!forceNew) {
         const state = await chrome.runtime.sendMessage({ type: "get-drive-state" });
         if (state?.connected) return true;
      }
      const result = await chrome.runtime.sendMessage({ type: "connect-drive" });
      if (!result?.ok) {
         this._setBackupError(new Error(result?.error || "Google Drive sign-in failed. Please try again."));
         return false;
      }
      return true;
   };

   _onPickDrive = async ({ resumeAtPostId = null, retryPostId = null } = {}) => {
      const ok = await this._connectDrive();
      if (!ok) return;

      try { localStorage.setItem(LS_DEST_KEY, "drive"); } catch (_) { }
      this.backupActivePostId = null;
      this._backupRunning = true;
      this._draw();

      const memberships = this.model
         .filter((m) => this._membershipUnits(m).some((id) => this.selected.has(id)))
         .map((m) => m.membership);
      const rootFolder = (this.$("#root-folder")?.value?.trim()) || "Kartra Backup";
      try { localStorage.setItem(LS_ROOT_KEY, rootFolder); } catch (_) { }

      this._setBackupProgress({ done: 0, total: 0 });

      this._activeBackup = new DriveBackup({
         memberships,
         selected: this.selected,
         rootFolder,
         onFileStatus: this._makeFileStatusCallback(),
         getFileStatus: (fileId) => this.fileStatus.get(fileId),
         onProgress: this._makeProgressHandler(),
         onDone: this._makeOnDone("drive"),
         onError: this._makeOnError(),
         resumeAtPostId,
         retryPostId,
      });
   };

   // ─── BACKUP BAR ───────────────────────────────────────────────────────────

   _setBackupProgress = (info) => {
      const { done = 0, total = 0, lessonTitle = "", fileName = "" } = info;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const what = lessonTitle ? `${lessonTitle} — ${fileName}` : "Preparing…";
      const cancelBtn = this._cancelling
         ? `<button class="btn" id="btn-cancel-backup" disabled>Cancelling…</button>`
         : `<button class="btn" id="btn-cancel-backup">Cancel</button>`;
      this.$("#bottom-in").innerHTML = `
         <div class="sum">
            <div class="sumtop"><strong>Backing up &middot; ${done} of ${total} files (${pct}%)</strong></div>
            <p class="muted small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${what}</p>
            <div class="track" style="margin-top:6px"><i style="width:${pct}%"></i></div>
         </div>
         ${cancelBtn}`;
      this.$("#bottom").hidden = false;
      if (!this._cancelling) {
         this.$("#btn-cancel-backup").addEventListener("click", () => {
            this._cancelling = true;
            this._activeBackup?.cancel();
            this.fileStatus.clear();
            try {
               localStorage.removeItem(LS_KEY);
               localStorage.removeItem(LS_DEST_KEY);
               localStorage.removeItem(LS_ROOT_KEY);
               localStorage.removeItem(LS_SELECTED_KEY);
            } catch (_) { }
            this.$("#btn-cancel-backup").disabled = true;
            this.$("#btn-cancel-backup").textContent = "Cancelling…";
         });
      }
   };

   _setBackupDone = ({ saved, failed, cancelled } = {}, dest = "local") => {
      // Only clear persisted status when there's nothing left to retry.
      // Use the live fileStatus map (not just this run's failed count) so that
      // a partial resume run that fixed some posts doesn't wipe the statuses of
      // other posts that are still "failed" from a previous run.
      const hasRemainingFails = [...this.fileStatus.values()].some((s) => s === "failed");
      if (!cancelled && !hasRemainingFails) {
         this.fileStatus.clear();
         try {
            localStorage.removeItem(LS_KEY);
            localStorage.removeItem(LS_DEST_KEY);
         } catch (_) { }
      }

      const location = dest === "drive" ? "Google Drive" : "your Downloads folder";
      const detail = cancelled
         ? `Cancelled. ${saved} file${saved === 1 ? "" : "s"} saved before stopping.`
         : failed
            ? `${saved} file${saved === 1 ? "" : "s"} saved, ${failed} failed.`
            : `All ${saved} file${saved === 1 ? "" : "s"} saved successfully.`;

      const retryBtn = !cancelled && failed > 0
         ? `<button class="btn" id="btn-retry-failed">Retry ${failed} failed</button>`
         : "";

      this.$("#bottom-in").innerHTML = `
         <div class="sum">
            <strong>Backup complete.</strong>
            <p class="muted small">${detail} Files are in ${location}.</p>
         </div>
         <div style="display:flex;gap:8px;flex-shrink:0">
            ${retryBtn}
            <button class="btn primary" id="btn-new-backup">Back up again</button>
         </div>`;

      this.$("#btn-new-backup").addEventListener("click", () => {
         this.fileStatus.clear();
         try {
            localStorage.removeItem(LS_KEY);
            localStorage.removeItem(LS_DEST_KEY);
            localStorage.removeItem(LS_ROOT_KEY);
            localStorage.removeItem(LS_SELECTED_KEY);
         } catch (_) { }
         this._showDestinationPicker();
      });

      if (!cancelled && failed > 0) {
         this.$("#btn-retry-failed").addEventListener("click", () => {
            if (dest === "drive") this._onPickDrive();
            else this._onPickLocal();
         });
      }
   };

   _setBackupError = (error) => {
      const isSetting = error && error.settingEnabled;
      const msg = isSetting
         ? `<strong>Automatic downloads are blocked by Chrome.</strong>
            <p class="muted small">
               Go to <a href="chrome://settings/downloads" target="_blank" style="color:var(--accent)">chrome://settings/downloads</a>
               and turn off <em>"Ask where to save each file before downloading"</em>, then click Start backup again.
            </p>`
         : `<strong>Backup failed.</strong>
            <p class="muted small" style="color:var(--bad)">${error && error.message ? error.message : String(error)}</p>`;

      this.$("#bottom-in").innerHTML = `
         <div class="sum">${msg}</div>
         <button class="btn primary" id="btn-backup">Try again</button>`;
      this.$("#btn-backup").addEventListener("click", () => this._showDestinationPicker());
   };

   // ─── RE-MEASURE ───────────────────────────────────────────────────────────

   _remeasure = async () => {
      if (this._backupRunning || this._measuring) return;
      this._measuring = true;

      // Clear backup state so UI resets to "Start backup"
      this.fileStatus.clear();
      try {
         localStorage.removeItem(LS_KEY);
         localStorage.removeItem(LS_DEST_KEY);
      } catch (_) { }
      this._schedule();

      try {
         // Clear the sizes IDB store and wait for it before re-measuring
         await new Promise((resolve) => {
            this._openDb().then((db) => {
               const tx = db.transaction("sizes", "readwrite");
               tx.objectStore("sizes").clear();
               tx.oncomplete = resolve;
               tx.onerror = resolve;
            }).catch(resolve);
         });

         // Reset in-memory sizes so _collectMeasureWork treats them as unsized
         this.model.forEach(({ membership }) => {
            const reset = (files) => (files || []).forEach((file) => { delete file.size; });
            membership.categories.forEach((cat) => {
               (cat.posts || []).forEach((post) => reset(post.data?.files));
               (cat.subcategories || []).forEach((sub) =>
                  (sub.posts || []).forEach((post) => reset(post.data?.files)));
            });
         });

         this._measureTotal = 0;
         this._measureDone = 0;
         this._schedule();
         await this._measureAll();
      } catch (err) {
         console.error("[Kartra Backup] _remeasure error", err);
      } finally {
         this._measuring = false;
         this._schedule();
      }
   };

   // ─── START ────────────────────────────────────────────────────────────────

   _start = async () => {
      this._initEvents();

      const actions = this.$("#top-actions");
      if (actions) {
         actions.innerHTML = `
            <button class="btn" id="btn-remeasure" title="Re-measure file sizes">Re-measure</button>
            <button class="btn" id="btn-sign-out" title="Sign out">Sign out</button>`;
         this.$("#btn-remeasure")?.addEventListener("click", () => this._remeasure());
         this.$("#btn-sign-out")?.addEventListener("click", async () => {
            await chrome.runtime.sendMessage({ type: "auth-sign-out" });
            window.close();
         });
      }

      // Verify session
      const me = await chrome.runtime.sendMessage({ type: "auth-get-me" }).catch(() => null);
      if (!me?.ok) {
         this.$("#sub").textContent = "Session expired";
         this.$("#tree").innerHTML = `
            <div class="state">
               <strong>Session expired</strong>
               <p>Your session has expired. Close this tab, open the extension popup, and sign in again.</p>
            </div>`;
         return;
      }

      const meta = await this._dbGet("meta", "scan");
      if (!meta) {
         this.$("#sub").textContent = "No scan yet";
         this.$("#tree").innerHTML = `
            <div class="state">
               <strong>Nothing to show yet</strong>
               <p>Open Kartra, click <em>Back up memberships</em>, then <em>Scrape memberships</em>.</p>
            </div>`;
         return;
      }

      const memberships = (await this._dbAll("scan")).slice(0, meta.count);
      this._scanSavedAt = meta.savedAt;
      this.$("#sub").textContent = `${this.plural(memberships.length, "membership", "memberships")} · ${new Date(meta.savedAt).toLocaleString()}`;

      // Restore persisted folder name
      try {
         const savedRoot = localStorage.getItem(LS_ROOT_KEY);
         if (savedRoot) {
            const input = this.$("#root-folder");
            if (input) input.value = savedRoot;
         }
      } catch (_) { }

      this._buildModel(memberships, true);
      const hadSelection = this._loadSelected();
      if (!hadSelection) {
         this.selected = new Set(this.model.flatMap((m) => this._membershipUnits(m)));
         this._saveSelected();
      }
      this._loadFileStatus();
      this._draw();

      // Kick off initial measurement
      this._measuring = true;
      this._draw();
      try {
         await this._measureAll();
      } catch (err) {
         console.error("[Kartra Backup] initial measure error", err);
      } finally {
         this._measuring = false;
         this._draw();
      }

      // Prompt resume if there's a previous run
      const savedDest = (() => { try { return localStorage.getItem(LS_DEST_KEY); } catch (_) { return null; } })();
      if (this.fileStatus.size > 0 && savedDest) {
         this._showResumeModal(savedDest);
      }
   };
}

window.__dashboard = new KartraDashboard();
