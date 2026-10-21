/**
 * CourseDashboard — dashboard.js
 *
 * Reads the scan the background saved into IndexedDB, draws the course tree
 * with checkboxes, measures every file size, and shows the sizes live in the
 * rows and in the bottom bar.
 *
 * Data responsibilities:
 *   "scan" store    — raw course objects, immutable after scrape. Never written
 *                     back by the dashboard. File objects carry stable fileIds.
 *   "sizes" store   — file size cache, keyed by fileId. Written once per file
 *                     during measuring. Cleared on fresh scrape.
 *   this.fileStatus — Map<fileId, "downloading"|"done"|"failed">. Persisted to
 *                     localStorage so a page reload resumes where it left off.
 *                     Cleared on new scrape or when a new backup run starts.
 */

const _PLATFORM = chrome.runtime.getManifest().name.toLowerCase().replace(/\s+/g, "-");
const LS_KEY = `${_PLATFORM}_fileStatus`;
const LS_DEST_KEY = `${_PLATFORM}_destination`;
const LS_ROOT_KEY = `${_PLATFORM}_rootFolder`;
const LS_SELECTED_KEY = `${_PLATFORM}_selected`;

class CourseDashboard {
   constructor() {
      // First, constants
      this.TRIES = 3;

      // Then, shared helpers
      this.$ = (sel) => document.querySelector(sel);
      this.esc = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
      this.plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
      this.chevron = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';

      // Then, tree state
      this.model = [];
      this.empties = new Set();
      this.selected = new Set();
      this.open = new Set();

      // Then, rAF handle for throttled redraws
      this.rafId = 0;

      // Then, download status — in memory only, never written to IndexedDB
      // Map<fileId, "downloading"|"done"|"failed">
      this.fileStatus = new Map();

      // Then, backup state
      this._backupRunning = false;
      this.backupActiveLessonId = null;
      this._activeBackup = null;

      // Then, measuring state (for bottom bar progress note)
      this._measureTotal = 0;
      this._measureDone = 0;

      // Finally, start
      this._start();
   }

   // ─── DATABASE ────────────────────────────────────────────────────────────────

   /**
    * Opens the platform-specific IndexedDB database.
    * DB name derived from manifest so it matches db.js and never conflicts
    * with other platform extensions. "Kajabi Backup" → "kajabi-backup"
    */
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

   /** Fire-and-forget write — used only for the sizes store during measuring. */
   _dbSet = (store, key, value) => {
      this._openDb().then((db) => {
         db.transaction(store, "readwrite").objectStore(store).put(value, key);
      }).catch((err) => console.warn("[db] _dbSet failed:", store, key, err));
   };

   // ─── FILE INDEX ──────────────────────────────────────────────────────────────

   /**
    * Persists fileStatus + the current scan's savedAt to localStorage.
    * savedAt is used on reload to detect stale data from a previous scrape.
    */
   _saveFileStatus = () => {
      try {
         localStorage.setItem(LS_KEY, JSON.stringify({
            savedAt: this._scanSavedAt,
            entries: [...this.fileStatus.entries()],
         }));
      } catch (_) { }
   };

   /**
    * Loads persisted fileStatus from localStorage.
    * Discards the data if the savedAt doesn't match the current scan's savedAt
    * — that means the user re-scraped and this data is from an old session.
    */
   _loadFileStatus = () => {
      try {
         const raw = localStorage.getItem(LS_KEY);
         if (!raw) return;
         const data = JSON.parse(raw);
         if (!data || !Array.isArray(data.entries)) return;
         // Stale check — savedAt must match the current scan
         if (data.savedAt !== this._scanSavedAt) {
            console.log("[loadFileStatus] stale — stored savedAt:", data.savedAt, "current:", this._scanSavedAt);
            localStorage.removeItem(LS_KEY);
            localStorage.removeItem(LS_DEST_KEY);
            localStorage.removeItem(LS_ROOT_KEY);
            return;
         }
         data.entries.forEach(([fileId, status]) => {
            if (this._fileIndex?.has(fileId)) {
               this.fileStatus.set(fileId, status === "downloading" ? "failed" : status);
            }
         });
         console.log("[loadFileStatus] restored", this.fileStatus.size, "entries. sample:", [...this.fileStatus.entries()].slice(0, 3));
         // Persist the cleaned-up statuses (downloading → failed) back to localStorage
         this._saveFileStatus();
      } catch (_) { }
   };

   /**
    * Persists the current selected set to localStorage, tagged with savedAt
    * so stale data from a previous scrape is automatically discarded.
    */
   _saveSelected = () => {
      try {
         localStorage.setItem(LS_SELECTED_KEY, JSON.stringify({
            savedAt: this._scanSavedAt,
            ids: [...this.selected],
         }));
      } catch (_) { }
   };

   /**
    * Restores the selected set from localStorage.
    * Returns true when a valid, non-stale selection was found and applied,
    * so the caller knows NOT to fall back to select-all.
    */
   _loadSelected = () => {
      try {
         const raw = localStorage.getItem(LS_SELECTED_KEY);
         if (!raw) return false;
         const data = JSON.parse(raw);
         if (!data || !Array.isArray(data.ids)) return false;
         // Stale check — must match the current scan
         if (data.savedAt !== this._scanSavedAt) {
            localStorage.removeItem(LS_SELECTED_KEY);
            return false;
         }
         // Only keep ids that still exist in the current model
         const allUnits = new Set(this.model.flatMap((c) => this._courseUnits(c)));
         this.selected = new Set(data.ids.filter((id) => allUnits.has(id)));
         return true;
      } catch (_) {
         return false;
      }
   };

   /**
    * Builds Map<fileId, { file, courseIndex }> for O(1) lookup by fileId.
    * Called once from _buildModel after the model is constructed.
    */
   _buildFileIndex = () => {
      this._fileIndex = new Map();
      this.model.forEach(({ course }, courseIndex) => {
         const register = (files) => (files || []).forEach((file) => {
            if (file.fileId) this._fileIndex.set(file.fileId, { file, courseIndex });
         });
         register(course.files);
         course.categories.forEach((cat) => {
            register(cat.files);
            (cat.posts || []).forEach((post) => register(post.files));
         });
      });
   };

   // ─── MEASURING ───────────────────────────────────────────────────────────────

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
         } catch (_) { /* network error, try again */ }
         await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
      return null;
   };

   /**
    * Groups file objects by url-without-qs so one network request covers all
    * files sharing the same URL. Returns { todo, total, alreadyDone }.
    * "Already done" means at least one fileId in the group has a size in the
    * sizes store (loaded into file.size during _start).
    */
   _collectMeasureWork = () => {
      const byUrl = new Map();
      const visit = (files) => (files || []).forEach((file) => {
         if (!file.url || !file.fileId) return;
         const key = file.url.split("?")[0];
         if (!byUrl.has(key)) byUrl.set(key, { url: file.url, fileIds: [], alreadySized: true });
         byUrl.get(key).fileIds.push(file.fileId);
         // If any file with this url is unsized, the whole group needs measuring
         if (file.size === undefined) byUrl.get(key).alreadySized = false;
      });
      this.model.forEach(({ course }) => {
         visit(course.files);
         course.categories.forEach((cat) => {
            visit(cat.files);
            (cat.posts || []).forEach((post) => visit(post.files));
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

   /**
    * Loads cached sizes from the "sizes" store into file objects, then measures
    * any remaining files via HTTP Range requests.
    * Sizes are written to the "sizes" store (keyed by fileId) and stamped onto
    * file.size in memory. The "scan" store is never written by this method.
    */
   _measureAll = async () => {
      // First, load cached sizes from the sizes store into file objects
      this.model.forEach(({ course }) => {
         const load = (files) => (files || []).forEach(async (file) => {
            if (!file.fileId || file.size !== undefined) return;
            const cached = await this._dbGet("sizes", file.fileId);
            if (cached !== undefined) {
               file.size = cached;
               this._measureDone++;
               this._schedule();
            }
         });
         load(course.files);
         course.categories.forEach((cat) => {
            load(cat.files);
            (cat.posts || []).forEach((post) => load(post.files));
         });
      });

      // Then, collect what still needs measuring after cache load
      // Small delay to let async cache loads settle before counting
      await new Promise((r) => setTimeout(r, 50));

      const { todo, total, alreadyDone } = this._collectMeasureWork();
      this._measureTotal = total;
      this._measureDone = alreadyDone;
      this._schedule();

      let next = 0;
      const worker = async () => {
         while (next < todo.length) {
            const { url, fileIds } = todo[next++];
            const size = await this._getFileSize(url);
            const val = size ?? null;
            // Stamp size on all file objects sharing this url and write to sizes store
            fileIds.forEach((id) => {
               const entry = this._fileIndex?.get(id);
               if (entry) entry.file.size = val;
               this._dbSet("sizes", id, val);
            });
            this._measureDone++;
            this._schedule();
         }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      this._schedule();
   };

   // ─── SIZE HELPERS ────────────────────────────────────────────────────────────

   _format = (bytes) => {
      const units = ["B", "KB", "MB", "GB", "TB"];
      let n = bytes, i = 0;
      while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
      return `${i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
   };

   /** Reads file.size — undefined = pending, null = unknown, number = known. */
   _sumFiles = (files = []) =>
      files.reduce((total, file) => {
         if (!file.url) return total;
         if (file.size === undefined) total.pending++;
         else if (file.size === null) total.unknown++;
         else total.bytes += file.size;
         return total;
      }, { bytes: 0, pending: 0, unknown: 0 });

   _textBytes = (text) => ({ bytes: new Blob([text || ""]).size, pending: 0, unknown: 0 });
   _addStat = (a, b) => ({ bytes: a.bytes + b.bytes, pending: a.pending + b.pending, unknown: a.unknown + b.unknown });
   _empty = () => ({ bytes: 0, pending: 0, unknown: 0 });

   _sizeHtml = (stat) =>
      stat.pending
         ? '<span class="meas" aria-label="measuring"></span>'
         : this._format(stat.bytes) + (stat.unknown ? '<span class="unk" title="A file size could not be read"> +?</span>' : "");

   // ─── TREE MODEL ──────────────────────────────────────────────────────────────

   _buildModel = (courses, skipDefaultSelection = false) => {
      this.model = courses.map((course) => ({
         id: course.id,
         course,
         categories: course.categories.map((category) => {
            if (category.emptyId) this.empties.add(category.emptyId);
            return {
               id: category.id,
               category,
               emptyId: category.emptyId || null,
               lessons: (category.posts || []).map((post) => ({ id: post.id, post })),
            };
         }),
      }));
      // Only select-all when there is no persisted selection to restore
      if (!skipDefaultSelection) {
         this.selected = new Set(this.model.flatMap((c) => this._courseUnits(c)));
      }
      if (this.model.length) this.open.add(this.model[0].id);
      this._buildFileIndex();
   };

   _catUnits = (k) => k.emptyId ? [k.emptyId] : k.lessons.map((l) => l.id);
   _courseUnits = (c) => c.categories.flatMap((k) => this._catUnits(k));
   _stateOf = (ids) => {
      const n = ids.filter((i) => this.selected.has(i)).length;
      return n === 0 ? "none" : n === ids.length ? "all" : "some";
   };

   // ─── SIZE STATS ──────────────────────────────────────────────────────────────

   _lessonStat = (l) => this._addStat(this._sumFiles(l.post.files), this._textBytes(l.post.body));
   _categoryStat = (k) => k.lessons.reduce((t, l) => this._addStat(t, this._lessonStat(l)), this._sumFiles(k.category.files));
   _courseStat = (c) => c.categories.reduce((t, k) => this._addStat(t, this._categoryStat(k)), this._sumFiles(c.course.files));

   _selectionStat = () => {
      let total = this._empty();
      this.model.forEach((c) => {
         let courseHas = false;
         c.categories.forEach((k) => {
            const picked = k.emptyId
               ? this.selected.has(k.emptyId)
               : k.lessons.some((l) => this.selected.has(l.id));
            if (!picked) return;
            k.lessons.filter((l) => this.selected.has(l.id)).forEach((l) => (total = this._addStat(total, this._lessonStat(l))));
            total = this._addStat(total, this._sumFiles(k.category.files));
            courseHas = true;
         });
         if (courseHas) total = this._addStat(total, this._sumFiles(c.course.files));
      });
      return total;
   };

   // ─── HTML BUILDERS ───────────────────────────────────────────────────────────

   _tagsOf = (post) => {
      const types = (post.included || []).map((item) => item.type);
      const tags = [];
      if (post.publishing?.status === "draft") tags.push('<span class="tag draft">Draft</span>');
      if (types.includes("video")) tags.push("Video");
      if (types.includes("audio")) tags.push("Audio");
      if (post.body) tags.push("Text");
      if (post.posterImageUrl) tags.push("Thumbnail");
      if ((post.downloads || []).length) tags.push(`Downloads (${post.downloads.length})`);
      if (types.includes("quiz")) tags.push("Quiz");
      return tags.map((t) => t.startsWith("<") ? t : `<span class="tag">${this.esc(t)}</span>`).join("");
   };

   _chevHtml = (id) => `<button class="chev" data-toggle="${id}" aria-expanded="${this.open.has(id)}" aria-label="${this.open.has(id) ? "Collapse" : "Expand"}">${this.chevron}</button>`;
   _checkHtml = (ids, label) => `<label class="chk"><input type="checkbox" data-ids="${this.esc(ids.join(","))}" data-state="${this._stateOf(ids)}"><span class="ct">${this.esc(label)}</span></label>`;

   /**
    * Derives lesson-level download status from this.fileStatus.
    * "done"    — all CDN files in the lesson are done
    * "failed"  — any CDN file failed
    * "downloading" — any CDN file is currently downloading
    * undefined — no status yet
    */
   _lessonDownloadStatus = (post) => {
      const cdnFiles = (post.files || []).filter((f) => f.url && f.fileId);
      if (!cdnFiles.length) return undefined;
      const statuses = cdnFiles.map((f) => this.fileStatus.get(f.fileId));
      if (statuses.some((s) => s === "downloading")) return "downloading";
      if (statuses.some((s) => s === "failed")) return "failed";
      if (statuses.every((s) => s === "done")) return "done";
      return undefined;
   };

   _lessonHtml = (l) => {
      const lessonStatus = this._lessonDownloadStatus(l.post);
      const isActive = this.backupActiveLessonId === l.id;

      let badge = "";
      if (isActive || lessonStatus === "downloading")
         badge = '<span class="tag bk-active">Downloading…</span>';
      else if (lessonStatus === "done")
         badge = '<span class="tag bk-done">✓ Saved</span>';
      else if (lessonStatus === "failed")
         badge = '<span class="tag bk-fail">✗ Failed</span>';

      // Show a retry button on failed lessons when no backup is running.
      // Clicking it clears only this lesson's file statuses, then resumes
      // the backup — the orchestrator skips all "done" files so only
      // this lesson's failed files are re-attempted.
      const retryBtn = !this._backupRunning && lessonStatus === "failed"
         ? `<button class="btn-retry-lesson" data-retry-lesson="${this.esc(l.id)}" title="Retry this lesson">↺ Retry</button>`
         : "";

      const rowClass = isActive || lessonStatus === "downloading" ? " bk-row"
         : lessonStatus === "done" ? " bk-row-done"
            : lessonStatus === "failed" ? " bk-row-fail" : "";

      return `
      <div class="lesson${rowClass}">
         ${this._checkHtml([l.id], l.post.title || "Untitled lesson")}
         ${this._tagsOf(l.post)}
         ${badge}
         ${retryBtn}
         <span class="meta">${this._sizeHtml(this._lessonStat(l))}</span>
      </div>`;
   };

   _categoryHtml = (k) => {
      const picked = k.lessons.filter((l) => this.selected.has(l.id)).length;
      const hasCatFiles = (k.category.files || []).length > 0;
      const count = k.lessons.length
         ? `${picked ? picked + " of " : ""}${this.plural(k.lessons.length, "lesson", "lessons")}`
         : hasCatFiles ? "empty &middot; folder + thumbnail" : "empty &middot; folder only";
      const szPart = k.lessons.length || hasCatFiles
         ? ` &middot; ${this._sizeHtml(this._categoryStat(k))}`
         : "";

      const selLessons = k.lessons.filter((l) => this.selected.has(l.id));
      const catAllDone = this._backupRunning && (
         k.emptyId && this.selected.has(k.emptyId)
            ? (k.category.files || []).every((f) => f.fileId && this.fileStatus.get(f.fileId) === "done")
            : selLessons.length > 0 && selLessons.every((l) => this._lessonDownloadStatus(l.post) === "done")
      );

      return `
      <div class="cat${catAllDone ? " bk-cat-done" : ""}">
         <div class="crow">${this._chevHtml(k.id)}${this._checkHtml(this._catUnits(k), k.category.title || "Untitled category")}<span class="meta">${count}${szPart}</span></div>
         ${this.open.has(k.id) ? `<div class="lessons">${k.lessons.length
            ? k.lessons.map((l) => this._lessonHtml(l)).join("")
            : '<p class="skipped">No lessons — an empty-folder.txt will be created.</p>'
            }</div>` : ""}
      </div>`;
   };

   _courseHtml = (c) => {
      const all = c.categories.flatMap((k) => k.lessons);
      const picked = all.filter((l) => this.selected.has(l.id)).length;
      const count = `${this.plural(c.categories.length, "category", "categories")} &middot; ${picked ? picked + " of " : ""}${this.plural(all.length, "lesson", "lessons")}`;

      const selAll = all.filter((l) => this.selected.has(l.id));
      const courseAllDone = this._backupRunning && selAll.length > 0 &&
         selAll.every((l) => this._lessonDownloadStatus(l.post) === "done");

      return `
      <div class="course${courseAllDone ? " bk-course-done" : ""}">
         <div class="crow">${this._chevHtml(c.id)}${this._checkHtml(this._courseUnits(c), c.course.text || "Untitled course")}<span class="meta">${count} &middot; ${this._sizeHtml(this._courseStat(c))}</span></div>
         ${this.open.has(c.id) ? `<div class="cats">${c.categories.map((k) => this._categoryHtml(k)).join("")}</div>` : ""}
      </div>`;
   };

   // ─── DRAW ────────────────────────────────────────────────────────────────────

   _draw = () => {
      const scrollY = window.scrollY;

      this.$("#tree").innerHTML = this.model.map((c) => this._courseHtml(c)).join("")
         || '<div class="state"><p>No courses found.</p></div>';

      document.querySelectorAll("input[data-state]").forEach((input) => {
         input.checked = input.dataset.state === "all";
         input.indeterminate = input.dataset.state === "some";
         input.disabled = this._backupRunning;
      });
      const folderInput = this.$("#root-folder");
      if (folderInput) folderInput.disabled = this._backupRunning;

      // Keep the select-all checkbox in sync with the tree state
      const allUnits = this.model.flatMap((c) => this._courseUnits(c));
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

      const lessons = [...this.selected].filter((i) => !this.empties.has(i)).length;
      const folders = this.selected.size - lessons;
      const stat = this._selectionStat();
      const measuring = this._measureDone < this._measureTotal;
      const unknownCount = (() => {
         let n = 0;
         this.model.forEach(({ course }) => {
            const count = (files) => (files || []).forEach((f) => { if (f.url && f.size === null) n++; });
            count(course.files);
            course.categories.forEach((cat) => {
               count(cat.files);
               (cat.posts || []).forEach((post) => count(post.files));
            });
         });
         return n;
      })();

      const note = measuring
         ? `Measuring sizes &middot; ${this._measureDone} of ${this._measureTotal} files (${Math.round((this._measureDone / this._measureTotal) * 100)}%)`
         : unknownCount
            ? `${this.plural(unknownCount, "file", "files")} could not be measured and ${unknownCount === 1 ? "is" : "are"} not counted. They are still backed up.`
            : "All sizes measured.";

      const canBackup = !measuring && lessons > 0;
      const hasStatus = this.fileStatus.size > 0;
      const savedDest = (() => { try { return localStorage.getItem(LS_DEST_KEY); } catch (_) { return null; } })();
      const btnLabel = hasStatus ? "Resume backup" : "Start backup";
      const sizeLabel = stat.pending
         ? `<span class="meas"></span>`
         : `<span class="sum-size">${this._format(stat.bytes).replace(/\s/, "<em>")}B</em></span>`;

      this.$("#bottom-in").innerHTML = `
         <div class="sum">
            ${sizeLabel}
            <span class="sum-detail">${this.plural(lessons, "lesson", "lessons")} + ${this.plural(folders, "empty folder", "empty folders")} selected</span>
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
      this.rafId = requestAnimationFrame(() => {
         this.rafId = 0;
         this._draw();
      });
   };

   // ─── PER-LESSON RETRY ────────────────────────────────────────────────────────

   /**
    * Resets the file statuses for a single lesson's files from "failed" to
    * undefined (removes from the map), then resumes the backup.
    * The orchestrator skips all "done" files, so only this lesson's failed
    * files will be re-attempted.
    *
    * @param {string} lessonId  The lesson's post id
    */
   _retryLesson = (lessonId) => {
      // First, find the lesson's file objects via the file index
      const entry = this._fileIndex;
      if (!entry) return;

      // Then, clear only the "failed" statuses for this lesson's files so
      // _write will re-attempt them. "done" files in the same lesson stay
      // done and are still skipped by _write's getFileStatus check.
      this.model.forEach(({ course }) => {
         course.categories.forEach((category) => {
            (category.posts || []).forEach((post) => {
               if (String(post.id) !== String(lessonId)) return;
               (post.files || []).forEach((file) => {
                  if (file.fileId && this.fileStatus.get(file.fileId) === "failed") {
                     this.fileStatus.delete(file.fileId);
                  }
               });
            });
         });
      });

      this._saveFileStatus();

      // Finally, start the backup with resumeAtPostId so the orchestrator
      // jumps straight to this lesson without re-running anything before it.
      const savedDest = (() => { try { return localStorage.getItem(LS_DEST_KEY); } catch (_) { return null; } })();
      if (savedDest === "drive") this._onPickDrive({ resumeAtPostId: lessonId });
      else this._onPickLocal({ resumeAtPostId: lessonId });
   };

   // ─── EVENTS ──────────────────────────────────────────────────────────────────

   _initEvents = () => {
      // Select-all checkbox above the tree
      this.$("#select-all-checkbox").addEventListener("change", (e) => {
         if (this._backupRunning) return;
         const allUnits = this.model.flatMap((c) => this._courseUnits(c));
         if (e.target.checked) {
            allUnits.forEach((id) => this.selected.add(id));
         } else {
            allUnits.forEach((id) => this.selected.delete(id));
         }
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
         // Per-lesson retry button — clears only this lesson's failed files then resumes
         const retryBtn = e.target.closest("[data-retry-lesson]");
         if (retryBtn && !this._backupRunning) {
            this._retryLesson(retryBtn.dataset.retryLesson);
            return;
         }
         if (this._backupRunning) return;
         const input = e.target.closest("input[data-ids]");
         if (input) {
            input.dataset.ids.split(",").forEach((i) =>
               input.checked ? this.selected.add(i) : this.selected.delete(i)
            );
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

      // Resume modal — "Resume backup" keeps the saved destination, "Start fresh" clears everything
      this.$("#resume-yes").addEventListener("click", () => {
         this._hideResumeModal();
         const savedDest = (() => { try { return localStorage.getItem(LS_DEST_KEY); } catch (_) { return null; } })();
         if (savedDest === "drive") this._onPickDrive();
         else this._onPickLocal();
      });
      this.$("#resume-no").addEventListener("click", () => {
         this._hideResumeModal();
         // Clear all persisted run state so the user picks fresh
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
         await this._connectDrive(true);
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

   // ─── DESTINATION PICKER ──────────────────────────────────────────────────────

   _showDestinationPicker = () => { this.$("#dest-scrim").hidden = false; };
   _hideDestinationPicker = () => { this.$("#dest-scrim").hidden = true; };

   // ─── RESUME MODAL ────────────────────────────────────────────────────────────

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

   // ─── BACKUP SHARED HELPERS ───────────────────────────────────────────────────

   /**
    * Returns the onFileStatus callback wired into LocalBackup / DriveBackup.
    * Updates this.fileStatus (in-memory only — no DB writes).
    * @returns {(fileId: string, status: string, error?: string) => void}
    */
   _makeFileStatusCallback = () => (fileId, status) => {
      this.fileStatus.set(fileId, status);
      this._saveFileStatus();
      this._schedule();
   };

   /**
    * After backup ends (done, cancelled, or error), any file still marked
    * "downloading" in this.fileStatus was mid-flight when the run stopped.
    * Flip them to "failed" so the UI doesn't show a stuck spinner.
    */
   _cleanupStuckDownloading = () => {
      for (const [fileId, status] of this.fileStatus) {
         if (status === "downloading") this.fileStatus.set(fileId, "failed");
      }
      this._saveFileStatus();
   };

   _makeProgressHandler = () => (info) => {
      if (info.lessonId) {
         if (info.status === "downloading") {
            this.backupActiveLessonId = info.lessonId;
         } else if (info.status === "lesson-done" || info.status === "lesson-failed") {
            this.backupActiveLessonId = null;
         }
      }
      this._setBackupProgress(info);
      this._schedule();
   };

   _makeOnDone = (dest) => (summary) => {
      this._activeBackup = null;
      this.backupActiveLessonId = null;
      const wasCancelled = this._cancelling;
      this._cancelling = false;
      this._backupRunning = false;
      // Don't clean up stuck files on cancel — the cancel handler already cleared everything for a fresh start
      if (!wasCancelled && !summary?.cancelled) {
         this._cleanupStuckDownloading();
      }
      this._draw();
      this._setBackupDone(summary, dest);
   };

   _makeOnError = () => (error) => {
      this._activeBackup = null;
      this.backupActiveLessonId = null;
      const wasCancelled = this._cancelling;
      this._cancelling = false;
      this._backupRunning = false;
      if (!wasCancelled) {
         this._cleanupStuckDownloading();
      }
      this._draw();
      this._setBackupError(error);
   };

   // ─── LOCAL DESTINATION ───────────────────────────────────────────────────────

   _onPickLocal = async ({ resumeAtPostId = null } = {}) => {
      this._hideDestinationPicker();

      try { localStorage.setItem(LS_DEST_KEY, "local"); } catch (_) { }
      this.backupActiveLessonId = null;
      this._backupRunning = true;
      this._draw();

      const courses = this.model
         .filter((c) => this._courseUnits(c).some((id) => this.selected.has(id)))
         .map((c) => c.course);
      const rootFolder = (this.$("#root-folder")?.value?.trim()) || "Kajabi Backup";
      try { localStorage.setItem(LS_ROOT_KEY, rootFolder); } catch (_) { }

      this._setBackupProgress({ done: 0, total: 0 });

      this._activeBackup = new LocalBackup({
         courses,
         selected: this.selected,
         empties: this.empties,
         rootFolder,
         onFileStatus: this._makeFileStatusCallback(),
         getFileStatus: (fileId) => this.fileStatus.get(fileId),
         onProgress: this._makeProgressHandler(),
         onDone: this._makeOnDone("local"),
         onError: this._makeOnError(),
         resumeAtPostId,
      });
   };

   // ─── DRIVE DESTINATION ───────────────────────────────────────────────────────

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

   _onPickDrive = async ({ resumeAtPostId = null } = {}) => {
      const ok = await this._connectDrive();
      if (!ok) return;

      try { localStorage.setItem(LS_DEST_KEY, "drive"); } catch (_) { }
      this.backupActiveLessonId = null;
      this._backupRunning = true;
      this._draw();

      const courses = this.model
         .filter((c) => this._courseUnits(c).some((id) => this.selected.has(id)))
         .map((c) => c.course);
      const rootFolder = (this.$("#root-folder")?.value?.trim()) || "Kajabi Backup";
      try { localStorage.setItem(LS_ROOT_KEY, rootFolder); } catch (_) { }

      this._setBackupProgress({ done: 0, total: 0 });

      this._activeBackup = new DriveBackup({
         courses,
         selected: this.selected,
         empties: this.empties,
         rootFolder,
         onFileStatus: this._makeFileStatusCallback(),
         getFileStatus: (fileId) => this.fileStatus.get(fileId),
         onProgress: this._makeProgressHandler(),
         onDone: this._makeOnDone("drive"),
         onError: this._makeOnError(),
         resumeAtPostId,
      });
   };

   // ─── BACKUP BAR ──────────────────────────────────────────────────────────────

   _setBackupProgress = (info) => {
      const { done = 0, total = 0, lessonTitle = "", courseTitle = "", fileName = "" } = info;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const what = lessonTitle ? `${lessonTitle} — ${fileName}` : courseTitle || "Preparing…";
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
            // Clear persisted state — cancel means start fresh next time
            this.fileStatus.clear();
            try { localStorage.removeItem(LS_KEY); localStorage.removeItem(LS_DEST_KEY); localStorage.removeItem(LS_ROOT_KEY); localStorage.removeItem(LS_SELECTED_KEY); } catch (_) { }
            this.$("#btn-cancel-backup").disabled = true;
            this.$("#btn-cancel-backup").textContent = "Cancelling…";
         });
      }
   };

   _setBackupDone = ({ saved, failed, cancelled } = {}, dest = "local") => {
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
            <button class="btn primary" id="btn-backup">Back up again</button>
         </div>`;

      // "Back up again" = fresh run — clear persisted statuses first
      this.$("#btn-backup").addEventListener("click", () => {
         this.fileStatus.clear();
         try { localStorage.removeItem(LS_KEY); localStorage.removeItem(LS_DEST_KEY); localStorage.removeItem(LS_ROOT_KEY); localStorage.removeItem(LS_SELECTED_KEY); } catch (_) { }
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

   // ─── INIT ────────────────────────────────────────────────────────────────────

   _start = async () => {
      this._initEvents();

      // First, verify the session is still valid — show an expired state if not
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
               <p>Open your course list in Kajabi, click <em>Back up courses</em>, then <em>Scrape courses</em>.</p>
            </div>`;
         return;
      }

      const courses = (await this._dbAll("scan")).slice(0, meta.count);
      this._scanSavedAt = meta.savedAt;   // used by _loadFileStatus to detect stale data
      this.$("#sub").textContent = `Scanned ${this.plural(courses.length, "course", "courses")} on ${new Date(meta.savedAt).toLocaleString()}`;

      // Restore persisted folder name before drawing
      try {
         const savedRoot = localStorage.getItem(LS_ROOT_KEY);
         if (savedRoot) {
            const input = this.$("#root-folder");
            if (input) input.value = savedRoot;
         }
      } catch (_) { }

      this._buildModel(courses, true);   // don't select-all yet — _loadSelected decides
      const hadSelection = this._loadSelected();
      if (!hadSelection) {
         // First visit for this scan — select everything by default
         this.selected = new Set(this.model.flatMap((c) => this._courseUnits(c)));
         this._saveSelected();
      }
      this._loadFileStatus();
      this._draw();
      this._measureAll();

      // After the tree is drawn, prompt for resume if there's a previous run
      const savedDest = (() => { try { return localStorage.getItem(LS_DEST_KEY); } catch (_) { return null; } })();
      if (this.fileStatus.size > 0 && savedDest) {
         this._showResumeModal(savedDest);
      }
   };
}

// Instantiate — all side-effects run inside the constructor
window.__dashboard = new CourseDashboard();
