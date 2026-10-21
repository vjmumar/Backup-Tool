/**
 * content.js — thin coordinator, runs in the page's MAIN world.
 *
 * Responsibilities (and nothing else):
 *   1. Expose the shared send() bridge helper on window.__courseBackup
 *      so every modal can reach the background without re-implementing the bridge.
 *   2. On every navigation, call loadPlatform(send) to get the matching platform
 *      descriptor from the backend, then mount or unmount the floating button.
 *
 * Everything else lives in dedicated modules loaded before this file:
 *   platformChecker.js      → window.__courseBackup.loadPlatform
 *   ui.js                   → window.__courseBackup.ui
 *   modals/scraper.js       → window.__courseBackup.modals.scraper
 *   modals/addPlatformConnection.js → window.__courseBackup.modals.addPlatformConnection
 */
(() => {
  const { ui } = window.__courseBackup;

  // ── Bridge helper ──────────────────────────────────────────────────────────

  /**
   * Sends a message to the background service worker via bridge.js and
   * waits for the response.
   *
   * resolveWithData: when true, resolves with the full response object
   * instead of rejecting on ok:false. Needed when the caller inspects
   * the payload (e.g. check-connection, get-scraper, get-platforms).
   */
  const send = (type, payload = {}, resolveWithData = false) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMsg);
        reject(new Error("The extension did not answer. Reload this page and try again."));
      }, 15000);
      const onMsg = (event) => {
        const data = event.data;
        if (
          event.source !== window ||
          !data ||
          data.source !== "course-backup-bg" ||
          data.type !== `${type}-done`
        ) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        resolveWithData
          ? resolve(data)
          : data.ok
            ? resolve()
            : reject(new Error(data.error || "The extension could not complete the request."));
      };
      window.addEventListener("message", onMsg);
      window.postMessage({ source: "course-backup", type, ...payload }, location.origin);
    });

  // Expose send so modals can reach the background without rewiring the bridge
  window.__courseBackup.send = send;

  // ── Page sync ──────────────────────────────────────────────────────────────
  // On every navigation:
  //   1. Ask the backend for the matching platform descriptor
  //   2. Check if the user is signed in
  //   3. Mount the button if both pass, unmount otherwise
  //
  // _syncing prevents concurrent async calls from racing past the checks.

  let _scraperModal = null;
  let _syncing = false;

  const sync = async () => {
    if (_syncing) return;
    _syncing = true;
    try {
      // First, unmount immediately — nothing visible during async checks
      ui.unmount();
      _scraperModal?.reset();
      _scraperModal = null;

      // Then, fetch the matching platform descriptor for this page
      let platform = null;
      try {
        platform = await window.__courseBackup.loadPlatform(send);
      } catch (_) {
        platform = null;
      }

      // No platform matches this URL — stay unmounted
      if (!platform) return;

      // Then, check if the user is signed in
      let signedIn = false;
      try {
        const res = await send("auth-get-token", {}, true);
        signedIn = !!(res?.ok && res?.token);
      } catch (_) {
        signedIn = false;
      }

      if (!signedIn) return;

      // Finally, mount the button with a fresh scraper modal instance
      _scraperModal = window.__courseBackup.modals.scraper.init(send, platform);
      ui.mount({
        onToggle: _scraperModal.onToggle,
        onScrape: _scraperModal.onScrape,
        onDashboard: () => send("open-dashboard").catch((err) => ui.showError(err)),
      });

    } finally {
      _syncing = false;
    }
  };

  sync();
  document.addEventListener("turbo:load", sync);
  window.addEventListener("popstate", sync);
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; sync(); }
  }, 1000);
})();
