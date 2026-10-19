/**
 * modals/addPlatformConnection.js — add platform connection modal
 *
 * Shown when the user tries to scrape but their platform account ID is not
 * yet linked to any connection. Lets them add it on the spot without
 * leaving the page.
 *
 * Renders into the shared ui modal (ui.setView) — no new DOM elements.
 * Exposes one function: showAddPlatformConnection(send, accountId)
 * Called directly from modals/scraper.js when a connection check returns allowed: false.
 */

window.__courseBackup = window.__courseBackup || {};
window.__courseBackup.modals = window.__courseBackup.modals || {};
window.__courseBackup.modals.addPlatformConnection = window.__courseBackup.modals.addPlatformConnection || {};

// ─── ICONS ────────────────────────────────────────────────────────────────────

const _APC_ICONS = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
};

// ─── RENDER ───────────────────────────────────────────────────────────────────

/**
 * Renders the modal body and footer for the current state.
 * Called on every state change — loading, error, and success.
 *
 * @param {object} opts
 * @param {string}   opts.platformName  e.g. "kajabi"
 * @param {string}   opts.accountId     the account ID being linked
 * @param {boolean}  [opts.loading]     true while the API call is in flight
 * @param {string}   [opts.error]       error message to show inline
 * @param {boolean}  [opts.success]     true after a successful connection
 */
const _renderAPC = ({ platformName, accountId, loading, error, success }) => {
  const { ui } = window.__courseBackup;

  const esc = (t) =>
    String(t ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );

  // First, build the body
  const body = success
    ? `<div class="state">
            <div class="ico">${_APC_ICONS.check}</div>
            <strong>Connection added</strong>
            <p>Your ${esc(platformName)} account has been linked. Click "Scrape courses" to continue.</p>
            <button class="btn primary" data-act="scrape">Scrape courses</button>
         </div>`
    : `<div class="state">
            <div class="ico">${_APC_ICONS.link}</div>
            <strong>Link your ${esc(platformName)} account</strong>
            <p>Account ID <code>${esc(accountId)}</code> is not linked to your profile yet.
               Add it as a connection to continue.</p>
            ${error ? `<p class="err">${esc(error)}</p>` : ""}
            <button class="btn primary" id="apc-confirm-btn" ${loading ? "disabled" : ""}>
               ${loading ? '<div class="spin"></div>' : "Add connection"}
            </button>
            <button class="btn" data-act="close" ${loading ? "disabled" : ""}>Cancel</button>
         </div>`;

  // Then, build the footer
  const footer = success
    ? `<div class="muted">Ready to scrape.</div>`
    : `<div class="muted">This will link account <strong>${esc(accountId)}</strong> to your profile.</div>`;

  // Finally, push both into the shared modal
  ui.setView(`Link ${esc(platformName)} account`, body, footer);
};

// ─── CONFIRM ──────────────────────────────────────────────────────────────────

/**
 * Handles the "Add connection" button click.
 * Calls platform-create-connection via the background message router.
 * Re-renders the modal on every state change so the user always sees feedback.
 *
 * @param {function} send          The bridge send() helper
 * @param {string}   platformName  e.g. "kajabi"
 * @param {string}   accountId     the account ID to save as lockId
 */
const _confirmAPC = async (send, platformName, accountId) => {
  // First, check app config — block if maintenance is on
  try {
    const config = await send("get-app-config", {}, true);
    if (config?.isMaintenance) {
      _renderAPC({
        platformName,
        accountId,
        error: "Adding connections is temporarily unavailable — the service is under maintenance. Please try again later.",
      });
      return;
    }
  } catch (_) {
    // Fail open
  }

  // Then, show a loading state so the button cannot be double-clicked
  _renderAPC({ platformName, accountId, loading: true });

  // Then, call the API
  const result = await send(
    "platform-create-connection",
    { platform: platformName, lockId: accountId },
    true,
  );

  // Finally, show success or surface the error — re-wire the button if showing error
  if (result.ok) {
    await send("platform-get-connections", {}, true).catch(() => { });
    _renderAPC({ platformName, accountId, success: true });
  } else {
    _renderAPC({
      platformName,
      accountId,
      error: result.error || "Could not add connection. Please try again.",
    });
    // Re-attach the listener since _renderAPC rebuilt the DOM
    _wireApcBtn(send, platformName, accountId);
  }
};

// ─── WIRE BUTTON ─────────────────────────────────────────────────────────────

/**
 * Finds the #apc-confirm-btn in the current modal body and attaches a
 * one-time click listener. Called after every render that shows the button
 * (initial idle state and error state after a failed attempt).
 */
const _wireApcBtn = (send, platformName, accountId) => {
  const { ui } = window.__courseBackup;
  const btn = ui.getBody()?.querySelector("#apc-confirm-btn");
  if (!btn) return;
  let _busy = false;
  btn.addEventListener("click", async () => {
    if (_busy) return;
    _busy = true;
    try {
      await _confirmAPC(send, platformName, accountId);
    } finally {
      _busy = false;
    }
  });
};

// ─── SHOW ─────────────────────────────────────────────────────────────────────

/**
 * Renders the add-connection flow inside the shared modal.
 * Called from modals/scraper.js when check-connection returns allowed: false.
 *
 * @param {function} send       The bridge send() helper from content.js
 * @param {string}   accountId  The platform account ID detected on the page
 */
window.__courseBackup.modals.addPlatformConnection.show = (send, platform, accountId) => {
  const { ui } = window.__courseBackup;
  const platformName = platform.name;

  // First, render the initial (idle) state
  _renderAPC({ platformName, accountId });

  // Then, wire the confirm button — done after render so the element exists in the DOM
  _wireApcBtn(send, platformName, accountId);

  // Finally, open the modal if it isn't already
  if (!ui.isOpen()) ui.open();
};
