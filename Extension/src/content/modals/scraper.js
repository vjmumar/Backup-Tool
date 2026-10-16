/**
 * modals/scraper.js — scraper modal logic
 *
 * Owns everything that happens inside the "Back up courses" modal:
 *   - Loading the remote scraper script on first open
 *   - Verifying the platform connection before allowing a scan
 *   - Running the scan and handing the result off to the background
 *
 * Exposes one function: initScraperModal(send)
 * Called once per mount by content.js. Returns { onToggle, onScrape, reset }
 * for ui.mount() and for cleanup on navigation.
 */

window.__courseBackup = window.__courseBackup || {};
window.__courseBackup.modals = window.__courseBackup.modals || {};
window.__courseBackup.modals.scraper = window.__courseBackup.modals.scraper || {};

// ─── INIT ─────────────────────────────────────────────────────────────────────

/**
 * Creates a fresh scraper modal instance for the current page mount.
 * Call once per mount — content.js calls this every time sync() mounts the button.
 *
 * @param {function} send  The send(type, payload, resolveWithData) bridge helper
 * @returns {{ onToggle: function, onScrape: function, reset: function }}
 */
window.__courseBackup.modals.scraper.init = (send, platform) => {
  const { ui } = window.__courseBackup;

  // Scan state — local to this mount, reset on navigation
  let scanning = false;
  let scanId = 0;
  let saved = null;

  // ─── HANDOFF ──────────────────────────────────────────────────────────────

  /**
   * Sends the parsed courses to the background one at a time.
   * Sending all at once could exceed Chrome's message size limit.
   */
  const handoff = async (courses) => {
    await send("handoff-start");
    for (let i = 0; i < courses.length; i++) {
      await send("handoff-course", { index: i, course: courses[i] });
    }
    await send("handoff-end", { count: courses.length });
  };

  /**
   * Counts the total number of lessons across all courses and categories.
   * Used for the "Scan finished" summary shown in the modal.
   */
  const countLessons = (courses) =>
    courses.reduce(
      (total, course) =>
        total + course.categories.reduce((sum, cat) => sum + (cat.posts || []).length, 0),
      0,
    );

  /**
   * Stamps stable IDs onto every course, category, and post before handoff.
   * Lessons already carry an id from the Kajabi API — courses and categories do not.
   *   course.id    = "course-<ci>"
   *   category.id  = "cat-<ci>-<ki>"
   *   category.emptyId = "empty-<ci>-<ki>"  (only when the category has no posts)
   */
  const addIds = (courses) =>
    courses.map((course, ci) => ({
      ...course,
      id: `course-${ci}`,
      categories: (course.categories || []).map((category, ki) => ({
        ...category,
        id: `cat-${ci}-${ki}`,
        emptyId: (category.posts || []).length === 0 ? `empty-${ci}-${ki}` : null,
        posts: (category.posts || []).map((post) => ({ ...post, id: String(post.id) })),
      })),
    }));

  // ─── RESET ────────────────────────────────────────────────────────────────

  /**
   * Resets scan state when the user navigates away from the page.
   * The scraper cache is intentionally kept — platform.loadScraper is
   * idempotent and window.__courseBackup.scrape persists on window.
   */
  const reset = () => {
    scanId++;
    scanning = false;
    saved = null;
  };

  // ─── ON TOGGLE ────────────────────────────────────────────────────────────

  /**
   * Called when the floating button is clicked.
   * On the first click, fetches and evals the scraper before opening the modal.
   * A loading state is shown while the script is in transit.
   */
  const onToggle = async () => {
    // First, close if already open
    if (ui.isOpen()) { ui.close(); return; }

    // Then, resume the correct state if a scan is in progress or finished
    if (saved) { ui.showDone(saved); ui.open(); return; }
    if (scanning) { ui.showScanning(); ui.open(); return; }

    // Finally, load the scraper on first open and show the ready state
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

  // ─── ON SCRAPE ────────────────────────────────────────────────────────────

  /**
   * Called when the user clicks "Scrape courses" inside the modal.
   * First verifies the platform connection, then runs the scraper.
   */
  const onScrape = async () => {
    if (scanning) return;

    // First, check if the server is in maintenance mode — block scraping if so
    try {
      const maintenance = await send("get-maintenance", {}, true);
      if (maintenance?.isMaintenance) {
        ui.showError(new Error(
          "Scraping is temporarily unavailable — the service is under maintenance. Your existing backups are unaffected. Please try again later.",
        ));
        ui.open();
        return;
      }
    } catch (_) {
      // Fail open — a network error checking maintenance should not block the user
    }

    // Then, read the account ID from the page
    const accountId = platform.getAccountId();
    if (!accountId) {
      ui.showError(new Error(
        `Could not read the ${platform.name} account ID from the page. Reload and try again.`,
      ));
      ui.open();
      return;
    }

    // Then, verify the account is linked to the user's profile
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
        // Account is not linked yet — offer to add it inline rather than
        // showing a plain error. The add-connection modal takes over from here.
        window.__courseBackup.modals.addPlatformConnection.show(send, platform, accountId);
        return;
      }
    } catch (err) {
      ui.showError(err);
      ui.open();
      return;
    }

    // Then, ensure the scraper script is loaded (guard — should already be)
    if (!window.__courseBackup.scrape) {
      try {
        await platform.loadScraper(send);
      } catch (err) {
        ui.showError(err);
        return;
      }
    }

    // Finally, run the scraper
    scanning = true;
    saved = null;
    ui.showScanning();

    const my = scanId;
    let onReject;

    // The eval'd script runs inside new Promise(async ...) so errors thrown
    // there become unhandled rejections rather than caught exceptions.
    // We race against a promise that rejects on those rejections.
    const failed = new Promise((_, reject) => {
      onReject = (e) => {
        const stack = String(e.reason && e.reason.stack);
        if (stack.includes("eval") || stack.includes("__courseBackup")) reject(e.reason);
      };
      window.addEventListener("unhandledrejection", onReject);
    });

    try {
      const scrape = window.__courseBackup.scrape;
      const parsed = await Promise.race([
        scrape((text) => {
          if (my !== scanId) return;
          if (ui.isOpen()) ui.showScanning(text);
        }),
        failed,
      ]);
      if (my !== scanId) return;

      // First, stamp IDs, then hand off to the background, then show the result
      const withIds = addIds(parsed);
      await handoff(withIds);
      if (my !== scanId) return;
      saved = { courses: withIds.length, lessons: countLessons(withIds) };
      if (ui.isOpen()) ui.showDone(saved);

    } catch (error) {
      console.error("[Course Backup]", error);
      if (my === scanId && ui.isOpen()) ui.showError(error);
    } finally {
      window.removeEventListener("unhandledrejection", onReject);
      if (my === scanId) scanning = false;
    }
  };

  return { onToggle, onScrape, reset };
};
