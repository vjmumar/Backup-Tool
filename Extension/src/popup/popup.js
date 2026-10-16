/**
 * popup.js — Popup screen controller
 *
 * Screens (data-screen attribute):
 *   loading          — shown on open while we check for a stored token
 *   signin           — email + password form
 *   forgot-password  — email form to request a password reset link
 *   change-password  — shown when freshSignIn === true (after sign-in or on every open)
 *   home             — shown when the user is authenticated and password is set
 *
 * All API calls go through the background service worker via
 * chrome.runtime.sendMessage so the API layer stays in one place.
 */

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/** Send a message to the background and return the response. */
const send = (type, payload = {}) =>
   chrome.runtime.sendMessage({ type, ...payload });

/** Show one screen, hide the rest. */
const showScreen = (name) => {
   document.querySelectorAll(".screen").forEach((el) => {
      el.hidden = el.dataset.screen !== name;
   });
};

/** Show an error alert inside a form screen. */
const showAlert = (id, message) => {
   const el = document.getElementById(id);
   if (!el) return;
   el.textContent = message;
   el.hidden = false;
};

/** Hide an alert. */
const hideAlert = (id) => {
   const el = document.getElementById(id);
   if (el) el.hidden = true;
};

/**
 * Put a button into a loading state — disables it and shows a spinner.
 * Returns a restore function to call when the operation finishes.
 */
const setLoading = (btn, loading) => {
   if (loading) {
      btn.disabled = true;
      btn._originalHtml = btn.innerHTML;
      btn.innerHTML = `<div class="spin"></div>`;
   } else {
      btn.disabled = false;
      if (btn._originalHtml) {
         btn.innerHTML = btn._originalHtml;
         delete btn._originalHtml;
      }
   }
};

// ─── PURCHASE LINK ─────────────────────────────────────────────────────────────

const fetchPurchaseLink = async () => {
   try {
      const result = await send("get-links");
      if (!result?.ok || !result.purchaseLink) return;
      const anchor = document.getElementById("purchase-link");
      if (!anchor) return;
      anchor.href = result.purchaseLink;
      anchor.hidden = false;
   } catch (_) {
      // Non-critical — silently ignore if the endpoint is unreachable
   }
};



const init = async () => {
   showScreen("loading");

   // Fetch the purchase link in the background — don't block auth on it
   fetchPurchaseLink();

   try {
      // Ask the background if there's a stored token
      const { token } = await send("auth-get-token");
      if (!token) {
         showScreen("signin");
         return;
      }

      // Token exists — always call getMe to get the latest user state
      const me = await send("auth-get-me");
      if (!me.ok) {
         // Token is expired or invalid — back to sign in
         showScreen("signin");
         return;
      }

      // freshSignIn still true — force them to set a permanent password
      if (me.freshSignIn) {
         showScreen("change-password");
         return;
      }

      populateHome(me.email, me.connectionLimit);
      showScreen("home");
   } catch (_) {
      showScreen("signin");
   }
};

// ─── HOME ──────────────────────────────────────────────────────────────────────

/**
 * Fills the home screen with the user's email, connection usage bar,
 * and "Purchase more" link when the user is at or near their limit.
 *
 * @param {string} email
 * @param {number} connectionLimit  from getMe response
 */
const populateHome = async (email, connectionLimit) => {
   document.getElementById("home-email").textContent = email || "—";
   const avatar = document.getElementById("home-avatar");
   avatar.textContent = email ? email[0].toUpperCase() : "?";

   // First, fetch the connection count and purchase link in parallel
   const [connResult, linksResult] = await Promise.all([
      send("platform-get-connections").catch(() => null),
      send("get-links").catch(() => null),
   ]);

   // Then, render the connection usage bar
   const used = Array.isArray(connResult?.connections) ? connResult.connections.length : 0;
   const limit = connectionLimit ?? 0;
   const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
   const atLimit = limit > 0 && used >= limit;

   document.getElementById("home-conn-count").textContent = `${used} / ${limit}`;
   document.getElementById("home-conn-detail").textContent =
      atLimit ? "Limit reached — upgrade to add more." : `${limit - used} slot${limit - used === 1 ? "" : "s"} remaining`;
   document.getElementById("home-conn-fill").style.width = `${pct}%`;
   document.getElementById("home-conn-fill").className =
      "conn-limit-fill" + (atLimit ? " full" : pct >= 66 ? " warn" : "");

   // Finally, show "Purchase more" link when at limit and a purchase URL is available
   if (atLimit && linksResult?.ok && linksResult.purchaseLink) {
      const link = document.getElementById("home-upgrade-link");
      link.href = linksResult.purchaseLink;
      link.hidden = false;
   }
};

// Sign out
document.getElementById("sign-out-btn").addEventListener("click", async () => {
   await send("auth-sign-out");
   showScreen("signin");
});

// ─── SIGN IN ───────────────────────────────────────────────────────────────────

document.getElementById("signin-form").addEventListener("submit", async (e) => {
   e.preventDefault();
   hideAlert("signin-alert");

   const form = e.target;
   const email = form.email.value.trim();
   const password = form.password.value;

   if (!email || !password) {
      showAlert("signin-alert", "Please enter your email and password.");
      return;
   }

   const btn = document.getElementById("signin-btn");
   setLoading(btn, true);

   try {
      const result = await send("auth-sign-in", { email, password });

      if (!result.ok) {
         showAlert("signin-alert", result.error || "Sign in failed. Please try again.");
         return;
      }

      // Always call getMe after sign-in — it's the source of truth for freshSignIn
      const me = await send("auth-get-me");
      if (!me.ok) {
         showAlert("signin-alert", "Signed in but could not load your account. Please try again.");
         return;
      }

      // freshSignIn — backend wants the user to set a permanent password
      if (me.freshSignIn) {
         showScreen("change-password");
         return;
      }

      populateHome(me.email, me.connectionLimit);
      showScreen("home");
   } finally {
      setLoading(btn, false);
   }
});

// ─── FORGOT PASSWORD ───────────────────────────────────────────────────────────

document.getElementById("forgot-form").addEventListener("submit", async (e) => {
   e.preventDefault();
   hideAlert("forgot-alert");

   const email = e.target.email.value.trim();
   if (!email) {
      showAlert("forgot-alert", "Please enter your email address.");
      return;
   }

   const btn = document.getElementById("forgot-btn");
   setLoading(btn, true);

   try {
      const result = await send("auth-forgot-password", { email });

      if (!result.ok) {
         showAlert("forgot-alert", result.error || "Could not send reset link. Please try again.");
         return;
      }

      // Success — go back to sign in so they can use the link they receive
      document.querySelectorAll(".alert").forEach((el) => (el.hidden = true));
      showScreen("signin");
   } finally {
      setLoading(btn, false);
   }
});

// ─── CHANGE PASSWORD ───────────────────────────────────────────────────────────

document.getElementById("change-password-form").addEventListener("submit", async (e) => {
   e.preventDefault();
   hideAlert("cp-alert");

   const form = e.target;
   const currentPassword = form.currentPassword.value;
   const newPassword = form.newPassword.value;
   const confirmPassword = form.confirmPassword.value;

   if (!currentPassword || !newPassword || !confirmPassword) {
      showAlert("cp-alert", "Please fill in all fields.");
      return;
   }

   if (newPassword !== confirmPassword) {
      showAlert("cp-alert", "New passwords do not match.");
      return;
   }

   if (newPassword.length < 8) {
      showAlert("cp-alert", "New password must be at least 8 characters.");
      return;
   }

   const btn = document.getElementById("cp-btn");
   setLoading(btn, true);

   try {
      const result = await send("auth-change-password", { currentPassword, newPassword });

      if (!result.ok) {
         showAlert("cp-alert", result.error || "Could not change password. Please try again.");
         return;
      }

      // Password changed — load the home screen
      const me = await send("auth-get-me");
      populateHome(me.ok ? me.email : "", me.ok ? me.connectionLimit : 0);
      showScreen("home");
   } finally {
      setLoading(btn, false);
   }
});

// ─── SCREEN NAVIGATION (data-go buttons) ──────────────────────────────────────

document.addEventListener("click", (e) => {
   const btn = e.target.closest("[data-go]");
   if (!btn) return;
   // Clear any lingering alerts when switching screens
   document.querySelectorAll(".alert").forEach((el) => (el.hidden = true));
   showScreen(btn.dataset.go);
});

// ─── BOOT ──────────────────────────────────────────────────────────────────────

init();
