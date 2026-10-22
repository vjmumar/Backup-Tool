/**
 * modals/scraper.js — Kartra scraper modal logic
 *
 * Owns everything that happens inside the "Back up memberships" modal:
 *   - Loading the remote scraper script on first open
 *   - Verifying the platform connection before allowing a scan
 *   - Running the scan and handing the result off to the background
 *
 * Kartra data shape (from scraper):
 *   Array of Membership:
 *   {
 *     id: string,
 *     attributes: { name, image, global_id, deleted_on, status, admin_login_url },
 *     categories: [{
 *       id: number,           // 0 = Welcome
 *       name: string,
 *       subcategories: [{ id, name, posts: [Post] }],
 *       posts: [Post]         // posts placed directly in the category
 *     }]
 *   }
 *   Post: { id, name, type?, data: { id, name, blocks, files } }
 *
 * IMPORTANT: admin_login_url must NEVER be stored, logged, or sent anywhere.
 * It is stripped from every membership before handoff.
 *
 * Exposes: window.__courseBackup.modals.scraper.init(send, platform)
 * Returns: { onToggle, onScrape, reset }
 */

window.__courseBackup = window.__courseBackup || {};
window.__courseBackup.modals = window.__courseBackup.modals || {};
window.__courseBackup.modals.scraper = window.__courseBackup.modals.scraper || {};

window.__courseBackup.modals.scraper.init = (send, platform) => {
  const { ui } = window.__courseBackup;

  // Scan state — local to this mount, reset on navigation
  let scanning = false;
  let scanId = 0;
  let saved = null;

  // ─── HELPERS ────────────────────────────────────────────────────────────────

  /**
   * Strips admin_login_url from every membership — it is a signed admin
   * login link that must never be stored anywhere.
   * Also filters out deleted memberships (deleted_on !== null).
   */
  const sanitizeMemberships = (memberships) =>
    memberships
      .filter((m) => m.attributes?.deleted_on == null)
      .map((m) => {
        // eslint-disable-next-line no-unused-vars
        const { admin_login_url, ...safeAttributes } = m.attributes || {};
        return { ...m, attributes: safeAttributes };
      });

  /**
   * Stamps stable string IDs onto every membership, category, subcategory,
   * post, and file so the dashboard can key sizes and statuses globally.
   *
   *   membership.id   already a string from the API — kept as-is
   *   category._id    = "cat-<mi>-<ci>"
   *   subcategory._id = "sub-<mi>-<ci>-<si>"
   *   post._id        = "post-<mi>-<ci>-<pi>"  (or "post-<mi>-<ci>-<si>-<pi>")
   *   file.fileId     = "<post._id>:f<fi>"
   *
   * Also normalises file sizes: download files from the scraper carry a
   * human-readable size string (e.g. "2.40 MB"). We delete it here so the
   * dashboard measures all downloads via HEAD requests like every other file,
   * getting a precise byte count instead of an un-parseable string.
   *
   * We use _id / fileId to avoid colliding with Kartra's own id fields.
   */
  const stampFiles = (files, postId) =>
    (files || []).map((file, fi) => {
      const stamped = {
        ...file,
        // Only generate fileId if the scraper didn't already provide one
        fileId: file.fileId || `${postId}:f${fi}`,
      };
      // Drop the scraper's human-readable size string — it can't be used as
      // bytes. The dashboard will measure the real size via HEAD request.
      if (stamped.type === 'download' && typeof stamped.size === 'string') {
        delete stamped.size;
      }
      return stamped;
    });

  const stampPost = (post, postId) => ({
    ...post,
    _id: postId,
    id: String(post.id),
    data: post.data
      ? { ...post.data, files: stampFiles(post.data.files, postId) }
      : post.data,
  });

  const addIds = (memberships) =>
    memberships.map((membership, mi) => ({
      ...membership,
      categories: (membership.categories || []).map((category, ci) => ({
        ...category,
        _id: `cat-${mi}-${ci}`,
        posts: (category.posts || []).map((post, pi) =>
          stampPost(post, `post-${mi}-${ci}-${pi}`)),
        subcategories: (category.subcategories || []).map((sub, si) => ({
          ...sub,
          _id: `sub-${mi}-${ci}-${si}`,
          posts: (sub.posts || []).map((post, pi) =>
            stampPost(post, `post-${mi}-${ci}-${si}-${pi}`)),
        })),
      })),
    }));

  /**
   * Counts all posts across all memberships, categories, and subcategories.
   * Used for the "Scan finished" summary in the modal.
   */
  const countPosts = (memberships) =>
    memberships.reduce((total, m) =>
      total + (m.categories || []).reduce((catTotal, cat) =>
        catTotal +
        (cat.posts || []).length +
        (cat.subcategories || []).reduce((subTotal, sub) =>
          subTotal + (sub.posts || []).length, 0),
        0),
      0);

  /**
   * Sends memberships to the background one at a time.
   * Sending all at once could exceed Chrome's message size limit.
   */
  const handoff = async (memberships) => {
    await send("handoff-start");
    for (let i = 0; i < memberships.length; i++) {
      await send("handoff-course", { index: i, course: memberships[i] });
    }
    await send("handoff-end", { count: memberships.length });
  };

  // ─── RESET ──────────────────────────────────────────────────────────────────

  const reset = () => { scanId++; scanning = false; saved = null; };

  // ─── ON TOGGLE ──────────────────────────────────────────────────────────────

  const onToggle = async () => {
    if (ui.isOpen()) { ui.close(); return; }

    if (saved) { ui.showDone(saved); ui.open(); return; }
    if (scanning) { ui.showScanning(); ui.open(); return; }

    if (!window.__courseBackup.scrape) {
      ui.showScanning("Loading scraper…");
      ui.open();
      try {
        await platform.loadScraper(send);
      } catch (err) {
        ui.showError(err);
        return;
      }
    }

    ui.showReady();
    if (!ui.isOpen()) ui.open();
  };

  // ─── ON SCRAPE ──────────────────────────────────────────────────────────────

  const onScrape = async () => {
    if (scanning) return;

    // Step 1 — app config gate (maintenance + version check)
    try {
      const config = await send("get-app-config", {}, true);

      if (config?.isMaintenance) {
        ui.showError(new Error(
          "Scraping is temporarily unavailable — the service is under maintenance. " +
          "Your existing backups are unaffected. Please try again later.",
        ));
        ui.open();
        return;
      }

      if (config?.ok && config?.version && config?.extensionVersion) {
        if (config.extensionVersion !== config.version) {
          const err = new Error(
            `A new version of the extension is available (v${config.version}). Please update before continuing.`,
          );
          err.downloadLink = config.downloadLink || null;
          ui.showError(err);
          ui.open();
          return;
        }
      }
    } catch (_) {
      // Fail open
    }

    // Step 2 — read accountId
    const accountId = platform.getAccountId();
    if (!accountId) {
      ui.showError(new Error(
        "Could not read your Kartra account ID from the page. Reload and try again.",
      ));
      ui.open();
      return;
    }

    // Step 3 — verify connection
    try {
      const check = await send("check-connection", { accountId }, true);
      if (!check.ok) {
        ui.showError(new Error(
          check.error || "Could not verify your connection. Make sure you are signed in.",
        ));
        ui.open();
        return;
      }
      if (!check.allowed) {
        window.__courseBackup.modals.addPlatformConnection.show(send, platform, accountId);
        return;
      }
    } catch (err) {
      ui.showError(err);
      ui.open();
      return;
    }

    // Step 4 — ensure scraper loaded
    if (!window.__courseBackup.scrape) {
      try {
        await platform.loadScraper(send);
      } catch (err) {
        ui.showError(err);
        return;
      }
    }

    // Step 5 — run scraper
    scanning = true;
    saved = null;
    ui.showScanning();

    const my = scanId;
    let onReject;

    const failed = new Promise((_, reject) => {
      onReject = (e) => {
        const stack = String(e.reason?.stack);
        if (stack.includes("eval") || stack.includes("__courseBackup")) reject(e.reason);
      };
      window.addEventListener("unhandledrejection", onReject);
    });

    try {
      const scrape = window.__courseBackup.scrape;
      const parsed = await Promise.race([
        scrape((text) => { if (my === scanId && ui.isOpen()) ui.showScanning(text); }),
        failed,
      ]);
      if (my !== scanId) return;

      // Sanitize (strip admin_login_url, remove deleted), then stamp IDs
      const clean = sanitizeMemberships(parsed);
      const withIds = addIds(clean);

      await handoff(withIds);
      if (my !== scanId) return;

      saved = { memberships: withIds.length, posts: countPosts(withIds) };
      if (ui.isOpen()) ui.showDone(saved);

    } catch (error) {
      console.error("[Kartra Backup]", error);
      if (my === scanId && ui.isOpen()) ui.showError(error);
    } finally {
      window.removeEventListener("unhandledrejection", onReject);
      if (my === scanId) scanning = false;
    }
  };

  return { onToggle, onScrape, reset };
};
