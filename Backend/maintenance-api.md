# Maintenance API

## Overview

The maintenance flag is a server-side boolean (`isMaintenance`) that lives in memory inside `src/controller/Config.ts`. Toggle it on/off from the backdoor admin panel. The frontend reads it on load and shows a maintenance screen when it is `true`.

---

## Endpoints

### GET `/api/config/maintenance`

Returns the current maintenance status.

**Auth:** None

**Response**

```json
{ "message": "success", "data": { "isMaintenance": false } }
```

---

### PATCH `/api/config/maintenance`

Toggles the maintenance flag.

**Auth:** None (protected by the backdoor password prompt)

**Request body**

```json
{ "isMaintenance": true }
```

**Response**

```json
{ "message": "success", "data": { "isMaintenance": true } }
```

**Error responses**

```json
// 400 — wrong type
{ "message": "error", "data": { "message": "isMaintenance must be a boolean" } }
```

---

## How to Use from the Frontend

Poll or check on app load — if `isMaintenance` is `true`, block the UI and show a maintenance screen.

```js
const res = await fetch("https://your-api.com/api/config/maintenance");
const { data } = await res.json();

if (data.isMaintenance) {
  // show maintenance screen
}
```

---

## Backdoor Admin Panel

Open `https://your-api.com/backdoor` in a browser. Enter the backdoor password when prompted. Use the toggle in the top-right to flip maintenance mode on or off instantly.

> The flag resets to `false` on server restart since it is stored in memory, not the database.

---

## Files

| File | Purpose |
|------|---------|
| `src/controller/Config.ts` | Holds the `isMaintenance` variable + `getMaintenance` / `setMaintenance` handlers |
| `src/route/Config.ts` | Mounts `GET /maintenance` and `PATCH /maintenance` on `/api/config` |
| `src/backdoor/index.html` | Admin panel UI with the maintenance toggle |
| `src/controller/Backdoor.ts` | Serves the HTML panel + user management API handlers |
| `src/route/Backdoor.ts` | Mounts panel at `/backdoor`, user API at `/api/backdoor` |
