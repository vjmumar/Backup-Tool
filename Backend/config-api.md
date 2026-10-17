# Config API

## Overview

All app configuration — including Google Drive credentials, the current version, the download link, and the maintenance flag — now lives in a single database-backed endpoint: `GET /api/config`.

> **Breaking change:** The old separate endpoints `GET /api/config/maintenance` and `PATCH /api/config/maintenance` have been removed. `isMaintenance` is now part of the main config response. Update any code that was calling those endpoints.

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
    "isMaintenance": false
  }
}
```

All fields can be `null` if the server config has not been initialized yet.

---

## Maintenance Mode

`isMaintenance` is now returned as part of `GET /api/config` — there is no longer a separate maintenance endpoint.

Check this flag on every extension startup (or poll periodically).

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

// 3. Proceed normally
```

---

## Files

| File | Purpose |
|------|---------|
| `src/controller/Config.ts` | `getConfig` and `updateConfig` handlers |
| `src/route/Config.ts` | Mounts `GET /` and `PATCH /` on `/api/config` |
| `src/backdoor/index.html` | Admin panel — gear icon opens config modal to update all fields |
