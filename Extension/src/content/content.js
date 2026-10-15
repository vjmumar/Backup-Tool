/**
 * Entry point, runs in the page's own world (manifest: "world": "MAIN"),
 * so the scraper can read window.validationToken.
 * The floating button shows only on the course list page and only opens the modal.
 * The scan starts only from the "Scrape courses" button inside the modal.
 * The scanned courses are not shown here: they are sent to the background,
 * saved, and the dashboard tab shows them.
 */
(() => {
  const { scrape, ui } = window.__courseBackup;

  // The course list page: https://app.kajabi.com/admin/sites/<siteId>/courses
  const isCoursesPage = () => /^https:\/\/app\.kajabi\.com\/admin\/sites\/\d+\/courses\/?(\?.*)?$/.test(location.href);

  // A scan is running, a second click must not start another one
  let scanning = false;
  // Changes when the page is left, so an old scan can not touch the UI
  let scanId = 0;
  // What the last finished scan found: { courses, lessons }. The courses themselves are not kept here.
  let saved = null;

  /**
   * Talks to the background through bridge.js and waits for its answer.
   * Messages: handoff-start, handoff-course, handoff-end, open-dashboard
   */
  const send = (type, payload = {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("The extension did not answer. Reload this page and try again."));
      }, 15000);
      const onMessage = (event) => {
        const data = event.data;
        if (event.source !== window || !data || data.source !== "course-backup-bg" || data.type !== `${type}-done`) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        data.ok ? resolve() : reject(new Error(data.error || "The extension could not save the courses."));
      };
      window.addEventListener("message", onMessage);
      window.postMessage({ source: "course-backup", type, ...payload }, location.origin);
    });

  // First, tell the background a new scan is coming, it clears the old one
  // Then, send the courses one at a time, a big message in one go could fail
  // Finally, tell it the scan is complete
  const handoff = async (courses) => {
    await send("handoff-start");
    for (let i = 0; i < courses.length; i++) await send("handoff-course", { index: i, course: courses[i] });
    await send("handoff-end", { count: courses.length });
  };

  // How many lessons the scan found, for the "Scan finished" screen
  const countLessons = (courses) => courses.reduce((total, course) =>
    total + course.categories.reduce((sum, category) => sum + (category.posts || []).length, 0), 0);

  /**
   * Stamps a stable id onto every course and category.
   * Lessons already have post.id from the Kajabi API.
   *   course.id   = "course-<ci>"
   *   category.id = "cat-<ci>-<ki>"
   *   category.emptyId = "empty-<ci>-<ki>"  (only when the category has no posts)
   */
  const addIds = (courses) => courses.map((course, ci) => ({
    ...course,
    id: `course-${ci}`,
    categories: (course.categories || []).map((category, ki) => ({
      ...category,
      id: `cat-${ci}-${ki}`,
      emptyId: (category.posts || []).length === 0 ? `empty-${ci}-${ki}` : null,
      posts: (category.posts || []).map((post) => ({ ...post, id: String(post.id) })),
    })),
  }));

  // First, the floating button: close the modal if it is open, otherwise open it on the right screen
  // Then, no scan starts here: ready screen, or the scan in progress, or the finished scan
  const onToggle = () => {
    if (ui.isOpen()) return ui.close();
    if (saved) ui.showDone(saved);
    else if (scanning) ui.showScanning();
    else ui.showReady();
    ui.open();
  };

  /**
   * The data flow, in this order:
   * First, the "Scrape courses" button inside the modal calls onScrape.
   * Then, the scraper runs and RETURNS the parsed courses.
   * Finally, the returned courses are handed to the background (saved), and the modal says the scan is finished.
   *
   * The scraper builds its lists inside new Promise(async ...), so an error thrown there
   * never reaches try/catch: it only becomes an unhandled rejection and the scan would wait forever.
   * So during the scan we also listen for an unhandled rejection that comes from scraper.js.
   */
  const onScrape = async () => {
    if (scanning) return;
    scanning = true;
    saved = null;
    ui.showScanning();
    const my = scanId;
    let onReject;
    const failed = new Promise((_, reject) => {
      onReject = (e) => String(e.reason && e.reason.stack).includes("scraper.js") && reject(e.reason);
      window.addEventListener("unhandledrejection", onReject);
    });
    try {
      const parsed = await Promise.race([scrape((text) => {
        if (my !== scanId) return;
        if (ui.isOpen()) ui.showScanning(text);
      }), failed]);
      if (my !== scanId) return;
      // First, stamp stable IDs onto every course and category before handing off
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

  // First, show the button on the courses page, remove it everywhere else
  const sync = () => {
    if (isCoursesPage()) {
      ui.mount({ onToggle, onScrape, onDashboard: () => send("open-dashboard").catch((error) => ui.showError(error)) });
    } else {
      scanId++;
      scanning = false;
      saved = null;
      ui.unmount();
    }
  };

  // Then, Kajabi changes pages without a reload, so check again on every Turbo page load
  // Finally, a light URL check covers navigations that fire no Turbo event
  sync();
  document.addEventListener("turbo:load", sync);
  window.addEventListener("popstate", sync);
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      sync();
    }
  }, 1000);
})();
