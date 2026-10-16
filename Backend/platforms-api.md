# Platforms API

## Overview

The Platforms API returns a list of platform descriptors used by the extension.
Each descriptor tells the extension which URLs to activate on, how to extract the
platform account ID from the page, and which scraper to load.

No database involved — all values live in a constant inside the controller.
Requires authentication.

Adding a new platform is a single deploy: edit the `PLATFORMS` constant and add the
corresponding scraper file to `src/scrapers/`. No extension update required.

---

## Endpoint

### GET `/api/platforms`

Returns the full `PLATFORMS` array.

**Auth:** Required (`authorizationx: Bearer <token>`)

**Request body:** None

**Response**

```json
{
  "message": "success",
  "data": [
    {
      "name": "kajabi",
      "scraperName": "kajabiCourse",
      "urlPattern": "^https:\\/\\/app\\.kajabi\\.com\\/admin\\/sites\\/\\d+\\/courses\\/?",
      "accountIdExpression": "window.CLIENT_INFO?.account_id"
    }
  ]
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

## Platform Descriptor Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Internal platform identifier. Matches the `platform` field in `PlatformConnection`. e.g. `"kajabi"` |
| `scraperName` | `string` | Passed to `GET /api/scrapers/:name` to fetch the scraper script. e.g. `"kajabiCourse"` |
| `urlPattern` | `string` | A regex pattern (as a JSON string) tested against `location.href` to decide whether the floating button should appear. |
| `accountIdExpression` | `string` | A JS expression eval'd in the page's MAIN world to read the platform account ID. Must return a string or null/undefined. e.g. `"window.CLIENT_INFO?.account_id"` |

---

## Adding a New Platform

Edit the `PLATFORMS` constant in `src/controller/Platforms.ts` and add the scraper
file to `src/scrapers/`. No extension update needed.

```ts
const PLATFORMS = [
  {
    name: "kajabi",
    scraperName: "kajabiCourse",
    urlPattern: "^https:\\/\\/app\\.kajabi\\.com\\/admin\\/sites\\/\\d+\\/courses\\/?",
    accountIdExpression: "window.CLIENT_INFO?.account_id",
  },
  // Add new platforms here:
  // {
  //   name: "kartra",
  //   scraperName: "kartraCourse",
  //   urlPattern: "^https:\\/\\/app\\.kartra\\.com\\/...",
  //   accountIdExpression: "window.__someGlobal?.id",
  // },
];
```

---

## How the Extension Uses This

1. On every page navigation, the extension calls `GET /api/platforms`
2. Each descriptor's `urlPattern` is compiled into a `RegExp` and tested against `location.href`
3. When a match is found, `accountIdExpression` is eval'd in the MAIN world to read the account ID
4. `scraperName` is passed to `GET /api/scrapers/:name` on the first toggle click

The list is cached in the background service worker for the session. A service worker
restart (idle timeout) triggers a fresh fetch automatically.

> **Note:** `manifest.json` `host_permissions` and `content_scripts.matches` must
> include any new platform domain — this is a Chrome hard requirement and still needs
> an extension update when adding a completely new domain.

---

## Files

| File | Purpose |
|------|---------|
| `src/controller/Platforms.ts` | Handler + `PLATFORMS` constant |
| `src/route/Platforms.ts` | Mounts `GET /` → `getPlatforms` behind `verifyJwt` |
| `src/index.ts` | Mounts router at `/api/platforms` |
