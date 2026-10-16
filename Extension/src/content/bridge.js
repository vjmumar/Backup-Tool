/**
 * Runs in the ISOLATED world: it has chrome.runtime, the page script does not.
 * It only relays: page -> background (window message "course-backup"),
 * and the answer of the background -> page (window message "course-backup-bg").
 * Messages are sent one after the other, so the courses arrive in order.
 */
(() => {
   const TYPES = ["handoff-start", "handoff-course", "handoff-end", "open-dashboard", "check-connection", "auth-get-token", "get-scraper", "get-platforms", "platform-create-connection", "platform-get-connections", "get-maintenance"];
   let queue = Promise.resolve();

   // First, only accept messages sent by this same page and made for us
   window.addEventListener("message", (event) => {
      const data = event.data;
      if (event.source !== window || !data || data.source !== "course-backup" || !TYPES.includes(data.type)) return;

      // Then, send them to the background in order and tell the page how it went
      queue = queue.then(async () => {
         let answer;
         try {
            // Forward the full payload — destructure source so it isn't re-sent
            const { source: _src, ...payload } = data;
            answer = await chrome.runtime.sendMessage(payload);
         } catch (error) {
            answer = { ok: false, error: String(error && error.message) };
         }
         // Finally, the page waits for these answers — pass the full answer back
         window.postMessage(
            { source: "course-backup-bg", type: `${data.type}-done`, ...(answer || {}), ok: !!(answer && answer.ok) },
            location.origin,
         );
      });
   });
})();
