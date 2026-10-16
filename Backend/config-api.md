# Config API

## Overview

The Config API returns a static configuration object used by the extension (e.g. Google Drive credentials, API keys). No database involved — all values live in a constant inside the controller. Requires authentication.

---

## Endpoint

### GET `/api/config`

Returns the `CONFIG` constant object.

**Auth:** Required (`authorizationx: Bearer <token>`)

**Request body:** None

**Response**

```json
{
  "message": "success",
  "data": {
    "googleDrive": {
      "clientId": "your-client-id",
      "clientSecret": "your-client-secret"
    }
  }
}
```

**Error responses**

```json
// 401 — missing or invalid token
{ "message": "error", "data": { "message": "Unauthorized: missing or malformed token" } }

// 500 — unexpected error
{ "message": "error", "data": { ... } }
```

---

## Updating the Config

All values live in the `CONFIG` constant at the top of `src/controller/Config.ts`. Edit it directly — no schema changes, no environment variables, no migrations.

```ts
const CONFIG = {
  googleDrive: {
    clientId: "your-client-id",
    clientSecret: "your-client-secret",
  },
  // add more keys as needed
};
```

---

## Files

| File | Purpose |
|------|---------|
| `src/controller/Config.ts` | Handler + `CONFIG` constant |
| `src/route/Config.ts` | Mounts `GET /` → `getConfig` behind `verifyJwt` |
| `src/index.ts` | Mounts router at `/api/config` |
