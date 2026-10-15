/**
 * Runs in the ISOLATED world: it has chrome.runtime, the page script does not.
 * It only relays: page -> background (window message "course-backup"),
 * and the answer of the background -> page (window message "course-backup-bg").
 * Messages are sent one after the other, so the courses arrive in order.
 */
(() => {
   const TYPES = ["handoff-start", "handoff-course", "handoff-end", "open-dashboard"];
   let queue = Promise.resolve();

   // First, only accept messages sent by this same page and made for us
   window.addEventListener("message", (event) => {
      const data = event.data;
      if (event.source !== window || !data || data.source !== "course-backup" || !TYPES.includes(data.type)) return;

      // Then, send them to the background in order and tell the page how it went
      queue = queue.then(async () => {
         let answer;
         try {
            answer = await chrome.runtime.sendMessage({ type: data.type, index: data.index, course: data.course, count: data.count });
         } catch (error) {
            answer = { ok: false, error: String(error && error.message) };
         }
         // Finally, the page waits for these answers
         window.postMessage({ source: "course-backup-bg", type: `${data.type}-done`, ok: !!(answer && answer.ok), error: answer && answer.error }, location.origin);
      });
   });
})();
