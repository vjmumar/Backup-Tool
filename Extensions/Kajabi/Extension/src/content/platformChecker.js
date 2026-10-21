/**
 * platformChecker.js — remote platform descriptor loader
 *
 * Fetches the platform list from GET /api/platforms and builds a platform
 * object for whichever descriptor matches the current page URL.
 *
 * No platform-specific knowledge lives here. Adding Kartra, GHL, or any
 * other platform is a backend deploy — this file never changes.
 *
 * Exposes one function: window.__courseBackup.loadPlatform(send)
 * Called by content.js on every sync(). Returns a platform object or null.
 *
 * Platform object shape (mirrors the old kajabi.js interface):
 * {
 *   name:            string         — e.g. "kajabi"
 *   scraperName:     string         — passed to get-scraper
 *   isActivePage():  boolean        — true when the button should be shown
 *   getAccountId():  string|null    — reads the account ID from the page
 *   loadScraper(send): Promise<void> — fetches + evals the scraper script
 * }
 */

window.__courseBackup = window.__courseBackup || {};

// ─── SCRAPER CACHE ────────────────────────────────────────────────────────────

// Tracks which scrapers have already been fetched and eval'd this session.
// Keyed by scraperName so multiple platforms can each cache their own script.
const _scraperReady = {};

// ─── BUILD PLATFORM ───────────────────────────────────────────────────────────

/**
 * Turns a raw descriptor from the API into a usable platform object.
 * urlPattern is compiled into a RegExp once and reused on every isActivePage call.
 * accountIdExpression is eval'd in the MAIN world each time getAccountId is called.
 *
 * @param {{ name, scraperName, urlPattern, accountIdExpression }} descriptor
 * @returns {object}  platform object
 */
const buildPlatform = (descriptor) => {
   const { name, scraperName, urlPattern, accountIdExpression } = descriptor;

   // Compile the URL pattern once — avoids re-compiling on every navigation check
   const urlRegex = new RegExp(urlPattern);

   return {
      name,
      scraperName,

      // ─── IS ACTIVE PAGE ────────────────────────────────────────────────────

      /**
       * Returns true when the current URL matches this platform's pattern.
       * Called on every Turbo navigation, popstate, and polling tick.
       */
      isActivePage: () => urlRegex.test(location.href),

      // ─── GET ACCOUNT ID ────────────────────────────────────────────────────

      /**
       * Evals the platform's accountIdExpression in the MAIN world to read
       * the account ID. Returns a string or null if the value is unavailable.
       *
       * Using indirect eval so the expression runs in global scope and can
       * access window globals like window.CLIENT_INFO.
       */
      getAccountId: () => {
         try {
            // eslint-disable-next-line no-eval
            const id = (0, eval)(accountIdExpression);
            return id != null ? String(id) : null;
         } catch (_) {
            return null;
         }
      },

      // ─── LOAD SCRAPER ──────────────────────────────────────────────────────

      /**
       * Fetches the scraper script from the backend and evals it into the MAIN
       * world, defining window.__courseBackup.scrape.
       *
       * Cached per scraperName — safe to call multiple times. The script persists
       * on window across Turbo navigations so _scraperReady stays true.
       *
       * @param {function} send  The bridge send(type, payload, resolveWithData) helper
       * @returns {Promise<void>}  Rejects with an Error if the fetch or eval fails
       */
      loadScraper: async (send) => {
         // First, skip if this scraper is already loaded
         if (_scraperReady[scraperName]) return;

         // Then, fetch the raw script text from the backend
         const res = await send("get-scraper", { name: scraperName }, true);
         if (!res.ok)     throw new Error(res.error || "Could not load the scraper. Please try again.");
         if (!res.script) throw new Error("The server returned an empty scraper script.");

         // Then, eval in global scope so window.__courseBackup.scrape is set
         // eslint-disable-next-line no-eval
         (0, eval)(res.script);

         // Finally, confirm the script defined what we expect before caching
         if (typeof window.__courseBackup?.scrape !== "function") {
            throw new Error("Scraper script loaded but did not define window.__courseBackup.scrape.");
         }
         _scraperReady[scraperName] = true;
      },
   };
};

// ─── LOAD PLATFORM ────────────────────────────────────────────────────────────

/**
 * Fetches all platform descriptors from the backend and returns the one
 * whose urlPattern matches the current page, or null if none match.
 *
 * The background caches the platform list for the service worker session,
 * so repeated calls are cheap.
 *
 * @param {function} send  The bridge send(type, payload, resolveWithData) helper
 * @returns {Promise<object|null>}  A platform object, or null if no match
 */
window.__courseBackup.loadPlatform = async (send) => {
   // First, fetch the descriptor list from the background
   const res = await send("get-platforms", {}, true);
   if (!res.ok || !Array.isArray(res.platforms)) return null;

   // Then, find the first descriptor whose URL pattern matches the current page
   const match = res.platforms.find((p) => {
      try { return new RegExp(p.urlPattern).test(location.href); }
      catch (_) { return false; }
   });

   // Finally, build and return a platform object, or null if no match
   return match ? buildPlatform(match) : null;
};
