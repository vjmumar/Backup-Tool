/**
 * The UI: a floating button and a modal, inside a Shadow DOM so
 * Kajabi's CSS cannot touch it and ours cannot touch Kajabi.
 * Exposed as window.__courseBackup.ui
 *
 * The floating button only opens and closes the modal. The scan starts
 * only when the user clicks "Scrape courses" inside the modal.
 * The tree is not here: it lives in the dashboard tab.
 */
window.__courseBackup = window.__courseBackup || {};

window.__courseBackup.ui = (() => {
  // First, the CSS
  const css = `
/* Colors, fonts and shadow: light by default, dark when the system is dark */
:host {
   all: initial;
   --surface: #ffffff; --bg: #f3f5f6; --ink: #16212b; --muted: #5b6a77; --line: #dde3e8;
   --accent: #0e6b63; --accent-ink: #ffffff; --accent-soft: #dff0ed;
   --good: #1b7a44; --good-soft: #e1f3e7; --warn: #9a5a00; --warn-soft: #fff0d6; --bad: #b3261e; --bad-soft: #fbe8e6;
   --scrim: rgba(12, 20, 28, .55); --shadow: 0 16px 48px rgba(12, 20, 28, .28);
   --font-display: "Bricolage Grotesque", system-ui, -apple-system, "Segoe UI", sans-serif;
   --font-body: "Instrument Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
   --font-mono: "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace;
   font-family: var(--font-body); font-size: 14px; line-height: 1.45; color: var(--ink);
}
@media (prefers-color-scheme: dark) {
   :host {
      --surface: #17212a; --bg: #0f161c; --ink: #e7edf2; --muted: #93a2af; --line: #2a3743;
      --accent: #3fb5a8; --accent-ink: #06201d; --accent-soft: #16312f;
      --good: #5cc98a; --good-soft: #163025; --warn: #f0b255; --warn-soft: #352711; --bad: #ff8f86; --bad-soft: #3a1c1a;
      --scrim: rgba(0, 0, 0, .65); --shadow: 0 16px 48px rgba(0, 0, 0, .55);
   }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
button { font: inherit; color: inherit; cursor: pointer; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* Floating button: only opens and closes the modal */
.fab { position: fixed; right: 20px; bottom: 20px; z-index: 2147483646; display: flex; align-items: center; gap: 10px;
   padding: 13px 18px 13px 14px; border: 0; border-radius: 999px; background: var(--accent); color: var(--accent-ink);
   font-weight: 600; box-shadow: var(--shadow); }
.fab svg { width: 20px; height: 20px; }
.fab:hover { filter: brightness(1.08); }

/* Modal */
.scrim { position: fixed; inset: 0; z-index: 2147483647; background: var(--scrim); display: flex; align-items: center; justify-content: center; padding: 16px; }
.modal { width: 100%; max-width: 720px; max-height: min(88vh, 780px); background: var(--surface); border: 1px solid var(--line);
   border-radius: 14px; box-shadow: var(--shadow); display: flex; flex-direction: column; overflow: hidden; }
.mh { display: flex; align-items: flex-start; gap: 12px; padding: 16px 18px; border-bottom: 1px solid var(--line); }
.mh h2 { font-family: var(--font-display); font-size: 19px; line-height: 1.2; margin: 0; font-weight: 700; }
.mh p { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
.mh .grow { flex: 1; min-width: 0; }
.x { border: 0; background: transparent; width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; color: var(--muted); }
.x:hover { background: var(--bg); color: var(--ink); }
.mb { padding: 14px 18px; overflow: auto; flex: 1; min-height: 200px; }
.mf { display: flex; align-items: center; gap: 16px; padding: 14px 18px; border-top: 1px solid var(--line); background: var(--bg); flex-wrap: wrap; }
.mf .sum { flex: 1; min-width: 220px; }
.muted { color: var(--muted); }
.small { font-size: 12px; margin: 6px 0 0; }
.err { color: var(--bad); font-size: 12px; margin: 6px 0 0; }

/* Buttons */
.btn { border: 1px solid var(--line); background: var(--surface); border-radius: 9px; padding: 9px 16px; font-weight: 600; }
.btn:hover { border-color: var(--muted); }
.btn.primary { text-decoration: none !important; background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.btn.primary:hover { filter: brightness(1.08); }
.btn:disabled { opacity: .45; cursor: not-allowed; filter: none; }

/* Ready and extracting states */
.state { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 56px 0; text-align: center; }
.state strong { font-size: 15px; }
.state p { margin: 0; max-width: 380px; color: var(--muted); }
.state .ico { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); }
.state .ico svg { width: 22px; height: 22px; }
.spin { width: 28px; height: 28px; border-radius: 50%; border: 3px solid var(--line); border-top-color: var(--accent); animation: sp .8s linear infinite !important; }
@keyframes sp { to { transform: rotate(360deg); } }
.warn-stay { margin: 4px 0 0; font-size: 12px; color: var(--warn); }
   `;

  // Then, the icons
  const icons = {
    cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4 4 0 0 1-.5 9.5"/><path d="M12 21v-8m0 0-3 3m3-3 3 3"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    close: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  };

  // Then, the HTML frame: the floating button and the modal. Header subtitle, body and footer are filled by script.
  const frame = `
      <button class="fab" id="fab" aria-haspopup="dialog">${icons.cloud}Back up courses</button>
      <div class="scrim" id="scrim" hidden>
         <div class="modal" role="dialog" aria-modal="true" aria-labelledby="mt">
            <div class="mh">
               <div class="grow"><h2 id="mt">Back up courses</h2><p id="ms"></p></div>
               <button class="x" data-act="close" aria-label="Close">${icons.close}</button>
            </div>
            <div class="mb" id="mb"></div>
            <div class="mf" id="mf"></div>
         </div>
      </div>`;

  const esc = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // The elements are found once and kept, only their content changes
  let host, root, fab, scrim, sub, mb, mf, handlers;

  const mount = (given) => {
    if (host) return;
    handlers = given;

    // First, the host element with the shadow root, CSS and HTML go inside it
    host = document.createElement("div");
    host.id = "course-backup-host";
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${css}</style>${frame}`;
    fab = root.getElementById("fab");
    scrim = root.getElementById("scrim");
    sub = root.getElementById("ms");
    mb = root.getElementById("mb");
    mf = root.getElementById("mf");

    // Then, the floating button only toggles the modal
    fab.addEventListener("click", () => handlers.onToggle());

    // Then, the buttons inside the modal: close, scrape, dashboard (any element with data-act)
    scrim.addEventListener("click", (e) => {
      if (e.target === scrim) return close();
      const button = e.target.closest("[data-act]");
      if (!button || button.disabled) return;
      if (button.dataset.act === "close") close();
      if (button.dataset.act === "scrape") handlers.onScrape();
      if (button.dataset.act === "dashboard") handlers.onDashboard();
    });
    document.addEventListener("keydown", onKey, true);

    // Finally, add it to the page
    document.documentElement.append(host);
  };

  const onKey = (e) => e.key === "Escape" && isOpen() && close();
  const isOpen = () => !!scrim && !scrim.hidden;
  const open = () => (scrim.hidden = false);
  const close = () => (scrim.hidden = true);

  const unmount = () => {
    if (!host) return;
    document.removeEventListener("keydown", onKey, true);
    host.remove();
    host = root = fab = scrim = sub = mb = mf = null;
  };

  // One place that fills the three parts of the modal
  const setView = (subtitle, body, footer) => {
    sub.textContent = subtitle;
    mb.onclick = null;
    mb.innerHTML = body;
    mf.innerHTML = footer;
  };

  // The ready state: nothing is scanned until the user clicks "Scrape courses"
  const showReady = () => {
    setView(
      "Kajabi admin",
      `<div class="state">
            <div class="ico">${icons.cloud}</div>
            <strong>Ready to scan your courses</strong>
            <p>Reads your courses, lessons and files from Kajabi. Nothing is downloaded.</p>
            <button class="btn primary" data-act="scrape">Scrape courses</button>
         </div>`,
      '<div class="muted">Not scanned yet.</div><button class="btn" data-act="dashboard">Open dashboard</button>',
    );
  };

  // The "Extracting courses" state — updates live without a full redraw
  const showScanning = (status) => {
    // If the scanning view is already showing, just update the status text in place
    const existing = mb && mb.querySelector(".scan-status");
    if (existing) {
      existing.textContent = status || "Reading…";
      return;
    }
    setView(
      "Extracting courses",
      `<div class="state">
            <div class="spin"></div>
            <strong>Extracting courses</strong>
            <p class="scan-status">${esc(status || "Reading your courses, lessons and files. Nothing is downloaded yet.")}</p>
            <p class="warn-stay">⚠️ Keep this tab open and active while the scan runs.</p>
         </div>`,
      '<div class="muted">Extracting courses...</div><button class="btn" data-act="dashboard">Open dashboard</button>',
    );
  };

  // The error state: the user can try again from here
  const showError = (error) => {
    const msg = esc((error && error.message) || error);
    const linkHtml = error?.downloadLink
      ? `<a class="btn primary" href="${esc(error.downloadLink)}" target="_blank" rel="noopener noreferrer">Download update</a>`
      : `<button class="btn primary" data-act="scrape">Try again</button>`;
    setView(
      "Something went wrong",
      `<div class="state">
            <strong>The courses could not be extracted</strong>
            <p class="err">${msg}</p>
            ${linkHtml}
         </div>`,
      '<div class="muted">Nothing was saved.</div><button class="btn" data-act="dashboard">Open dashboard</button><button class="btn" data-act="close">Close</button>',
    );
  };

  // The done state: the scan is saved, the dashboard opens in its own tab
  const showDone = ({ courses, lessons }) => {
    setView(
      "Scan finished",
      `<div class="state">
            <div class="ico">${icons.check}</div>
            <strong>${courses} ${courses === 1 ? "course" : "courses"} and ${lessons} ${lessons === 1 ? "lesson" : "lessons"} found</strong>
            <p>Open the dashboard to choose what to back up and see the file sizes. You can keep this tab open, it is used to get fresh download links.</p>
            <button class="btn primary" data-act="dashboard">Open dashboard</button>
         </div>`,
      '<div class="muted">Scanned just now.</div><button class="btn" data-act="scrape">Scrape again</button>',
    );
  };

  return { mount, unmount, open, close, isOpen, showReady, showScanning, showError, showDone, setView, getBody: () => mb };
})();
