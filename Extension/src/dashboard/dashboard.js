/**
 * CourseDashboard — dashboard.js
 * Reads the scan the background saved into IndexedDB,
 * draws the course tree with checkboxes, measures every file size,
 * and shows the sizes live in the rows and in the bottom bar.
 */

class CourseDashboard {
   constructor() {
      // First, constants
      this.TRIES = 3;

      // Then, shared helpers
      this.$ = (sel) => document.querySelector(sel);
      this.esc = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
      this.plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
      this.chevron = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';

      // Then, sizing state — sizes: Map<key, bytes|null>  (absent = pending)
      this.sizes = new Map();
      this.wanted = new Map();

      // Then, tree state
      this.model = [];
      this.empties = new Set();
      this.selected = new Set();
      this.open = new Set();

      // Then, rAF handle for throttled redraws
      this.rafId = 0;

      // Then, per-lesson backup status (null when no backup is running)
      this.backupStatus = null;  // Map<lessonId, "done"|"failed"> | null
      this.backupCurrent = null;  // lessonId currently downloading, or null
      this._activeBackup = null;  // current LocalBackup/DriveBackup instance, for cancel()

      // Finally, start
      this._start();
   }

   // ─── DATABASE ────────────────────────────────────────────────────────────────

   /**
    * Opens the shared IndexedDB database — the same one the background writes to.
    * The promise is cached so it is only opened once.
    */
   _openDb = () =>
   (this._dbPromise ||= new Promise((resolve, reject) => {
      const request = indexedDB.open("course-backup", 2);
      // First, create the three stores if they do not exist yet
      request.onupgradeneeded = () => {
         ["sizes", "scan", "meta"].forEach((name) =>
            request.result.objectStoreNames.contains(name) || request.result.createObjectStore(name)
         );
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
   }));

   /**
    * This method is responsible for running a read request on a store.
    */
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
   _dbSet = async (store, key, value) => {
      const db = await this._openDb();
      db.transaction(store, "readwrite").objectStore(store).put(value, key);
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

   _collectFiles = (courses) => {
      const map = new Map();
      const add = (files) => (files || []).forEach((file) => {
         const key = this._keyOf(file.url);
         if (!map.has(key)) map.set(key, file.url);
      });
      courses.forEach((course) => {
         add(course.files);
         course.categories.forEach((category) => {
            add(category.files);
            (category.posts || []).forEach((post) => add(post.files));
         });
      });
      return map;
   };

   _measureAll = async (courses) => {
      this.wanted = this._collectFiles(courses);
      const todo = [];
      // First, load cache hits before starting any requests
      for (const [key, url] of this.wanted) {
         const cached = await this._dbGet("sizes", key);
         if (cached != null) this.sizes.set(key, cached);
         else todo.push({ key, url });
      }
      this._schedule();
      let next = 0;
      const worker = async () => {
         while (next < todo.length) {
            const { key, url } = todo[next++];
            const size = await this._getFileSize(url);
            if (size != null) this._dbSet("sizes", key, size);
            this.sizes.set(key, size);
            this._schedule();
         }
      };
      // Run 6 workers in parallel and wait for all to finish
      await Promise.all(Array.from({ length: 6 }, worker));
      this._schedule();
   };

   // ─── SIZE HELPERS ────────────────────────────────────────────────────────────

   _keyOf = (url) => url.split("?")[0];
   _textBytes = (text) => ({ bytes: new Blob([text || ""]).size, pending: 0, unknown: 0 });
   _addStat = (a, b) => ({ bytes: a.bytes + b.bytes, pending: a.pending + b.pending, unknown: a.unknown + b.unknown });
   _empty = () => ({ bytes: 0, pending: 0, unknown: 0 });

   _sumFiles = (files = []) =>
      files.reduce((total, file) => {
         const key = this._keyOf(file.url);
         if (!this.sizes.has(key)) total.pending++;
         else if (this.sizes.get(key) === null) total.unknown++;
         else total.bytes += this.sizes.get(key);
         return total;
      }, { bytes: 0, pending: 0, unknown: 0 });

   _format = (bytes) => {
      const units = ["B", "KB", "MB", "GB", "TB"];
      let n = bytes, i = 0;
      while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
      return `${i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
   };

   _sizeHtml = (stat) =>
      stat.pending
         ? '<span class="meas" aria-label="measuring"></span>'
         : this._format(stat.bytes) + (stat.unknown ? '<span class="unk" title="A file size could not be read"> +?</span>' : "");

   // ─── TREE MODEL ──────────────────────────────────────────────────────────────

   _buildModel = (courses) => {
      this.model = courses.map((course) => ({
         // First, use the stable id stamped by addIds() in content.js
         id: course.id,
         course,
         categories: course.categories.map((category) => {
            // Then, track empty categories by their stable emptyId
            if (category.emptyId) this.empties.add(category.emptyId);
            return {
               id: category.id,
               category,
               emptyId: category.emptyId || null,
               lessons: (category.posts || []).map((post) => ({ id: post.id, post })),
            };
         }),
      }));
      this.selected = new Set(this.model.flatMap((c) => this._courseUnits(c)));
      if (this.model.length) this.open.add(this.model[0].id);
   };

   _catUnits = (k) => k.emptyId ? [k.emptyId] : k.lessons.map((l) => l.id);
   _courseUnits = (c) => c.categories.flatMap((k) => this._catUnits(k));
   _stateOf = (ids) => {
      const n = ids.filter((i) => this.selected.has(i)).length;
      return n === 0 ? "none" : n === ids.length ? "all" : "some";
   };

   // ─── SIZE STATS ──────────────────────────────────────────────────────────────

   _lessonStat = (l) => this._addStat(this._sumFiles(l.post.files), this._textBytes(l.post.body));
   _categoryStat = (k) => k.lessons.reduce((total, l) => this._addStat(total, this._lessonStat(l)), this._sumFiles(k.category.files));
   _courseStat = (c) => c.categories.reduce((total, k) => this._addStat(total, this._categoryStat(k)), this._sumFiles(c.course.files));

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

   _lessonHtml = (l) => {
      // First, check backup status for this lesson using its unique ID
      const status = this.backupStatus?.get(l.id);
      const isActive = this.backupCurrent === l.id;

      // Then, build the status badge
      let badge = "";
      if (isActive) badge = '<span class="tag bk-active">Downloading…</span>';
      else if (status === "done") badge = '<span class="tag bk-done">✓ Saved</span>';
      else if (status === "skipped") badge = '<span class="tag bk-skip">Skipped</span>';

      // Finally, return the row
      return `
      <div class="lesson${isActive ? " bk-row" : status === "done" ? " bk-row-done" : ""}">
         ${this._checkHtml([l.id], l.post.title || "Untitled lesson")}
         ${this._tagsOf(l.post)}
         ${badge}
         <span class="meta">${this._sizeHtml(this._lessonStat(l))}</span>
      </div>`;
   };

   _categoryHtml = (k) => {
      const picked = k.lessons.filter((l) => this.selected.has(l.id)).length;
      const hasCatFiles = (k.category.files || []).length > 0;
      const count = k.lessons.length
         ? `${picked ? picked + " of " : ""}${this.plural(k.lessons.length, "lesson", "lessons")}`
         : hasCatFiles ? "empty &middot; folder + thumbnail" : "empty &middot; folder only";
      const szPart = k.lessons.length || (k.category.files || []).length
         ? ` &middot; ${this._sizeHtml(this._categoryStat(k))}`
         : "";

      // Glow when backup is running and every selected lesson in this category is done
      // Also glow for empty categories when their placeholder file is done
      const selLessons = k.lessons.filter((l) => this.selected.has(l.id));
      const catAllDone = this.backupStatus !== null && (
         k.emptyId && this.selected.has(k.emptyId)
            ? this.backupStatus.get(k.emptyId) === "done"
            : selLessons.length > 0 && selLessons.every((l) => this.backupStatus.get(l.id) === "done")
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

      // Glow when backup is running and every selected lesson in this course is done
      const selAll = all.filter((l) => this.selected.has(l.id));
      const courseAllDone = this.backupStatus !== null && selAll.length > 0 &&
         selAll.every((l) => this.backupStatus.get(l.id) === "done");

      return `
      <div class="course${courseAllDone ? " bk-course-done" : ""}">
         <div class="crow">${this._chevHtml(c.id)}${this._checkHtml(this._courseUnits(c), c.course.text || "Untitled course")}<span class="meta">${count} &middot; ${this._sizeHtml(this._courseStat(c))}</span></div>
         ${this.open.has(c.id) ? `<div class="cats">${c.categories.map((k) => this._categoryHtml(k)).join("")}</div>` : ""}
      </div>`;
   };

   // ─── DRAW ────────────────────────────────────────────────────────────────────

   /**
    * This method is responsible for redrawing the full tree and the bottom bar.
    * The page scroll position, the open state and the selection are preserved.
    */
   _draw = () => {
      const scrollY = window.scrollY;

      // First, rebuild the tree HTML
      this.$("#tree").innerHTML = this.model.map((c) => this._courseHtml(c)).join("")
         || '<div class="state"><p>No courses found.</p></div>';

      // Then, set indeterminate state — cannot be done in HTML
      // Also disable all checkboxes and the folder name input while a backup is running
      const backupRunning = this.backupStatus !== null;
      document.querySelectorAll("input[data-state]").forEach((input) => {
         input.checked = input.dataset.state === "all";
         input.indeterminate = input.dataset.state === "some";
         input.disabled = backupRunning;
      });
      const folderInput = this.$("#root-folder");
      if (folderInput) folderInput.disabled = backupRunning;
      window.scrollTo({ top: scrollY, behavior: "instant" });

      // Then, skip the bottom bar update if a backup is running (it has its own bar)
      if (this.backupStatus !== null) return;

      // Then, compute bottom bar values
      const lessons = [...this.selected].filter((i) => !this.empties.has(i)).length;
      const folders = this.selected.size - lessons;
      const stat = this._selectionStat();
      const done = [...this.wanted.keys()].filter((key) => this.sizes.has(key)).length;
      const measuring = done < this.wanted.size;
      const unknown = [...this.wanted.keys()].filter((key) => this.sizes.get(key) === null).length;

      const note = measuring
         ? `Measuring sizes &middot; ${done} of ${this.wanted.size} files (${Math.round((done / this.wanted.size) * 100)}%)`
         : unknown
            ? `${this.plural(unknown, "file", "files")} could not be measured and ${unknown === 1 ? "is" : "are"} not counted. They are still backed up.`
            : "All sizes measured.";

      // Start backup button is enabled only when measuring is done and something is selected
      const canBackup = !measuring && lessons > 0;
      // Finally, update the bottom bar
      const sizeLabel = stat.pending
         ? `<span class="meas"></span>`
         : `<span class="sum-size">${this._format(stat.bytes).replace(/\s/, '<em>')}B</em></span>`;
      this.$("#bottom-in").innerHTML = `
         <div class="sum">
            ${sizeLabel}
            <span class="sum-detail">${this.plural(lessons, "lesson", "lessons")} + ${this.plural(folders, "empty folder", "empty folders")} selected</span>
            <p class="muted small" style="margin-left:auto">${note}</p>
         </div>
         <button class="btn primary" id="btn-backup" ${canBackup ? "" : "disabled"} title="${canBackup ? "Choose where to save" : "Waiting for sizes to finish measuring"}">Start backup</button>`;
      if (canBackup) {
         this.$("#btn-backup").addEventListener("click", () => this._showDestinationPicker());
      }
      this.$("#bottom").hidden = false;
   };

   /**
    * This method is responsible for scheduling a redraw at most once per animation frame.
    */
   _schedule = () => {
      if (this.rafId) return;
      this.rafId = requestAnimationFrame(() => {
         this.rafId = 0;
         this._draw();
      });
   };

   // ─── EVENTS ──────────────────────────────────────────────────────────────────

   /**
    * This method is responsible for wiring up all click listeners on the page.
    */
   _initEvents = () => {
      // First, the tree: expand/collapse and checkbox changes
      this.$("#tree").addEventListener("click", (e) => {
         const toggle = e.target.closest("[data-toggle]");
         if (toggle) {
            const id = toggle.dataset.toggle;
            this.open.has(id) ? this.open.delete(id) : this.open.add(id);
            return this._draw();
         }
         // Block checkbox changes while a backup is running
         if (this.backupStatus !== null) return;
         const input = e.target.closest("input[data-ids]");
         if (input) {
            input.dataset.ids.split(",").forEach((i) =>
               input.checked ? this.selected.add(i) : this.selected.delete(i)
            );
            this._draw();
         }
      });

      // Then, destination picker close targets
      this.$("#dest-close").addEventListener("click", () => this._hideDestinationPicker());
      this.$("#dest-scrim").addEventListener("click", (e) => {
         if (e.target === this.$("#dest-scrim")) this._hideDestinationPicker();
      });
      document.addEventListener("keydown", (e) => {
         if (e.key === "Escape" && !this.$("#dest-scrim").hidden) this._hideDestinationPicker();
         if (e.key === "Escape" && !this.$("#setup-scrim").hidden) this._hideSetupModal();
         if (e.key === "Escape" && !this.$("#drive-scrim").hidden) this._hideDriveModal();
      });

      // Finally, destination cards
      this.$("#dest-local").addEventListener("click", () => {
         this._hideDestinationPicker();
         this._showSetupModal();
      });
      this.$("#dest-drive").addEventListener("click", () => {
         this._hideDestinationPicker();
         this._showDriveModal();
      });

      // Drive modal buttons
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

      // Then, setup modal buttons
      this.$("#setup-close").addEventListener("click", () => this._hideSetupModal());
      this.$("#setup-cancel").addEventListener("click", () => this._hideSetupModal());
      this.$("#setup-confirm").addEventListener("click", () => {
         this._hideSetupModal();
         this._onPickLocal();
      });
      this.$("#setup-open-settings").addEventListener("click", () => {
         // chrome.tabs.create is not available here — open via background
         chrome.runtime.sendMessage({ type: "open-chrome-settings" });
      });
      this.$("#setup-scrim").addEventListener("click", (e) => {
         if (e.target === this.$("#setup-scrim")) this._hideSetupModal();
      });
   };

   // ─── DESTINATION PICKER ──────────────────────────────────────────────────────

   _showDestinationPicker = () => { this.$("#dest-scrim").hidden = false; };
   _hideDestinationPicker = () => { this.$("#dest-scrim").hidden = true; };

   _showSetupModal = () => { this.$("#setup-scrim").hidden = false; };
   _hideSetupModal = () => { this.$("#setup-scrim").hidden = true; };

   _showDriveModal = async () => {
      // Show the modal immediately — populate details async
      this.$("#drive-scrim").hidden = false;
      const storageRow = this.$("#drive-storage-row");
      storageRow.innerHTML = "";

      // Populate account row
      const state = await chrome.runtime.sendMessage({ type: "get-drive-state" });
      const accountRow = this.$("#drive-account-row");
      if (state?.connected && state.email) {
         this.$("#drive-account-email").textContent = state.email;
         accountRow.hidden = false;
      } else {
         accountRow.hidden = true;
      }
      this.$("#drive-continue").textContent = state?.connected ? "Continue" : "Sign in & continue";

      // Fetch storage quota only when already connected
      if (state?.connected) {
         // Disable continue until quota is confirmed
         this.$("#drive-continue").disabled = true;
         this.$("#drive-continue").title = "Checking available storage…";
         storageRow.innerHTML = `<p class="drive-quota-warn muted">Checking available storage…</p>`;

         const selStat = this._selectionStat();
         const selBytes = selStat.bytes;

         try {
            const quota = await chrome.runtime.sendMessage({ type: "get-drive-storage-quota" });
            if (!quota?.ok) throw new Error(quota?.error || "Quota check failed");
            const { limit, usage, free } = quota;
            const DAILY_LIMIT = 750 * 1024 * 1024 * 1024; // 750 GB

            // Storage bar
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

            // Disable Continue if there's not enough space
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

   /**
    * This method is responsible for starting a local ZIP backup.
    */
   _onPickLocal = () => {
      this._hideDestinationPicker();

      // First, reset per-lesson backup status and redraw the tree
      this.backupStatus = new Map();
      this.backupCurrent = null;  // single lessonId currently downloading
      this._draw();

      // Then, collect only courses that have something selected
      const courses = this.model
         .filter((c) => this._courseUnits(c).some((id) => this.selected.has(id)))
         .map((c) => c.course);

      // Then, read the user-supplied root folder name
      const rootFolder = (this.$("#root-folder")?.value?.trim()) || "Kajabi Backup";

      // Then, show the initial progress bar
      this._setBackupProgress({ done: 0, total: 0 });

      // Finally, start the backup
      this._activeBackup = new LocalBackup({
         courses,
         selected: this.selected,
         empties: this.empties,
         rootFolder,
         onProgress: (info) => {
            // Track the single active lesson
            if (info.lessonId) {
               if (info.status === "downloading") {
                  this.backupCurrent = info.lessonId;
               } else if (info.status === "lesson-done" || info.status === "lesson-failed") {
                  this.backupCurrent = null;
                  this.backupStatus.set(info.lessonId, info.status === "lesson-done" ? "done" : "failed");
               }
            }
            // Track empty category completion
            if (info.emptyId) {
               if (info.status === "empty-done") this.backupStatus.set(info.emptyId, "done");
               else if (info.status === "empty-failed") this.backupStatus.set(info.emptyId, "failed");
            }
            this._setBackupProgress(info);
            this._schedule();
         },
         onDone: (summary) => {
            this._activeBackup = null;
            this.backupCurrent = null;
            this._cancelling = false;
            this._draw();
            this._setBackupDone(summary);
         },
         onError: (error) => {
            this._activeBackup = null;
            this.backupCurrent = null;
            this._cancelling = false;
            this._draw();
            this._setBackupError(error);
         },
      });
   };

   // ─── DRIVE DESTINATION ───────────────────────────────────────────────────────

   /**
    * Connects to Google Drive. If forceNew is true, always opens the OAuth screen
    * (used by "Sign in with a different account"). Otherwise only opens it when
    * no account is connected.
    */
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

   /**
    * Called when the user clicks Continue (or Sign in & continue) in the Drive modal.
    * Ensures auth is in place then starts the backup.
    */
   _onPickDrive = async () => {
      // Ensure connected — if not yet, open OAuth now
      const ok = await this._connectDrive();
      if (!ok) return;

      // Reset per-lesson backup status and redraw
      this.backupStatus = new Map();
      this.backupCurrent = null;
      this._draw();

      // Then, collect only courses that have something selected
      const courses = this.model
         .filter((c) => this._courseUnits(c).some((id) => this.selected.has(id)))
         .map((c) => c.course);

      // Then, read the user-supplied root folder name
      const rootFolder = (this.$("#root-folder")?.value?.trim()) || "Kajabi Backup";

      // Then, show the initial progress bar
      this._setBackupProgress({ done: 0, total: 0 });

      // Finally, start the Drive backup
      this._activeBackup = new DriveBackup({
         courses,
         selected: this.selected,
         empties: this.empties,
         rootFolder,
         onProgress: (info) => {
            if (info.lessonId) {
               if (info.status === "downloading") {
                  this.backupCurrent = info.lessonId;
               } else if (info.status === "lesson-done" || info.status === "lesson-failed") {
                  this.backupCurrent = null;
                  this.backupStatus.set(info.lessonId, info.status === "lesson-done" ? "done" : "failed");
               }
            }
            // Track empty category completion
            if (info.emptyId) {
               if (info.status === "empty-done") this.backupStatus.set(info.emptyId, "done");
               else if (info.status === "empty-failed") this.backupStatus.set(info.emptyId, "failed");
            }
            this._setBackupProgress(info);
            this._schedule();
         },
         onDone: (summary) => {
            this._activeBackup = null;
            this.backupCurrent = null;
            this._cancelling = false;
            this._draw();
            this._setBackupDone(summary, "drive");
         },
         onError: (error) => {
            this._activeBackup = null;
            this.backupCurrent = null;
            this._cancelling = false;
            this._draw();
            this._setBackupError(error);
         },
      });
   };

   // ─── BACKUP BAR ──────────────────────────────────────────────────────────────

   /**
    * This method is responsible for updating the bottom bar during a backup.
    */
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
            this.$("#btn-cancel-backup").disabled = true;
            this.$("#btn-cancel-backup").textContent = "Cancelling…";
         });
      }
   };

   /**
    * This method is responsible for showing the done state in the bottom bar.
    */
   _setBackupDone = ({ saved, failed, cancelled } = {}, dest = "local") => {
      this.backupStatus = null;
      const location = dest === "drive" ? "Google Drive" : "your Downloads folder";
      const detail = cancelled
         ? `Cancelled. ${saved} file${saved === 1 ? "" : "s"} saved before stopping.`
         : failed
            ? `${saved} file${saved === 1 ? "" : "s"} saved, ${failed} failed.`
            : `All ${saved} file${saved === 1 ? "" : "s"} saved successfully.`;
      this.$("#bottom-in").innerHTML = `
         <div class="sum">
            <strong>Backup complete.</strong>
            <p class="muted small">${detail} Files are in ${location}.</p>
         </div>
         <button class="btn primary" id="btn-backup">Back up again</button>`;
      this.$("#btn-backup").addEventListener("click", () => this._showDestinationPicker());
   };

   /**
    * This method is responsible for showing an error in the bottom bar.
    */
   _setBackupError = (error) => {
      this.backupStatus = null;

      // First, check for the special "ask where to save" setting error
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

   /**
    * This method is responsible for loading the saved scan, drawing the tree,
    * and starting the file size measurement.
    */
   _start = async () => {
      // First, wire up all events before any draw happens
      this._initEvents();

      // Then, read the scan metadata from IndexedDB
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

      // Then, load the courses from IndexedDB and build the tree model
      const courses = (await this._dbAll("scan")).slice(0, meta.count);
      this.$("#sub").textContent = `Scanned ${this.plural(courses.length, "course", "courses")} on ${new Date(meta.savedAt).toLocaleString()}`;
      this._buildModel(courses);

      // Then, draw the tree before measuring starts so the page is not blank
      this._draw();

      // Finally, start measuring all file sizes in the background
      this._measureAll(courses);
   };
}

// Instantiate — all side-effects run inside the constructor
new CourseDashboard();
