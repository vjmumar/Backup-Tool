# Backup Tool — API Reference

All requests and responses use JSON. Protected routes require a `Bearer` token in the `Authorization` header.

```
Authorization: Bearer <token>
```

🔒 = requires Authorization header

---

## Auth

### POST `/api/auth/sign-in`

Sign in a user. `platform` must match the user's `registeredPlatform` — otherwise login is rejected.

**Body**
```json
{
  "email": "user@example.com",
  "password": "password123",
  "platform": "kajabi"
}
```

> `platform` — `"kajabi"` or `"kartra"`

**Response `200`**
```json
{
  "message": "success",
  "data": {
    "token": "<jwt>",
    "user": {
      "id": "abc123",
      "email": "user@example.com",
      "freshSignIn": true,
      "registeredPlatform": "kajabi",
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  }
}
```

> `freshSignIn: true` means the user is on a temporary password. Redirect them to the change-password screen immediately.

**Errors**
| Status | Reason |
|--------|--------|
| `400` | Missing email, password, or platform |
| `401` | Wrong password |
| `403` | Account disabled, or platform mismatch |
| `404` | No account with that email |

---

### POST `/api/auth/forgot-password`

Generates a new temporary password, emails it to the user, and sets `freshSignIn: true`. `platform` must match the user's `registeredPlatform`.

**Body**
```json
{
  "email": "user@example.com",
  "platform": "kajabi"
}
```

**Response `200`**
```json
{
  "message": "success",
  "data": { "message": "A new temporary password has been sent to your email" }
}
```

**Errors**
| Status | Reason |
|--------|--------|
| `400` | Missing email or platform |
| `403` | Platform mismatch |
| `404` | No account with that email |

---

### GET `/api/auth/me` 🔒

Returns the authenticated user's profile.

**Response `200`**
```json
{
  "message": "success",
  "data": {
    "id": "abc123",
    "email": "user@example.com",
    "freshSignIn": false,
    "isActive": true,
    "connectionLimit": 3,
    "registeredPlatform": "kajabi",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z"
  }
}
```

---

### PATCH `/api/auth/me` 🔒

Update the authenticated user's email.

**Body**
```json
{ "email": "newemail@example.com" }
```

**Response `200`**
```json
{
  "message": "success",
  "data": { "id": "abc123", "email": "newemail@example.com", "updatedAt": "..." }
}
```

---

### POST `/api/auth/change-password` 🔒

Change the user's password. Clears `freshSignIn` on success.

**Body**
```json
{
  "currentPassword": "temppassword",
  "newPassword": "mynewpassword"
}
```

**Response `200`**
```json
{
  "message": "success",
  "data": { "id": "abc123", "email": "...", "freshSignIn": false, "updatedAt": "..." }
}
```

**Errors**
| Status | Reason |
|--------|--------|
| `401` | Current password is incorrect |

---

### DELETE `/api/auth/me` 🔒

Permanently delete the authenticated user's account.

**Response `200`**
```json
{ "message": "success", "data": null }
```

---

## Config

### GET `/api/config`

Returns the current app config. No auth required. Use `registeredPlatform` from the user object to pick the correct platform block.

**Response `200`**
```json
{
  "message": "success",
  "data": {
    "googleDrive": {
      "clientId": "...",
      "clientSecret": "..."
    },
    "kajabi": {
      "version": "1.2.0",
      "downloadLink": "https://...",
      "setupLink": "https://...",
      "purchaseLink": "https://...",
      "isMaintenance": false
    },
    "kartra": {
      "version": "1.0.0",
      "downloadLink": "https://...",
      "setupLink": "https://...",
      "purchaseLink": "https://...",
      "isMaintenance": false
    }
  }
}
```

> On app launch, check `data[registeredPlatform].isMaintenance`. If `true`, show a maintenance screen and block usage.

---

### PATCH `/api/config`

Create or update the singleton app config. All fields are optional on update — at least one must be provided. On first-time creation `googleDriveClientId` and `googleDriveClientSecret` are required.

**Body** (all fields optional on update)
```json
{
  "googleDriveClientId": "...",
  "googleDriveClientSecret": "...",

  "kajabiVersion": "1.2.0",
  "kajabiDownloadLink": "https://...",
  "kajabiSetupLink": "https://...",
  "kajabiPurchaseLink": "https://...",
  "kajabiIsMaintenance": false,

  "kartraVersion": "1.0.0",
  "kartraDownloadLink": "https://...",
  "kartraSetupLink": "https://...",
  "kartraPurchaseLink": "https://...",
  "kartraIsMaintenance": false
}
```

**Response `200`** — returns the full updated config document.

**Errors**
| Status | Reason |
|--------|--------|
| `400` | No fields provided, or missing required fields on first-time creation |

---

## Platforms

### GET `/api/platforms` 🔒

Returns the list of supported platforms with scraper metadata.

**Response `200`**
```json
{
  "message": "success",
  "data": [
    {
      "name": "kajabi",
      "scraperName": "kajabi",
      "urlPattern": "^https:\\/\\/app\\.kajabi\\.com\\/admin\\/sites\\/\\d+\\/courses\\/?",
      "accountIdExpression": "window.CLIENT_INFO?.account_id"
    },
    {
      "name": "kartra",
      "scraperName": "kartra",
      "urlPattern": "^https:\\/\\/app\\.kartra\\.com\\/memberships\\/all-memberships",
      "accountIdExpression": "JSON.parse(sessionStorage.getItem(\"pusherAuth\")).memberId"
    }
  ]
}
```

> `urlPattern` — regex to detect which platform tab is active.  
> `accountIdExpression` — JS expression evaluated in the page context to extract the account/member ID.  
> `scraperName` — pass to `GET /api/scrapers/:name` to fetch the scraper script.

---

## Scrapers

### GET `/api/scrapers/:name` 🔒

Returns the raw JavaScript scraper for the given platform.

**Params**
| Param | Value |
|-------|-------|
| `name` | `kajabi` or `kartra` |

**Response `200`** — raw JS string (not JSON)

**Errors**
| Status | Reason |
|--------|--------|
| `404` | Scraper not found |

---

## Platform Connections

### GET `/api/platform-connections` 🔒

Returns all platform connections for the authenticated user.

**Response `200`**
```json
{
  "message": "success",
  "data": [
    {
      "id": "...",
      "platform": "kajabi",
      "lockId": "abc123",
      "userId": "...",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

---

### POST `/api/platform-connections` 🔒

Add a new platform connection. `platform` must match the user's `registeredPlatform`.

**Body**
```json
{
  "platform": "kajabi",
  "lockId": "abc123"
}
```

**Response `201`**
```json
{
  "message": "success",
  "data": {
    "id": "...",
    "platform": "kajabi",
    "lockId": "abc123",
    "userId": "...",
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

**Errors**
| Status | Reason |
|--------|--------|
| `400` | Missing platform or lockId |
| `403` | Connection limit reached, or platform doesn't match `registeredPlatform` |
| `409` | Duplicate platform + lockId for this user |

> On a `403` connection-limit error, the response `data` also includes `connectionLimit` and `currentCount` so you can show a meaningful message.

---

### PATCH `/api/platform-connections/:id` 🔒

Update an existing connection's `platform` or `lockId`. At least one field required.

**Params**
| Param | Description |
|-------|-------------|
| `id` | Connection ID |

**Body**
```json
{
  "platform": "kajabi",
  "lockId": "newlockid"
}
```

**Response `200`**
```json
{
  "message": "success",
  "data": { "id": "...", "platform": "...", "lockId": "...", "updatedAt": "..." }
}
```

**Errors**
| Status | Reason |
|--------|--------|
| `404` | Connection not found (or doesn't belong to this user) |
| `409` | Duplicate platform + lockId for this user |

---

### DELETE `/api/platform-connections/:id` 🔒

Delete a platform connection.

**Params**
| Param | Description |
|-------|-------------|
| `id` | Connection ID |

**Response `200`**
```json
{ "message": "success", "data": null }
```

**Errors**
| Status | Reason |
|--------|--------|
| `404` | Connection not found (or doesn't belong to this user) |

---

## Error Shape

All error responses follow this shape:

```json
{
  "message": "error",
  "data": {
    "message": "Human-readable reason"
  }
}
```

---

## Key Concepts

| Field | Where | Description |
|-------|-------|-------------|
| `registeredPlatform` | User object | Set at invite time (`"kajabi"` or `"kartra"`). Cannot be changed by the user. Determines which config block to read, which platform to pass on sign-in / forgot-password, and which platform connections can be added. |
| `freshSignIn` | User object | `true` when the user is still on a temporary password. Always redirect to change-password screen before allowing any other action. |
| `connectionLimit` | User object | Max number of platform connections. The `403` on `POST /api/platform-connections` includes `connectionLimit` and `currentCount` to display a helpful error. |
| `isMaintenance` | Config `kajabi` / `kartra` | Check `data[registeredPlatform].isMaintenance` from `GET /api/config` on launch. If `true`, show a maintenance screen and block all usage. |
