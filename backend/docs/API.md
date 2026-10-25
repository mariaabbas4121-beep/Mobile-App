# NeighborShare API reference (v1)

This is the contract the mobile app integrates against. Everything here is implemented and covered by tests; anything not listed (phone or identity verification) does not exist yet. Google sign-in has no endpoint here: the app completes it with Supabase Auth and then uses the resulting access token with these endpoints like any other.

- [Conventions](#conventions)
- [Health](#health)
- [Auth](#auth): [signup](#post-apiv1authsignup), [login](#post-apiv1authlogin), [refresh](#post-apiv1authrefresh), [resend confirmation](#post-apiv1authemailresend), [logout](#post-apiv1authlogout), [me](#get-apiv1authme), [status](#get-apiv1authstatus)
- [Profile](#profile): [update](#patch-apiv1profileme)
- [Email confirmation flow](#email-confirmation-flow)
- [Error codes](#error-codes)
- [Rate limits](#rate-limits)

## Conventions

**Base URL:** `http://<host>:4000/api/v1` locally. All bodies are JSON (`Content-Type: application/json`), at most 100 kB.

**Success envelope:** `{ "success": true, "data": { ... } }`. `204` responses have no body.

**Error envelope:** every error, including 404 and 500, has this shape:

```json
{
  "success": false,
  "code": "VALIDATION_ERROR",
  "message": "Request validation failed",
  "requestId": "6c1f0e0a-3a5e-4c7e-9f1d-2b9d6f0f6a11",
  "details": [{ "field": "password", "message": "must be at least 8 characters" }]
}
```

- Branch on `code`, never on `message`; messages may be reworded.
- `details` appears only on some errors (validation, weak password).
- `requestId` matches the `X-Request-Id` response header and the server log line; quote it when reporting a problem.
- Responses never contain stack traces, raw Supabase errors, or submitted values such as passwords.

**Authentication:** protected endpoints need `Authorization: Bearer <accessToken>`, using the `accessToken` from login or refresh. The token is checked with Supabase Auth on every request, so a token stops working as soon as its session is logged out, even before it expires.

| Situation | Status | `code` | `WWW-Authenticate` |
| --- | --- | --- | --- |
| No `Authorization` header | 401 | `UNAUTHENTICATED` | `Bearer` |
| Malformed, expired, revoked or forged token | 401 | `INVALID_TOKEN` | `Bearer error="invalid_token"` |
| Valid token, but not allowed (account status, role) | 403 | see [error codes](#error-codes) | none |

On `INVALID_TOKEN`, call [refresh](#post-apiv1authrefresh) once; if that also fails, send the user to sign in.

**Identity comes only from the token.** User ids in bodies, query strings or headers are ignored. Unknown body fields are stripped on auth endpoints and rejected on the profile endpoint.

**Headers on every response:** `X-Request-Id`, `Cache-Control: no-store`, and Helmet's security headers. Rate-limited endpoints add `RateLimit` and `RateLimit-Policy`, plus `Retry-After` on 429.

**Timestamps** are ISO 8601 strings in UTC. `expiresAt` in a session is Unix seconds.

### Shared objects

**User**

```json
{
  "id": "0b8e7f7e-6f3c-4c51-9a63-0d6c6a2f0f11",
  "email": "sara@example.com",
  "emailConfirmedAt": "2026-10-20T10:00:00Z",
  "createdAt": "2026-10-20T09:58:12Z",
  "lastSignInAt": "2026-10-20T10:05:00Z",
  "providers": ["email"]
}
```

**Session**

```json
{
  "accessToken": "eyJ...",
  "refreshToken": "v1.Mr...",
  "tokenType": "bearer",
  "expiresIn": 3600,
  "expiresAt": 1792491900
}
```

Store the refresh token in the device's secure storage (Keychain or Keystore via `expo-secure-store`), never in AsyncStorage. Refresh tokens rotate: each refresh returns a new one, and the old one stops working.

**Profile**

```json
{
  "id": "0b8e7f7e-6f3c-4c51-9a63-0d6c6a2f0f11",
  "displayName": "Sara",
  "city": "Lahore",
  "neighborhood": "Gulberg",
  "bio": null,
  "avatarPath": null,
  "phoneVerifiedAt": null,
  "profileCompletedAt": "2026-10-20T11:00:00Z",
  "accountStatus": "active",
  "createdAt": "2026-10-20T09:58:12Z",
  "updatedAt": "2026-10-20T11:00:00Z"
}
```

`accountStatus` is one of `active`, `restricted`, `suspended`, `deletion_pending`. `profileCompletedAt` is set by the database once `displayName`, `city` and `neighborhood` are all filled in, and cleared if one is removed. `avatarPath` cannot be set yet (it arrives with file uploads).

## Health

### `GET /api/v1/health`

Liveness check. It does not contact Supabase. Also served at `/health`.

`200` → `{ "success": true, "data": { "status": "ok" } }`

## Auth

### `POST /api/v1/auth/signup`

Creates an account with Supabase Auth. The database creates the profile and verification records in the same transaction.

**Body**

| Field | Rules |
| --- | --- |
| `email` | Required. Valid address, at most 254 characters. Trimmed and lower-cased. |
| `password` | Required. 8+ characters, at least one letter and one digit, at most 72 bytes. |
| `displayName` | Optional. 2–50 characters after trimming. |

**Responses**

- `202`: email confirmation is required (the normal case). The **same response is returned whether or not the email already has an account**, so the endpoint cannot be used to discover registered addresses:

  ```json
  {
    "success": true,
    "data": {
      "emailConfirmationRequired": true,
      "message": "If this email address can be registered, a confirmation link has been sent to it. Confirm it, then sign in."
    }
  }
  ```

- `201`: only if email confirmation is turned off in Supabase: `{ "emailConfirmationRequired": false, "user": User, "session": Session }`.

**Errors:** `400 VALIDATION_ERROR`, `400 INVALID_EMAIL` (Supabase refused the address), `422 WEAK_PASSWORD` (`details.reasons`), `403 SIGNUP_DISABLED`, `409 EMAIL_ALREADY_REGISTERED` (only when confirmation is off), `429 RATE_LIMITED`, `503 EMAIL_DELIVERY_UNAVAILABLE`, `503 AUTH_UNAVAILABLE`.

### `POST /api/v1/auth/login`

**Body:** `email` (required, normalised as above), `password` (required, 1–1024 characters). Login does not apply the signup password policy, so policy changes never lock out existing accounts.

**`200`** → `{ "user": User, "session": Session }`

**Errors**

| Status | `code` | Meaning |
| --- | --- | --- |
| 401 | `INVALID_CREDENTIALS` | Wrong password **or** unknown email (deliberately indistinguishable) |
| 403 | `EMAIL_NOT_CONFIRMED` | Correct credentials, email not confirmed yet; offer [resend](#post-apiv1authemailresend) |
| 403 | `ACCOUNT_BLOCKED` | Banned in Supabase Auth |
| 400 | `VALIDATION_ERROR` | Missing or malformed fields |
| 429 | `RATE_LIMITED` | Too many attempts |
| 503 | `AUTH_UNAVAILABLE` | Supabase unreachable or slow |

Suspended accounts can still log in, so the app can show them their status through [`/status`](#get-apiv1authstatus). Feature endpoints refuse them.

### `POST /api/v1/auth/refresh`

**Body:** `{ "refreshToken": "..." }` (1–2048 characters).

**`200`** → `{ "user": User, "session": Session }` with a new access token **and a new refresh token**. Replace both.

**Errors:** `401 INVALID_REFRESH_TOKEN` (unknown, already used, expired, or its session was logged out; send the user to sign in), `400 VALIDATION_ERROR`, `429 RATE_LIMITED`, `503 AUTH_UNAVAILABLE`.

### `POST /api/v1/auth/email/resend`

Resends the signup confirmation email.

**Body:** `{ "email": "..." }`

**`202`** → `{ "message": "If this email address can be registered, ..." }` (same text as signup), whether or not the address exists or is already confirmed.

**Errors:** only `400 VALIDATION_ERROR`, `429 RATE_LIMITED` and `503` (`AUTH_UNAVAILABLE` or `EMAIL_DELIVERY_UNAVAILABLE`) are reported.

### `POST /api/v1/auth/logout`

**Auth required.**

**Body (optional):** `{ "scope": "local" | "global" | "others" }`, default `local`.

| Scope | Ends |
| --- | --- |
| `local` | This session |
| `global` | Every session of the user, on every device |
| `others` | Every session except this one |

**`204`**, no body. Afterwards the access token is rejected (`401 INVALID_TOKEN`) and the refresh token cannot be used. Calling logout again with the same token therefore returns `401`.

**Errors:** `401`, `400 VALIDATION_ERROR` (unknown scope), `503 AUTH_UNAVAILABLE`.

### `GET /api/v1/auth/me`

**Auth required.** Works for any account status.

**`200`** → `{ "user": User, "profile": Profile }`

**Errors:** `401`, `503 DATABASE_UNAVAILABLE`, `503 AUTH_UNAVAILABLE`, `500 PROFILE_MISSING` (should not happen: profiles are created with the account).

### `GET /api/v1/auth/status`

**Auth required.** Works for any account status. The server derives this from its own records; nothing in it can be set by the client.

**`200`**

```json
{
  "success": true,
  "data": {
    "accountStatus": "active",
    "stage": "email_verified",
    "nextStep": "phone_verified",
    "milestones": {
      "email_verified": true,
      "phone_verified": false,
      "profile_complete": true,
      "identity_verified": false
    },
    "verifications": {
      "email":    { "status": "verified",    "verifiedAt": "2026-10-20T10:00:00Z", "expiresAt": null },
      "phone":    { "status": "not_started", "verifiedAt": null, "expiresAt": null },
      "identity": { "status": "not_started", "verifiedAt": null, "expiresAt": null }
    },
    "profile": { "complete": true, "completedAt": "2026-10-20T11:00:00Z", "missingFields": [] }
  }
}
```

- **`milestones`** are independent: a user can complete their profile before verifying their phone.
- **`stage`** is the last milestone reached in order (`email_verified` → `phone_verified` → `profile_complete` → `identity_verified`). It is `registered` if none are reached and `active` if all are. **`nextStep`** is the first one missing, or `null`.
- **Verification `status`** is one of `not_started`, `pending`, `verified`, `rejected`, `expired`, `revoked`. A `verified` result past its `expiresAt` is reported as `expired`.
- **`accountStatus` is separate from `stage`.** A suspended user can be at any stage.
- **`missingFields`** uses API field names: `displayName`, `city`, `neighborhood`.

Phone and identity verification have no provider yet, so for now they always report `not_started`.

## Profile

### `PATCH /api/v1/profile/me`

**Auth required.** Account status must be `active` or `restricted`.

**Body:** any of the fields below; at least one is required. Send `null` to clear a field. **Any other field is rejected with `400`**, including `accountStatus`, phone and verification fields, and `id`.

| Field | Rules |
| --- | --- |
| `displayName` | 2–50 characters after trimming, or `null` |
| `city` | 2–80 characters after trimming, or `null` |
| `neighborhood` | 2–80 characters after trimming, or `null` |
| `bio` | 1–500 characters after trimming, or `null` |

Blank strings and control characters are rejected.

**`200`** → `{ "profile": Profile }` (the updated profile, including the recalculated `profileCompletedAt`).

**Errors:** `400 VALIDATION_ERROR`, `400 INVALID_PROFILE`, `401`, `403 ACCOUNT_SUSPENDED`, `403 ACCOUNT_DELETION_PENDING`, `403 FORBIDDEN` (status changed during the request), `503 DATABASE_UNAVAILABLE`.

The database enforces the same rules independently: users can write only these four columns, only on their own row, and only while active or restricted.

## Email confirmation flow

1. The app calls `POST /auth/signup` and shows the `202` message.
2. Supabase emails a confirmation link. When the user opens it, Supabase confirms the address and redirects to `AUTH_EMAIL_REDIRECT_URL`, or to the project's Site URL if that is unset.
3. A database trigger marks the email verification as `verified` at the same moment.
4. The user signs in with `POST /auth/login`. Before confirmation, login returns `403 EMAIL_NOT_CONFIRMED`.

The API has no endpoint for step 2: Supabase handles the link itself. How the mobile app reacts to the redirect (a deep link that opens the sign-in screen) will be designed during frontend integration.

## Error codes

| Status | `code` | Where |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Any endpoint with a body; `details` lists `{ field, message }` |
| 400 | `INVALID_JSON` | Body is not valid JSON |
| 400 | `BAD_REQUEST` | Other malformed requests |
| 400 | `INVALID_EMAIL` | Signup: Supabase refused the address |
| 400 | `INVALID_PROFILE` | Profile: a database constraint refused a value |
| 401 | `UNAUTHENTICATED` | No `Authorization` header |
| 401 | `INVALID_TOKEN` | Bad, expired or revoked access token |
| 401 | `INVALID_CREDENTIALS` | Login |
| 401 | `INVALID_REFRESH_TOKEN` | Refresh |
| 403 | `EMAIL_NOT_CONFIRMED` | Login |
| 403 | `ACCOUNT_BLOCKED` | Login: user banned in Supabase Auth |
| 403 | `ACCOUNT_SUSPENDED` | Status-guarded routes |
| 403 | `ACCOUNT_DELETION_PENDING` | Status-guarded routes |
| 403 | `ACCOUNT_RESTRICTED` | Status-guarded routes that exclude restricted accounts (none yet) |
| 403 | `SIGNUP_DISABLED` | Signup turned off in Supabase |
| 403 | `FORBIDDEN` | Not permitted (e.g. missing role) |
| 404 | `ROUTE_NOT_FOUND` | Unknown path or method |
| 409 | `EMAIL_ALREADY_REGISTERED` | Signup, only if email confirmation is disabled |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 100 kB |
| 422 | `WEAK_PASSWORD` | Signup: Supabase's password check failed; `details.reasons` |
| 429 | `RATE_LIMITED` | This API's limits or Supabase's own; see `Retry-After` |
| 500 | `INTERNAL_ERROR` | Unexpected server error (logged with the `requestId`) |
| 500 | `PROFILE_MISSING` | Account exists without a profile (should not happen) |
| 502 | `AUTH_PROVIDER_ERROR` | Supabase returned an error the API does not recognise |
| 503 | `AUTH_UNAVAILABLE` | Supabase Auth unreachable, failing, or slower than 12 s |
| 503 | `DATABASE_UNAVAILABLE` | Database query failed |
| 503 | `EMAIL_DELIVERY_UNAVAILABLE` | Supabase cannot send email (custom SMTP not configured) |
| 503 | `SERVER_NOT_CONFIGURED` | A server-side feature lacks its configuration |

## Rate limits

Limits are per API process. Several instances behind a load balancer need a shared store (e.g. Redis) for these to hold.

| Endpoint | Limit | Key |
| --- | --- | --- |
| `POST /auth/signup` | 10 / hour | Client IP |
| `POST /auth/login` | 30 / 15 min | Client IP |
| `POST /auth/login` | 5 **failed** / 15 min | Account (email), across all IPs |
| `POST /auth/refresh` | 60 / 15 min | Client IP |
| `POST /auth/email/resend` | 10 / hour | Client IP |
| `POST /auth/email/resend` | 3 / hour | Account (email) |

IPv6 clients are grouped by /56. Behind a reverse proxy, set `TRUST_PROXY_HOPS` so the real client IP is used. Supabase applies its own limits as well (notably on sending email); those also surface as `429 RATE_LIMITED`.
