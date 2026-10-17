# Config API

## Overview

All app configuration lives in a single endpoint: `GET /api/config`. This includes Google Drive credentials, versioning, download/purchase links, and the maintenance flag.

> **Breaking change:** The old `GET /api/links` endpoint has been removed. `purchaseLink` and `otherLinks` are now part of the main config response. Update any code that was calling `/api/links`.

> **Breaking change:** The old `GET /api/config/maintenance` and `PATCH /api/config/maintenance` endpoints have been removed. `isMaintenance` is now part of the main config response.

---

## GET /api/config

Returns the full app config. No authentication required.

**URL:** `GET /api/config`

**Response**

```json
{
  "message": "success",
  "data": {
    "googleDrive": {
      "clientId": "string | null",
      "clientSecret": "string | null"
    },
    "version": "1.2.0",
    "downloadLink": "https://...",
    "purchaseLink": "https://...",
    "otherLinks": "https://...",
    "isMaintenance": false
  }
}
```

All fields can be `null` or empty string if the server config has not been initialized yet.

---

## Maintenance Mode

Check `isMaintenance` on every extension startup (or poll periodically).

```js
const res = await fetch("https://your-api.com/api/config");
const { data } = await res.json();

if (data.isMaintenance === true) {
  // block extension usage and show a maintenance screen
}
```

---

## Version Check (Update Prompt)

Compare the extension's `manifest.json` version against `version` from the config response.

```js
const res = await fetch("https://your-api.com/api/config");
const { data } = await res.json();

const manifest = chrome.runtime.getManifest();

if (manifest.version !== data.version) {
  // show update prompt and direct the user to data.downloadLink
}
```

- `version` — the latest version string set via the admin panel
- `downloadLink` — direct download link for the latest version

---

## Links

```js
const res = await fetch("https://your-api.com/api/config");
const { data } = await res.json();

data.purchaseLink  // link to purchase or subscribe
data.otherLinks    // any other relevant link
```

These were previously served from `GET /api/links`. Use `data.purchaseLink` and `data.otherLinks` from the config response instead.

---

## Recommended Startup Flow

```js
const res = await fetch("https://your-api.com/api/config");
const { data } = await res.json();

// 1. Check maintenance first
if (data.isMaintenance) {
  showMaintenanceScreen();
  return;
}

// 2. Check for update
const manifest = chrome.runtime.getManifest();
if (manifest.version !== data.version) {
  showUpdatePrompt(data.downloadLink);
  return;
}

// 3. Proceed normally — links available at data.purchaseLink and data.otherLinks
```
