/**
 * navigation.js — tab navigation helpers
 * Opens or focuses extension pages and external URLs.
 * All functions that call chrome.tabs live here.
 */

const DASHBOARD = chrome.runtime.getURL("src/dashboard/dashboard.html");

/**
 * Opens the dashboard in a new tab, or brings an existing dashboard tab
 * to the front and reloads it so it picks up the latest scan.
 */
export const openDashboard = async () => {
   // First, check if a dashboard tab is already open
   const [existing] = await chrome.tabs.query({ url: DASHBOARD });
   if (existing) {
      // Then, bring it to the front and reload it with the new scan data
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.tabs.reload(existing.id);
      return;
   }
   // Finally, open a new tab
   await chrome.tabs.create({ url: DASHBOARD });
};

/**
 * Opens Chrome's download settings page in a new tab.
 * Used by the setup modal to guide the user to disable the save dialog.
 */
export const openChromeSettings = () =>
   chrome.tabs.create({ url: "chrome://settings/downloads" });
