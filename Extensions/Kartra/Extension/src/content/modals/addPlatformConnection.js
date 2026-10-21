/**
 * modals/addPlatformConnection.js — add platform connection modal (Kartra)
 *
 * Shown when the user tries to scan but their Kartra account ID is not
 * yet linked to any connection. Lets them add it on the spot without
 * leaving the page.
 *
 * Renders into the shared ui modal (ui.setView) — no new DOM elements.
 * Exposes: window.__courseBackup.modals.addPlatformConnection.show(send, platform, accountId)
 * Called from modals/scraper.js when check-connection returns allowed: false.
 */

window.__courseBackup = window.__courseBackup || {};
window.__courseBackup.modals = window.__courseBackup.modals || {};
window.__courseBackup.modals.addPlatformConnection = window.__courseBackup.modals.addPlatformConnection || {};

// ── ICONS ──────────────────────────────────────────────────────────────────────

const _APC_ICONS = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
};

// ── RENDER ─────────────────────────────────────────────────────────────────────

const _renderAPC = ({ accountId, loading, error, success }) => {
  const { ui } = window.__courseBackup;

  const esc = (t) =>
    String(t ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const body = success
    ? `<div class="state">
          <div class="ico">${_APC_ICONS.check}</div>
          <strong>Connection added</strong>
          <p>Your Kartra account has been linked. Click "Back up memberships" to continue.</p>
          <button class="btn primary" data-act="scrape">Back up memberships</button>
       </div>`
    : `<div class="state">
          <div class="ico">${_APC_ICONS.link}</div>
          <strong>Link your Kartra account</strong>
          <p>Account ID <code>${esc(accountId)}</code> is not linked to your profile yet.
             Add it as a connection to continue.</p>
          ${error ? `<p class="err">${esc(error)}</p>` : ""}
          <button class="btn primary" id="apc-confirm-btn" ${loading ? "disabled" : ""}>
             ${loading ? '<div class="spin"></div>' : "Add connection"}
          </button>
          <button class="btn" data-act="close" ${loading ? "disabled" : ""}>Cancel</button>
       </div>`;

  const footer = success
    ? `<div class="muted">Ready to scan.</div>`
    : `<div class="muted">This will link account <strong>${esc(accountId)}</strong> to your profile.</div>`;

  ui.setView("Link Kartra account", body, footer);
};

// ── CONFIRM ────────────────────────────────────────────────────────────────────

const _confirmAPC = async (send, platformName, accountId) => {
  // Check maintenance gate first
  try {
    const config = await send("get-app-config", {}, true);
    if (config?.isMaintenance) {
      _renderAPC({
        accountId,
        error: "Adding connections is temporarily unavailable — the service is under maintenance. Please try again later.",
      });
      return;
    }
  } catch (_) {
    // Fail open
  }

  _renderAPC({ accountId, loading: true });

  const result = await send(
    "platform-create-connection",
    { platform: platformName, lockId: accountId },
    true,
  );

  if (result.ok) {
    await send("platform-get-connections", {}, true).catch(() => { });
    _renderAPC({ accountId, success: true });
  } else {
    _renderAPC({ accountId, error: result.error || "Could not add connection. Please try again." });
    _wireApcBtn(send, platformName, accountId);
  }
};

// ── WIRE BUTTON ────────────────────────────────────────────────────────────────

const _wireApcBtn = (send, platformName, accountId) => {
  const { ui } = window.__courseBackup;
  const btn = ui.getBody()?.querySelector("#apc-confirm-btn");
  if (!btn) return;
  let _busy = false;
  btn.addEventListener("click", async () => {
    if (_busy) return;
    _busy = true;
    try { await _confirmAPC(send, platformName, accountId); }
    finally { _busy = false; }
  });
};

// ── SHOW ───────────────────────────────────────────────────────────────────────

window.__courseBackup.modals.addPlatformConnection.show = (send, platform, accountId) => {
  const { ui } = window.__courseBackup;
  const platformName = platform.name;

  _renderAPC({ accountId });
  _wireApcBtn(send, platformName, accountId);

  if (!ui.isOpen()) ui.open();
};
