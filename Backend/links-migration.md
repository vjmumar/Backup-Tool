# Links Migration

## What changed

The `GET /api/links` endpoint has been removed. Links are now part of the main config response at `GET /api/config`.

`otherLinks` was also dropped — only `purchaseLink` remains.

---

## Before

```js
// Two separate calls
const configRes = await fetch("/api/config");
const linksRes  = await fetch("/api/links");

const { isMaintenance } = (await configRes.json()).data;
const [{ purchaseLink, otherLinks }] = (await linksRes.json()).data;
```

## After

```js
// One call for everything
const res = await fetch("/api/config");
const { data } = await res.json();

data.purchaseLink  // previously from /api/links
data.isMaintenance // unchanged, still here
```

---

## Updated GET /api/config response shape

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
    "isMaintenance": false
  }
}
```

---

## Action required

- Remove any calls to `GET /api/links`
- Read `purchaseLink` from `GET /api/config` instead
- Remove any references to `otherLinks` — that field no longer exists
