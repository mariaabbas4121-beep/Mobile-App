# NeighborShare API reference (v1)

This is the contract the mobile app integrates against. Everything here is implemented and covered by tests; anything not listed (identity verification) does not exist yet. Google sign-in has no endpoint here: the app completes it with Supabase Auth and then uses the resulting access token with these endpoints like any other.

- [Conventions](#conventions)
- [Health](#health)
- [Auth](#auth): [signup](#post-apiv1authsignup), [login](#post-apiv1authlogin), [refresh](#post-apiv1authrefresh), [resend confirmation](#post-apiv1authemailresend), [logout](#post-apiv1authlogout), [me](#get-apiv1authme), [status](#get-apiv1authstatus)
- [Profile](#profile): [update](#patch-apiv1profileme)
- [Phone verification](#phone-verification): [status](#get-apiv1verificationphone), [start](#post-apiv1verificationphonestart), [resend](#post-apiv1verificationphoneresend), [confirm](#post-apiv1verificationphoneconfirm)
- [Listings](#listings): [list](#get-apiv1items), [get](#get-apiv1itemsid), [create](#post-apiv1items), [update](#patch-apiv1itemsid), [archive](#delete-apiv1itemsid), [add photo](#post-apiv1itemsidimages), [remove photo](#delete-apiv1itemsidimagesimageid), [nearby search and pickup spots](#nearby-discovery-and-pickup-locations)
- [Borrow requests](#borrow-requests): [create](#post-apiv1borrow-requests), [lists](#get-apiv1borrow-requestsoutgoing-and-incoming), [get](#get-apiv1borrow-requestsid), [accept · decline · cancel](#post-apiv1borrow-requestsidaccept--decline--cancel), [booked dates](#get-apiv1itemsidbooked-dates)
- [Chat](#chat): [list](#get-apiv1conversations), [open](#post-apiv1conversations), [get](#get-apiv1conversationsid), [history](#get-apiv1conversationsidmessages), [send](#post-apiv1conversationsidmessages), [mark read](#post-apiv1conversationsidread), [Socket.IO events](#socketio), [two-device test](#testing-chat-with-two-accounts), [limitations](#known-limitations)
- [Pickup and handover](#pickup-and-handover): [state](#get-apiv1borrow-requestsidhandover), [authorize](#post-apiv1borrow-requestsidpickup-authorizations), [revoke](#post-apiv1borrow-requestsidpickup-authorizationsauthorizationidrevoke), [verify](#post-apiv1borrow-requestsidhandoververify), [confirm](#post-apiv1borrow-requestsidhandover), [photos](#post-apiv1borrow-requestsidhandoverphotos)
- [Returns and due dates](#returns-and-due-dates): [state](#get-apiv1borrow-requestsidreturn), [start](#post-apiv1borrow-requestsidreturn), [authorize](#post-apiv1borrow-requestsidreturn-authorizations), [verify](#post-apiv1borrow-requestsidreturnverify), [confirm](#post-apiv1borrow-requestsidreturnconfirm), [photos](#post-apiv1borrow-requestsidreturnphotos), [extensions](#post-apiv1borrow-requestsidextensions)
- [Activity](#activity): [recent activity](#get-apiv1activity)
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

Phone verification is reported from the server's records once the [phone verification](#phone-verification) flow completes. Identity verification has no provider yet and always reports `not_started`.

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

## Phone verification

An **extra verification step on an existing, signed-in account**. It is not a sign-in method and does not replace email/password or Google. Supabase Auth's phone-change flow sends and checks the code; the API never generates, stores or logs an OTP.

How a number becomes `verified`:

1. `start`: the API asks Supabase Auth, **with the caller's own access token**, to change that user's phone. Supabase texts a code to the new number and records it as a pending change on that user only.
2. `confirm`: the API checks that Supabase is waiting for exactly this number **for this user**, then has Supabase verify the code. Supabase signs the user in as a side effect; the API revokes that extra session immediately and never returns it.
3. The API reads the user from Supabase Auth again with the caller's token. Only if it is the same user, with this number as their phone and a `phone_confirmed_at`, does the server record `verified`, and only for a number a code was requested for through this API.

Nothing the client sends (a status, a `verified` flag, a user id) can set the result: unknown fields are rejected with `400`, and the database lets only the server write these records.

**`PhoneVerification` object** (numbers are masked; the API never returns the full number):

```json
{
  "status": "pending",
  "verifiedAt": null,
  "phone": null,
  "pendingPhone": "+92••••••4567",
  "resendAvailableAt": "2026-10-26T12:01:00.000Z",
  "codeLength": 6
}
```

| Field | Meaning |
| --- | --- |
| `status` | `not_started`, `pending`, `verified`, `rejected`, `expired` or `revoked` |
| `verifiedAt` | When Supabase confirmed the number; only while `verified` |
| `phone` | The verified number, masked; only while `verified` |
| `pendingPhone` | The number a code was last requested for, masked, or `null` |
| `resendAvailableAt` | Earliest time the API will send another code, or `null` if it would now |
| `codeLength` | Digits in the SMS code (`PHONE_OTP_LENGTH`; must match Supabase) |

**Status transitions**

| Event | Result |
| --- | --- |
| Code requested, number not yet verified | `not_started` / `rejected` / `expired` / `revoked` → `pending` |
| Code requested while another number is verified | Stays `verified` with the old number; `pendingPhone` set. The old number stays verified until the new one is confirmed (Supabase also keeps it until then) |
| Correct code | → `verified` with the new number; `pendingPhone` cleared |
| Wrong, expired or reused code | No change (an audit event is written) |
| Supabase no longer reports the verified number as this user's confirmed phone (e.g. changed directly in Supabase) | `verified` → `revoked` on the next `GET /verification/phone` |
| Another account later verifies the same number (Supabase allows a number on one user at a time) | The stale claim on the other account becomes `revoked` |

Account status: start, resend and confirm need `active` or `restricted` (same rule as profile edits). Reading the status works for any account status. Phone verification is **not required** to use the app.

### `GET /api/v1/verification/phone`

**Auth required.** **`200`** → `{ "verification": PhoneVerification }`

**Errors:** `401`, `503 AUTH_UNAVAILABLE`, `503 DATABASE_UNAVAILABLE`, `503 SERVER_NOT_CONFIGURED` (no `SUPABASE_SECRET_KEY`).

### `POST /api/v1/verification/phone/start`

**Auth required.** Account must be `active` or `restricted`.

**Body:** `{ "phone": "+923001234567" }`, an international number. Spaces, dashes, dots, brackets and a leading `00` are accepted and normalised to E.164 (`+`, country code, 8–15 digits in total). No other fields are allowed.

**Responses**

- `202`: Supabase accepted the request. **This does not prove the SMS was delivered**:

  ```json
  {
    "success": true,
    "data": {
      "codeSent": true,
      "message": "If this number can receive text messages, a verification code is on its way.",
      "verification": { "status": "pending", "pendingPhone": "+92••••••4567", "resendAvailableAt": "…", "codeLength": 6, "verifiedAt": null, "phone": null }
    }
  }
  ```

  A number that belongs to **another account** gets this same `202` response (no SMS is sent, and confirming fails like a wrong code), so the endpoint cannot be used to find out who owns a number.

- `200`: `{ "codeSent": false, "verification": { "status": "verified", … } }`. The number is already verified on this account; nothing is sent.

**Errors**

| Status | `code` | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Malformed number, or extra fields |
| 400 | `INVALID_PHONE` | Supabase refused the number |
| 400 | `PHONE_COUNTRY_NOT_SUPPORTED` | Outside `PHONE_ALLOWED_COUNTRY_CODES` |
| 403 | `ACCOUNT_SUSPENDED`, `ACCOUNT_DELETION_PENDING` | Account status |
| 409 | `PHONE_ALREADY_ON_ACCOUNT` | Supabase already has this number confirmed on this account, but it was never requested through this API (e.g. set directly in Supabase). Use another number or contact support |
| 429 | `RATE_LIMITED` | Hourly limits, Supabase's SMS limit, or the resend cooldown (`details.reason: "resend_cooldown"`); see `Retry-After` |
| 502 | `AUTH_PROVIDER_ERROR` | Supabase answered in an unexpected way |
| 503 | `PHONE_VERIFICATION_NOT_CONFIGURED` | A setup problem; retrying will not help. `details.reason` is `phone_provider_disabled` (Phone provider off in Supabase), `phone_confirmations_disabled` (numbers would be accepted without a code, so the API refuses) or `database_migration_missing` (phone verification migration not applied). Also returned by `GET /verification/phone` for a missing migration |
| 503 | `SMS_DELIVERY_UNAVAILABLE` | Supabase or its SMS provider could not send. The user can retry at once |
| 503 | `AUTH_UNAVAILABLE`, `DATABASE_UNAVAILABLE`, `SERVER_NOT_CONFIGURED` | Outages or missing server configuration |

### `POST /api/v1/verification/phone/resend`

**Auth required.** Account must be `active` or `restricted`. **Body:** none, or `{}`. Sends a new code to the pending number; it never accepts a different number (use `start` for that).

**Responses and errors:** as for `start`, plus `409 NO_PENDING_PHONE_VERIFICATION` when no code has been requested.

### `POST /api/v1/verification/phone/confirm`

**Auth required.** Account must be `active` or `restricted`.

**Body:** `{ "phone": "+923001234567", "code": "123456" }`. `phone` is the number the code was requested for (same normalisation as `start`); `code` is 6–10 digits.

**`200`** → `{ "verification": PhoneVerification }` with `status: "verified"`. Repeating a confirmation that already succeeded returns the same `200` without contacting Supabase.

**Errors**

| Status | `code` | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Malformed number or code, or extra fields |
| 400 | `OTP_INVALID_OR_EXPIRED` | Wrong, expired or already used code. Supabase does not distinguish these. The status does not change |
| 409 | `NO_PENDING_PHONE_VERIFICATION` | No code was requested for this number on this account (or it was replaced by a newer request) |
| 403 | `ACCOUNT_SUSPENDED`, `ACCOUNT_DELETION_PENDING` | Account status |
| 429 | `RATE_LIMITED` | Too many attempts (per IP and per account), or Supabase's verification limit |
| 502 | `AUTH_PROVIDER_ERROR` | Supabase accepted the code but did not then report the number as confirmed; nothing is recorded |
| 503 | `AUTH_UNAVAILABLE`, `DATABASE_UNAVAILABLE`, `SERVER_NOT_CONFIGURED` | Outages. If Supabase accepted the code but the database write failed, retrying `confirm` (any code) completes it from Supabase's record |

**Codes expire quickly.** On the hosted Supabase project the SMS code is valid for 60 seconds by default (Authentication → Providers → Phone → SMS OTP Expiry). Apps should let the user resend once `resendAvailableAt` has passed.

### Requiring phone verification later

Nothing requires a verified phone today. To require it for a high-trust action (for example creating a listing or requesting an item), add a guard after `requireAuth` that reads the caller's phone record and refuses with `403` unless `status` is `verified`, and document the new error code here. That policy has not been decided, so no guard exists.

## Listings

Items users offer to lend. Reads are public; writes need a token and act only on the caller's own listings. Every database and Storage call runs **with the caller's token** (or anonymously for public reads), so Row-Level Security enforces the same ownership rules a second time; the secret key is not used. Borrow requests and reservations are not part of this API yet (Phase 2B).

**Listing object**

```json
{
  "id": "5d0c6f8e-2a7b-4f39-9f0a-3c1e2b4d6a10",
  "owner": { "id": "0b8e7f7e-6f3c-4c51-9a63-0d6c6a2f0f11", "displayName": "Sara" },
  "title": "Bosch power drill",
  "description": "Cordless drill with two batteries and a set of bits.",
  "category": "tools",
  "condition": "good",
  "replacementValuePkr": 15000,
  "borrowingTerms": "Return within 3 days",
  "area": "UAF Hostel 3",
  "city": "Faisalabad",
  "approximateLocation": { "latitude": 31.441, "longitude": 73.071 },
  "distanceKm": null,
  "availability": "available",
  "teachMeEnabled": false,
  "tags": ["DIY", "Home"],
  "archivedAt": null,
  "createdAt": "2026-10-28T10:00:00.000Z",
  "updatedAt": "2026-10-28T10:00:00.000Z",
  "images": [
    { "id": "c2f…", "url": "https://<project>.supabase.co/storage/v1/object/sign/listing-images/…?token=…", "contentType": "image/jpeg", "createdAt": "…" }
  ]
}
```

- The owner appears as id and display name only. No email, phone, city, bio or address is ever returned.
- `category`: `tools`, `electronics`, `home`, `outdoor`, `kitchen`, `sports`, `books`, `other`. `condition`: `excellent`, `good`, `fair`. `availability`: `available`, `unavailable`.
- `area` is an approximate place the owner typed (2–80 characters), never coordinates.
- `replacementValuePkr` is an indicative value in whole rupees (0–10,000,000), informational only.
- `images[].url` is a **signed URL valid for one hour**; reload the listing for fresh ones. It is `null` if Storage could not sign it.

**Body fields (create and update)**

| Field | Rules |
| --- | --- |
| `title` | Required on create; 3–80 characters after trimming |
| `description` | Required on create; 10–2000 characters |
| `category`, `condition` | Required on create; one of the values above |
| `replacementValuePkr` | Optional integer 0–10,000,000, or `null` |
| `borrowingTerms` | Optional, up to 1000 characters; blank or `null` clears it |
| `area` | Optional, 2–80 characters; blank or `null` clears it |
| `availability` | Optional; default `available` |
| `teachMeEnabled` | Optional boolean; default `false` |
| `tags` | Optional array of up to 5 strings of 1–24 characters; duplicates differing only in case are merged |

Unknown fields, including `ownerId`, `id` and `archivedAt`, are rejected with `400 VALIDATION_ERROR`. The owner is always the caller.

### `GET /api/v1/items`

Public. A token is optional; if an `Authorization` header is sent it must be valid (`401` otherwise).

| Query | Meaning |
| --- | --- |
| `q` | Up to 100 characters. Every word must appear (case-insensitive) in the title, description or tags |
| `category`, `condition`, `availability` | Exact filters |
| `owner=me` | Only the caller's own listings (token required) |
| `owner=others` | Everyone else's listings: the caller's own are left out, in every kind of search (nearby, city, words, filters) and in `total` and pagination. Who "the caller" is comes from the token only. Without a token nothing is excluded. Used by the app's Browse feed and map. Needs migration `20261105120000_browse_exclude_owner.sql` |
| `includeArchived=true` | With `owner=me`: include the caller's archived listings |
| `sort` | `newest` (default), `oldest`, `title`; `distance` for nearby searches (see [nearby discovery](#nearby-discovery-and-pickup-locations)) |
| `lat`, `lng`, `radiusKm`, `city` | Nearby or city-wide discovery, see below |
| `page`, `pageSize` | Default 1 and 20; `pageSize` at most 50 |

`200`:

```json
{ "success": true, "data": { "items": [ { "…": "listing" } ], "pagination": { "page": 1, "pageSize": 20, "total": 42, "totalPages": 3 } } }
```

Archived listings, and listings of suspended or deletion-pending accounts, never appear in public results.

### `GET /api/v1/items/:id`

Public, token optional. `200 { "data": { "listing": { … } } }`. `404 LISTING_NOT_FOUND` if it does not exist or is archived (an archived listing is still returned to its owner). `400 VALIDATION_ERROR` if `:id` is not a UUID.

### `POST /api/v1/items`

Token required; account must be `active`.

```json
{ "title": "Bosch power drill", "description": "Cordless drill with two batteries.", "category": "tools", "condition": "good", "area": "UAF Hostel 3", "tags": ["DIY"] }
```

`201 { "data": { "listing": { … } } }`. Errors: `400 VALIDATION_ERROR`, `401`, `403 ACCOUNT_RESTRICTED` / `ACCOUNT_SUSPENDED` / `ACCOUNT_DELETION_PENDING`, `429 RATE_LIMITED`.

### `PATCH /api/v1/items/:id`

Token required; owner only. Any subset of the body fields (at least one).

```json
{ "availability": "unavailable" }
```

`200 { "data": { "listing": { … } } }`. Restricted accounts may change only `availability` (`403 ACCOUNT_RESTRICTED` otherwise). Errors: `403 FORBIDDEN` (not the owner), `404 LISTING_NOT_FOUND`, `409 LISTING_ARCHIVED`.

### `DELETE /api/v1/items/:id`

Token required; owner only; account `active` or `restricted`. **Archives** the listing: it disappears from discovery, the owner can still read it, and it cannot be edited or restored. Repeating the call is harmless. `200 { "data": { "listing": { …, "archivedAt": "…" } } }`. Errors: `403 FORBIDDEN`, `404 LISTING_NOT_FOUND`. Photos of archived listings are kept, for later borrow history.

### `POST /api/v1/items/:id/images`

Token required; owner only; account `active`. The request body **is the image file** (not multipart, not JSON), with `Content-Type` `image/jpeg`, `image/png` or `image/webp`, at most **5 MB**. The server checks that the file's first bytes match the declared type, chooses the storage path itself (`<owner id>/<listing id>/<random id>.<ext>` in the private `listing-images` bucket), and allows at most **5 photos** per listing.

`201 { "data": { "image": { "id": "…", "url": "…", "contentType": "image/jpeg", "createdAt": "…" } } }`. Errors: `415 UNSUPPORTED_IMAGE_TYPE`, `400 EMPTY_IMAGE`, `413 PAYLOAD_TOO_LARGE`, `403 FORBIDDEN`, `404 LISTING_NOT_FOUND`, `409 LISTING_ARCHIVED`, `409 IMAGE_LIMIT_REACHED`, `503 STORAGE_NOT_CONFIGURED` / `STORAGE_UNAVAILABLE`.

Postman: Body → *binary* → choose the file, and set the `Content-Type` header to the image type.

### `DELETE /api/v1/items/:id/images/:imageId`

Token required; owner only. Removes the photo record and its file. `204`. Errors: `403 FORBIDDEN`, `404 LISTING_NOT_FOUND` / `IMAGE_NOT_FOUND`. If deleting the file itself fails, the photo is still gone from the listing and the orphaned file is logged.

### Nearby discovery and pickup locations

Listings can carry a **pickup spot**: where the owner is happy to hand the item over. It is optional; it is set only when the owner chooses one in the lend form, and it never follows the owner around.

**What others see.** Nobody but the owner ever receives the precise spot. Everyone else gets `approximateLocation`: the spot moved 200–400 m in a direction that is random, secret and fixed per owner, then rounded to 3 decimals (about 110 m). Treat it as "about 0.5 km from the real spot".

**Distances.** `distanceKm` and the radius filter are computed from `approximateLocation`, not from the precise spot. The search accepts any coordinates and any radius, so measuring from the precise spot would let someone pin it down by searching from a few places or shrinking the radius. As a result, distances are approximate (about ±0.5 km) and are shown as "About 1.2 km away".

**Listings without a pickup spot** never appear in nearby results, because their distance is unknown. They still appear in city-wide browsing (`city=`) and in unrestricted browsing, and the app labels them "no map spot".

Nearby search on `GET /api/v1/items`:

| Query | Meaning |
| --- | --- |
| `lat`, `lng` | Search origin, sent together. `lat` −90..90, `lng` −180..180. An empty value counts as absent |
| `radiusKm` | 0.5–50, default 3. Only with `lat`/`lng` |
| `city` | City-wide, case-insensitive. Not combined with `lat`/`lng` |
| `sort` | Defaults to `distance` (nearest first) when `lat`/`lng` are sent; `distance` without them is refused |

All the usual filters (`q`, `category`, `condition`, `availability`) and pagination still apply. Only listings whose `approximateLocation` lies within `radiusKm` are returned; a listing in another city is never "nearby". The response adds `scope`, so the app can label the results:

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "5d0c6f8e-…",
        "title": "Bosch power drill",
        "area": "UAF Hostel 3",
        "city": "Faisalabad",
        "approximateLocation": { "latitude": 31.441, "longitude": 73.071 },
        "distanceKm": 1.2,
        "…": "other listing fields"
      }
    ],
    "pagination": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 },
    "scope": { "mode": "nearby", "radiusKm": 3 }
  }
}
```

`scope` is `{ "mode": "nearby", "radiusKm": n }`, `{ "mode": "city", "city": "…" }` or `{ "mode": "all" }`. Errors: `400 VALIDATION_ERROR`, with `details` naming `lat`, `lng`, `radiusKm`, `city` or `sort`.

### `GET /api/v1/items/:id/location`

Token required; owner only (`403` otherwise). The precise pickup spot, for the edit form: `200 { "data": { "location": { "latitude": 31.4312, "longitude": 73.0746, "updatedAt": "…" } } }`, or `"location": null` when none is set.

### `PUT /api/v1/items/:id/location`

Token required; owner only; account `active`; listing not archived. Body (strict): `{ "latitude": 31.4312, "longitude": 73.0746 }`. `200 { "data": { "location": { … }, "listing": { …, "approximateLocation": { … } } } }`. Errors: `400 VALIDATION_ERROR` / `INVALID_LOCATION`, `403`, `404 LISTING_NOT_FOUND`, `409 LISTING_ARCHIVED`, `429 RATE_LIMITED`. Editing other listing fields never moves the spot.

### `DELETE /api/v1/items/:id/location`

Token required; owner only; listing not archived. Removes the spot; the listing then appears only city-wide. `204`.

## Borrow requests

A borrower asks to borrow a listing for a range of dates; the listing's owner (the lender) accepts or declines; the borrower can cancel while the request is pending. Payments, deposits, handover, chat and reviews are not part of this phase. Chat will only open after a request is accepted.

**Lifecycle**

| From | To | Who | Endpoint |
| --- | --- | --- | --- |
| (new) | `pending` | borrower | `POST /borrow-requests` |
| `pending` | `accepted` | lender (account `active`) | `POST /borrow-requests/:id/accept` |
| `pending` | `declined` | lender (`active` or `restricted`); also automatic when the listing is archived | `POST /borrow-requests/:id/decline` |
| `pending` | `cancelled` | borrower (`active` or `restricted`) | `POST /borrow-requests/:id/cancel` |

`accepted`, `declined` and `cancelled` are final. Anything else is `409 INVALID_STATUS_TRANSITION`.

**Dates.** `startDate` and `endDate` are calendar dates (`YYYY-MM-DD`) in **Pakistan time**, and **both are included**: `2026-11-12`..`2026-11-14` is 3 days. Same-day borrowing is allowed (`endDate` equal to `startDate` = 1 day). The start must be today or later and at most 90 days ahead, and a request covers at most 30 days.

**Reservations.** An accepted request reserves its dates. Two accepted requests for the same listing can never share a day: a borrow ending on the 14th and one starting on the 14th conflict, one starting on the 15th does not. This is enforced by a PostgreSQL exclusion constraint, so it holds even when two accepts arrive at the same moment; the second gets `409 DATES_UNAVAILABLE` and stays `pending`. Pending requests do not reserve anything, so several people can ask for the same days and the lender picks one.

**Borrow request object**

```json
{
  "id": "8c0f6d5e-2b1a-4e3f-9a7b-1c2d3e4f5a6b",
  "status": "pending",
  "startDate": "2026-11-12",
  "endDate": "2026-11-14",
  "days": 3,
  "message": "Need it for a weekend trip",
  "listing": { "id": "5d0c6f8e-…", "title": "Camping tent", "archived": false, "imageUrl": "https://…signed…" },
  "borrower": { "id": "0b8e7f7e-…", "displayName": "Sara" },
  "lender": { "id": "bb64fa7b-…", "displayName": "Rehman" },
  "viewerRole": "borrower",
  "createdAt": "2026-11-10T08:00:00.000Z",
  "updatedAt": "2026-11-10T08:00:00.000Z",
  "decidedAt": null,
  "cancelledAt": null
}
```

Participants see each other's id and display name only; no email, phone or address. `viewerRole` is the caller's side. `listing.imageUrl` is a one-hour signed URL, or `null`.

### `POST /api/v1/borrow-requests`

Token required; account `active`. Body (strict: `borrowerId`, `lenderId`, `status` are rejected):

```json
{ "listingId": "5d0c6f8e-…", "startDate": "2026-11-12", "endDate": "2026-11-14", "message": "Need it for a weekend trip" }
```

`message` is optional, up to 500 characters; blank is stored as `null`.

`201 { "data": { "request": { … } } }`. Errors: `400 VALIDATION_ERROR` (format, past, too far ahead, end before start, over 30 days; `details` names the field), `401`, `403 CANNOT_BORROW_OWN_LISTING`, `403 ACCOUNT_*`, `404 LISTING_NOT_FOUND`, `409 LISTING_NOT_BORROWABLE` (archived or marked unavailable), `409 DATES_UNAVAILABLE` (overlaps an accepted request), `409 DUPLICATE_PENDING_REQUEST` (you already have a pending request for this listing), `429 RATE_LIMITED`.

### `GET /api/v1/borrow-requests/outgoing` and `/incoming`

Token required. `outgoing`: requests the caller made. `incoming`: requests for the caller's listings. Query: `status` (`pending`, `accepted`, `declined`, `cancelled`), `page`, `pageSize` (at most 50). Newest first.

`200 { "data": { "items": [ … ], "pagination": { "page": 1, "pageSize": 20, "total": 3, "totalPages": 1 } } }`

### `GET /api/v1/borrow-requests/:id`

Token required; participants only. `200 { "data": { "request": { … } } }`. Anyone else gets `404 BORROW_REQUEST_NOT_FOUND`, so ids reveal nothing.

### `POST /api/v1/borrow-requests/:id/accept` · `/decline` · `/cancel`

Token required; body `{}`. `200 { "data": { "request": { … } } }` with the new status and `decidedAt` / `cancelledAt` set by the server. Errors: `403 FORBIDDEN` (wrong side, e.g. the borrower accepting), `404 BORROW_REQUEST_NOT_FOUND`, `409 INVALID_STATUS_TRANSITION`, and for accept `409 DATES_UNAVAILABLE` or `409 LISTING_NOT_BORROWABLE` (listing archived).

### `GET /api/v1/items/:id/booked-dates`

Public, token optional. Accepted ranges from today on, for the request form: `200 { "data": { "bookedDates": [ { "startDate": "2026-11-12", "endDate": "2026-11-14" } ] } }`. Dates only, never who booked them. `404 LISTING_NOT_FOUND` for listings the caller cannot see.

## Chat

Private, real-time messaging between the borrower and the lender of an **accepted** borrow request. There is exactly one conversation per accepted request. Nobody else can see it, and there is no way to message an arbitrary user.

- **When it opens.** Accepting a request creates its conversation in the same database transaction. Pending, declined and cancelled requests have no conversation: opening one gives `409 CHAT_NOT_AVAILABLE`.
- **Who is in it.** The database copies the borrower and lender from the request. Clients never send participant or sender ids; bodies that try to are rejected with `400 VALIDATION_ERROR`.
- **Outsiders.** Anyone who is not a participant gets `404` (`CONVERSATION_NOT_FOUND` or `BORROW_REQUEST_NOT_FOUND`), so ids reveal nothing.
- **Archived listings.** Archiving the listing keeps the conversation open and messaging enabled: the accepted reservation still stands and the two people still need to arrange the handover. `listing.archived` is `true` so the app can say so.
- **Sending.** Requires an account that is `active` or `restricted`; `suspended` and `deletion_pending` get `403 ACCOUNT_*`. The status is read on every send. Reading is allowed to any participant.
- **Messages.** Text only, 1 to 2000 characters (counted as characters, not bytes), not blank. Surrounding whitespace is trimmed, `\r\n` becomes `\n`, and control characters other than tab and newline are removed. Messages cannot be edited or deleted.
- **Retries.** Every message carries a `clientId` (a UUID the device generates). The same sender sending the same `clientId` in the same conversation stores the message once and gets the stored copy back with `duplicate: true`; it is not broadcast again. Reusing a `clientId` for different text is `409 CLIENT_ID_REUSED`.
- **Order of operations.** A message is stored in PostgreSQL before it is broadcast. A failed broadcast never loses a message; it is still returned by the history endpoint.
- **Unread counts.** Kept per participant (`unreadCount`); opening a chat marks it read. Your own messages never count. The other person is **not** shown whether you have read their messages (no read receipts).

**Conversation object**

```json
{
  "id": "5f0e2c1a-…",
  "borrowRequestId": "8c0f6d5e-…",
  "viewerRole": "lender",
  "request": { "id": "8c0f6d5e-…", "status": "accepted", "startDate": "2026-11-12", "endDate": "2026-11-14" },
  "listing": { "id": "5d0c6f8e-…", "title": "Camping tent", "archived": false, "imageUrl": "https://…signed…" },
  "otherParticipant": { "id": "0b8e7f7e-…", "displayName": "Sara" },
  "lastMessage": { "id": "9a1b…", "senderId": "0b8e7f7e-…", "body": "Is 5pm ok?", "createdAt": "2026-11-12T11:02:03.123456+00:00" },
  "unreadCount": 1,
  "lastMessageAt": "2026-11-12T11:02:03.123456+00:00",
  "createdAt": "2026-11-11T09:00:00.000000+00:00"
}
```

`lastMessage.body` holds at most the first 200 characters. `otherParticipant` is an id and display name only: no email, phone or address.

**Message object**

```json
{
  "id": "9a1b…",
  "conversationId": "5f0e2c1a-…",
  "senderId": "0b8e7f7e-…",
  "body": "Is 5pm ok?",
  "clientId": "3d6f…",
  "createdAt": "2026-11-12T11:02:03.123456+00:00"
}
```

`id` and `createdAt` are set by the database and never change. `createdAt` keeps microsecond precision; clients should treat it as an opaque timestamp.

### `GET /api/v1/conversations`

Token required. The caller's conversations, most recent activity first. Query: `page`, `pageSize` (at most 50).

`200 { "data": { "items": [ … ], "pagination": { "page": 1, "pageSize": 20, "total": 2, "totalPages": 1 } } }`

### `POST /api/v1/conversations`

Token required. Get-or-create the conversation of an accepted request. Repeating it, from either participant, returns the same conversation.

```json
{ "borrowRequestId": "8c0f6d5e-…" }
```

`200 { "data": { "conversation": { … } } }`. Errors: `400 VALIDATION_ERROR`, `401`, `404 BORROW_REQUEST_NOT_FOUND` (no such request, or you are not part of it), `409 CHAT_NOT_AVAILABLE` (pending, declined or cancelled).

### `GET /api/v1/conversations/:id`

Token required; participants only. `200 { "data": { "conversation": { … } } }`, otherwise `404 CONVERSATION_NOT_FOUND`.

### `GET /api/v1/conversations/:id/messages`

Token required; participants only. One page of history, **newest first**. Query: `limit` (1–100, default 30) and `before` (the `nextCursor` of the previous page, for older messages).

`200 { "data": { "items": [ … ], "nextCursor": "WyIyMDI2LTEx…" } }`. `nextCursor` is `null` on the last page. Cursors are opaque; a malformed one is `400 VALIDATION_ERROR`.

### `POST /api/v1/conversations/:id/messages`

Token required; participants only; account `active` or `restricted`. The fallback for when the socket is not connected; it applies the same rules and is broadcast to connected sockets like a socket send.

```json
{ "clientId": "3d6f2a8e-1b4c-4f7a-9e2d-5c6b7a8f9e0d", "body": "Is 5pm ok?" }
```

`201 { "data": { "message": { … }, "duplicate": false } }` for a new message; `200` with `"duplicate": true` for a retry. Errors: `400 VALIDATION_ERROR` (empty, blank, too long, bad `clientId`, unknown fields), `403 ACCOUNT_*`, `404 CONVERSATION_NOT_FOUND`, `409 CHAT_NOT_AVAILABLE`, `409 CLIENT_ID_REUSED`, `429 RATE_LIMITED`.

### `POST /api/v1/conversations/:id/read`

Token required; participants only. Marks everything in the conversation read for the caller. `200 { "data": { "conversation": { …, "unreadCount": 0 } } }`.

### Socket.IO

Real-time delivery runs on the API's own HTTP server: same host and port, path `/socket.io`, Socket.IO v4. The mobile app uses the WebSocket transport only. REST stays the source of truth: after reconnecting, clients fetch the newest page of history to fill anything missed.

**Authentication.** Pass the Supabase access token in the handshake:

```js
import { io } from 'socket.io-client';
const socket = io(API_URL, { transports: ['websocket'], auth: (cb) => getAccessToken().then((token) => cb({ token })) });
```

The server checks the token with Supabase Auth, exactly like the `Authorization` header on REST. A missing or malformed token is refused with `connect_error` whose `err.data` is `{ "code": "UNAUTHENTICATED" }`; a rejected token gives `{ "code": "INVALID_TOKEN" }` (refresh the session, then `socket.connect()`). The user id comes only from the token; nothing the client sends later can change it. When the token expires, the server emits `session:expired` and disconnects; reconnect with a fresh token.

**Acknowledgements.** Every client event takes an acknowledgement callback, which receives either `{ "ok": true, … }` or `{ "ok": false, "error": { "code", "message", "details"?, "retryAfterSeconds"? } }`. Error codes are the same as REST.

| Event (client → server) | Payload | Acknowledgement | Notes |
| --- | --- | --- | --- |
| `conversation:join` | `{ conversationId }` | `{ ok: true, conversation }` | The server checks that you are a participant before adding the socket to the conversation's private room. Otherwise `CONVERSATION_NOT_FOUND`. At most 50 rooms per socket. |
| `conversation:leave` | `{ conversationId }` | `{ ok: true }` | |
| `message:send` | `{ conversationId, clientId, body }` | `{ ok: true, message, duplicate }` | Authorized again on every send (participant, request accepted, account status). Stored, then broadcast. |

| Event (server → client) | Payload | Sent to |
| --- | --- | --- |
| `message:new` | `{ conversationId, message }` | Sockets in that conversation's room, the sender's included (match on `message.clientId`). |
| `conversation:updated` | `{ conversationId }` | Both participants' own sockets. Contains no message content; it only tells the app to reload its conversation list. |
| `message:error` | `{ conversationId, clientId, error }` | The sending socket, only when `message:send` was emitted **without** an acknowledgement callback. |
| `session:expired` | none | The socket whose token expired, just before it is disconnected. |

Typing indicators are not implemented. Limits: 30 messages per minute per user (REST and socket combined) and 120 events per minute per socket.

**Scaling note.** Rooms and the send limit live in the API process. Running more than one API instance needs a shared Socket.IO adapter (for example Redis) and a shared rate-limit store.

### Testing chat with two accounts

1. Apply both migrations, `20261102120000_borrow_requests.sql` and then `20261103120000_chat.sql` (see [SUPABASE.md](SUPABASE.md#chat-phase-2c)).
2. Start the API (`npm.cmd run dev`) and Expo (`npx expo start -c`) with `EXPO_PUBLIC_API_URL` set to the computer's current LAN address.
3. Sign in as account A on one phone (or emulator) and account B on another.
4. A lists an item. B opens it and sends a borrow request.
5. A opens Activity → Requests for my items → Accept. The app should go straight to the conversation.
6. B opens the Chat tab (pull to refresh) or Activity → My requests → Open chat.
7. Send messages both ways. Each should appear on the other phone without refreshing.
8. Turn one phone's Wi-Fi off. The chat shows "Reconnecting…". A message sent then shows "Not sent · Tap to retry"; it sends after Wi-Fi returns and appears once on the other phone.
9. Sign in as a third account C. C must not see the conversation in the Chat tab.

### Known limitations

- No push notifications: someone whose app is closed sees new messages and newly opened chats only when they next open the Chat tab. While the app is open, the Chat tab and its badge update live.
- No read receipts and no typing indicators. Unread counts are private to each participant.
- Text only: no images or attachments.
- Messages cannot be edited, deleted or reported yet.

## Pickup and handover

Phase 3B.1, pickup only (no returns yet). After a request is accepted, the item is handed over in one of two ways:

- **In person.** The borrower collects it. The lender confirms with `POST …/handover` and `method: "personal"`.
- **By someone the borrower authorizes.** The borrower creates a one-time code for a named person (a friend or relative, who needs no account) and gives them the QR. The lender scans it (`…/handover/verify`, which changes nothing), checks the person and the item, then confirms with `method: "authorized"` and the code.

Only the **lender** can confirm, and only once per request. The borrow request stays `accepted`; the handover is a separate record. All endpoints need a token. A user who is not one of the request's two participants gets `404 BORROW_REQUEST_NOT_FOUND`; the wrong participant gets `403`.

**Codes.** 32 characters (160 random bits from the server's CSPRNG), shown grouped as `ABCD-EFGH-…` for typing. The QR contains only `neighborshare://pickup?v=1&code=<CODE>`: no names, ids, tokens or locations. The server stores only a SHA-256 hash and returns the code once, when it is created. A code works for its own request only, once, until `expiresAt` (`PICKUP_AUTHORIZATION_TTL_HOURS`, default 24). Codes travel only in request bodies, never in URLs, and are never logged. Lowercase, dashes, spaces and the full QR text are all accepted.

### `GET /api/v1/borrow-requests/:id/handover`

`200 { "data": { "handover": HandoverState } }`:

```json
{
  "borrowRequestId": "…",
  "requestStatus": "accepted",
  "status": "pending",
  "handover": null,
  "authorizations": [
    {
      "id": "…", "borrowRequestId": "…", "operation": "pickup", "status": "active",
      "recipientName": "Ali Khan", "recipientPhone": "03001234567", "note": "My brother",
      "expiresAt": "…", "createdAt": "…", "revokedAt": null, "redeemedAt": null
    }
  ],
  "activeAuthorization": { "…": "the active one above, or null" }
}
```

Authorization `status` is `active`, `redeemed`, `revoked` or `expired`; expiry is derived from `expiresAt` on every read. Once completed (`status: "completed"`), `handover` is:

```json
{
  "id": "…", "method": "authorized", "authorizationId": "…",
  "recipientName": "Ali Khan", "recipientPhone": "03001234567",
  "conditionNotes": "Small scratch on the handle", "confirmedAt": "…",
  "confirmedBy": { "id": "…", "displayName": "Ahmed" },
  "photos": [{ "id": "…", "url": "https://…signed…", "contentType": "image/jpeg", "createdAt": "…" }]
}
```

Photo URLs are short-lived signed URLs from a private bucket. Storage issues them only to the two participants.

### `POST /api/v1/borrow-requests/:id/pickup-authorizations`

Borrower only. Body (strict): `{ "recipientName": "Ali Khan", "recipientPhone": "0300 1234567", "note": "…", "confirm": true }`. The name is 2–80 characters. The phone is optional: spaces, dashes and brackets are removed, then 7–15 digits are allowed with an optional leading `+`. The note is optional, up to 200 characters. `confirm` must be `true`, which records that the borrower reviewed the details.

`201 { "data": { "authorization": {…}, "code": "ABCD…", "displayCode": "ABCD-EFGH-…", "qrPayload": "neighborshare://pickup?v=1&code=ABCD…" } }`. The code is never returned again.

Errors: `400 VALIDATION_ERROR`, `403` (the lender), `404`, `409 REQUEST_NOT_ACCEPTED`, `409 ALREADY_HANDED_OVER`, `409 ACTIVE_AUTHORIZATION_EXISTS` (one active authorization per request; revoke it first), `429`.

### `POST /api/v1/borrow-requests/:id/pickup-authorizations/:authorizationId/revoke`

Borrower only. `200 { "data": { "authorization": {…, "status": "revoked"} } }`. Errors: `403`, `404`, `409 AUTHORIZATION_NOT_ACTIVE`.

### `POST /api/v1/borrow-requests/:id/handover/verify`

Lender only. Body: `{ "code": "<scanned QR text or typed code>" }`. Changes nothing. `200 { "data": { "authorization": {…} } }`, which shows the lender who may collect the item.

Errors: `400 VALIDATION_ERROR` (not a pickup code), `400 INVALID_PICKUP_CODE` (no such code for this request), `409 AUTHORIZATION_REVOKED`, `409 AUTHORIZATION_ALREADY_USED`, `409 AUTHORIZATION_EXPIRED`, `409 REQUEST_NOT_ACCEPTED`, `409 ALREADY_HANDED_OVER`, `403`, `404`, `429`.

### `POST /api/v1/borrow-requests/:id/handover`

Lender only: the explicit confirmation. Bodies (strict):

- `{ "method": "personal", "conditionNotes": "…", "confirm": true }`
- `{ "method": "authorized", "code": "…", "conditionNotes": "…", "confirm": true }`

`conditionNotes` is optional, up to 1000 characters.

The database locks the request, rechecks everything, marks the code `redeemed` (for an authorized pickup) and records the handover with the server time, all in one transaction. Concurrent or repeated confirmations get `409 ALREADY_HANDED_OVER`. An in-person confirmation also retires any unused authorization (it becomes `revoked`).

`201 { "data": { "handover": {…} } }`. Errors: the same as verify.

### `POST /api/v1/borrow-requests/:id/handover/photos`

Condition evidence. Raw image body (`Content-Type` `image/jpeg`, `image/png` or `image/webp`, at most 5 MB; the bytes must match the declared type). Only the lender who confirmed may upload, at most 5 photos, within 24 hours of the handover. Upload after confirming. A failed upload never undoes the handover, and the app reports it with a retry option.

`201 { "data": { "photo": {…} } }`. Errors: `409 HANDOVER_NOT_CONFIRMED`, `409 EVIDENCE_LIMIT_REACHED`, `409 EVIDENCE_WINDOW_CLOSED`, `403`, `404`, `415`, `503 STORAGE_NOT_CONFIGURED`.

### Socket.IO: `handover:updated`

`{ "borrowRequestId": "…" }` is sent to both participants' sockets after any stored pickup change: an authorization created or revoked, a handover confirmed, or a photo added. It carries no details; clients reload `GET …/handover`.

## Returns and due dates

Phase 3B.2. After pickup, the **borrower** starts the return, and only the **lender** can confirm that the item is back. Starting a return, or creating a return code, never completes it.

The borrower can return the item in three ways:

- In person.
- By delivery or courier. An optional provider, reference number and note can be added. These are information only: there is no live tracking or courier integration.
- Through someone they authorize with a one-time **return** code. That person needs no account.

The borrow request stays `accepted` throughout. All endpoints need a token. Anyone who is not one of the request's two participants gets `404 BORROW_REQUEST_NOT_FOUND`, and the wrong participant gets `403`.

**Return codes** have the same format and protections as pickup codes: 160 random bits, only a SHA-256 hash stored, shown once, single use, and expiring after `PICKUP_AUTHORIZATION_TTL_HOURS`. They differ in three ways:

- The QR is `neighborshare://return?v=1&code=<CODE>`.
- A return code never works for a pickup, and a pickup code never works for a return. Return verification refuses a pickup QR, and the database looks codes up by operation as well.
- Creating a new return code revokes the previous unused one in the same transaction, so at most one is active.

**Overdue** is computed by the server from the current approved due date (inclusive, Pakistan time). An item is overdue when it has been picked up, has not been returned, and today is after the due date. The item is never marked returned automatically, and nothing is charged or sent.

### `GET /api/v1/borrow-requests/:id/return`

`200 { "data": { "return": ReturnState } }`:

```json
{
  "borrowRequestId": "…", "requestStatus": "accepted",
  "status": "awaiting_confirmation",
  "startDate": "2026-11-12", "dueDate": "2026-11-18", "originalDueDate": "2026-11-14",
  "today": "2026-11-16", "overdue": false, "daysOverdue": 0,
  "return": {
    "id": "…", "method": "delivery",
    "delivery": { "provider": "TCS", "reference": "TRK-123", "note": null },
    "initiatedAt": "…", "updatedAt": "…",
    "authorizationId": null, "recipientName": null, "recipientPhone": null,
    "confirmedAt": null, "confirmedBy": null, "conditionNotes": null, "photos": []
  },
  "authorizations": [{ "…": "return authorizations (operation \"return\"), newest first" }],
  "activeAuthorization": null,
  "extensions": [{
    "id": "…", "status": "approved", "previousEndDate": "2026-11-14", "requestedEndDate": "2026-11-18",
    "reason": "Trip got longer", "requestedWhileOverdue": false, "overdueAtDecision": false,
    "createdAt": "…", "decidedAt": "…"
  }],
  "pendingExtension": null
}
```

`status` is one of:

- `not_picked_up`
- `ready`: picked up, return not started.
- `awaiting_confirmation`: started by the borrower, not yet confirmed by the lender.
- `returned`

Once returned, `return` holds `confirmedAt`, `confirmedBy`, the actual `method`, the recipient (for an authorized return), the notes, and the photos as signed URLs from the private `return-evidence` bucket.

### `POST /api/v1/borrow-requests/:id/return`

Borrower only, after pickup. Body (strict), one of:

- `{ "method": "personal", "confirm": true }`
- `{ "method": "delivery", "deliveryProvider": "…", "deliveryReference": "…", "deliveryNote": "…", "confirm": true }`: all three fields are optional, at most 80, 80 and 300 characters.

Repeating it changes the method. Choosing either method revokes an unused return code. Returns `200` with the `ReturnState`.

Errors: `409 NOT_PICKED_UP`, `409 ALREADY_RETURNED`, `409 REQUEST_NOT_ACCEPTED`, `403`, `404`.

### `POST /api/v1/borrow-requests/:id/return-authorizations`

Borrower only, after pickup. The body is the same as for a pickup authorization: `{ "recipientName", "recipientPhone"?, "note"?, "confirm": true }`. It also sets the return method to `authorized`, and revokes any earlier unused return code.

`201 { "data": { "authorization": {…, "operation": "return"}, "code", "displayCode", "qrPayload": "neighborshare://return?v=1&code=…" } }`. The code is never returned again.

### `POST /api/v1/borrow-requests/:id/return-authorizations/:authorizationId/revoke`

Borrower only. Returns `200` with the revoked authorization.

Errors: `409 AUTHORIZATION_NOT_ACTIVE`, `403`, `404` (also for a pickup authorization's id).

### `POST /api/v1/borrow-requests/:id/return/verify`

Lender only. Body: `{ "code": "<scanned return QR or typed code>" }`. Changes nothing. `200 { "data": { "authorization": {…} } }`.

Errors:

- `400 VALIDATION_ERROR`: not a return code, or a pickup QR.
- `400 INVALID_RETURN_CODE`: no such return code for this request. A pickup code gets this too.
- `409 AUTHORIZATION_REVOKED`, `409 AUTHORIZATION_EXPIRED`, `409 AUTHORIZATION_ALREADY_USED`
- `409 ALREADY_RETURNED`, `409 NOT_PICKED_UP`, `403`, `404`, `429`.

### `POST /api/v1/borrow-requests/:id/return/confirm`

Lender only: the explicit confirmation of receipt, recorded once. The borrower must have started the return (`409 RETURN_NOT_INITIATED` otherwise). Bodies (strict):

- `{ "method": "personal", "conditionNotes"?, "confirm": true }`
- `{ "method": "delivery", "conditionNotes"?, "confirm": true }`
- `{ "method": "authorized", "code": "…", "conditionNotes"?, "confirm": true }`

The database locks the request and rechecks everything in one transaction:

- An authorized return marks the code `redeemed`.
- A personal or delivery return revokes any unused code.
- Confirming again, or concurrently, gets `409 ALREADY_RETURNED`.

`201 { "data": { "return": {…} } }`. Errors: as for verify.

### `POST /api/v1/borrow-requests/:id/return/photos`

Condition evidence after receipt. Raw image body (JPEG, PNG or WebP, at most 5 MB). Only the lender who confirmed can upload, at most 5 photos, within 24 hours. Each upload gets a new server-chosen name and never overwrites another. A failed upload never undoes the confirmed return; the app reports it and offers a retry.

Errors: `409 RETURN_NOT_CONFIRMED`, `409 EVIDENCE_LIMIT_REACHED`, `409 EVIDENCE_WINDOW_CLOSED`, `403`, `404`, `413`, `415`, `503 STORAGE_NOT_CONFIGURED`.

### `POST /api/v1/borrow-requests/:id/extensions`

Borrower only, while the request is accepted and not returned. Body (strict): `{ "requestedEndDate": "YYYY-MM-DD", "reason"?: "…" }`, with the reason at most 300 characters. The new date must meet four rules:

- It is later than the current due date.
- It is not in the past.
- It is at most 30 days after the start, counting both days, as for a new request.
- It does not cover days another accepted request has booked.

Only one extension request can be pending at a time. A pending request does **not** change the due date. `201 { "data": { "extension": {…} } }`.

Errors: `400 INVALID_EXTENSION_DATE`, `409 DATES_UNAVAILABLE`, `409 EXTENSION_PENDING`, `409 ALREADY_RETURNED`, `409 REQUEST_NOT_ACCEPTED`, `403`, `404`, `429`.

### `POST /api/v1/borrow-requests/:id/extensions/:extensionId/approve` and `…/reject`

Lender only. Approval moves the due date (`borrow_requests.end_date`), so the booking calendar and the no-overlap rule cover the extra days. Rejection changes nothing. The extension record keeps the previous date, the requested date, the decision time, the deciding user, and whether the item was overdue when it was requested and when it was decided.

Errors: `409 EXTENSION_ALREADY_DECIDED`, `409 DATES_UNAVAILABLE` (someone else booked the days in the meantime), `404 EXTENSION_NOT_FOUND`, `403`, `404`.

### Socket.IO: `return:updated`

`{ "borrowRequestId": "…" }` is sent to both participants' sockets after any stored return or due-date change. It carries no details; clients reload `GET …/return`.

## Activity

### `GET /api/v1/activity`

Token required. The caller's own recent activity, newest first. Nothing is stored for it: it is derived on each request from records the caller can already read, each queried with the caller's token so Row-Level Security applies. The sources are the 50 most recent borrow requests on each side, conversations and own listings. It takes no user id.

Query: `limit` 1–100, default 50.

| `type` | When | `actor` |
| --- | --- | --- |
| `request_received` | Someone asked to borrow one of your items | Borrower |
| `request_sent` | You asked to borrow an item | You |
| `request_accepted`, `request_declined` | The lender answered (`decidedAt`) | Lender |
| `request_cancelled` | The borrower withdrew (`cancelledAt`) | Borrower |
| `message` | Latest message of a conversation; `preview` holds its first 120 characters | Sender |
| `listing_created`, `listing_archived` | Your listing was created or removed | You |
| `pickup_authorized` | The borrower authorized someone to collect the item (`recipientName`) | Borrower |
| `pickup_authorization_revoked` | That authorization was revoked (by the borrower, or retired by an in-person handover) | Borrower or lender |
| `pickup_authorization_redeemed` | The lender accepted the authorized person's code | Lender |
| `item_handed_over` | The lender confirmed the handover (`handoverMethod`: `personal` or `authorized`) | Lender |

| `return_initiated` | The borrower started the return or changed its method (`returnMethod`) | Borrower |
| `return_authorized`, `return_authorization_revoked` | A return code was created or revoked (`recipientName`) | Borrower (or lender, when receipt retired it) |
| `return_authorization_redeemed` | The lender accepted the authorized person's return code | Lender |
| `item_returned` | The lender confirmed receipt (`returnMethod`) | Lender |
| `extension_requested` | The borrower asked for a later due date (`requestedEndDate`) | Borrower |
| `extension_approved`, `extension_rejected` | The lender decided | Lender |

Every item also has `recipientName`, `handoverMethod`, `returnMethod` and `requestedEndDate`. Each is null except on the events that use it. Pickup events come from the handover audit trail of the caller's own requests only.

Listing edits are not included, because `updated_at` also changes for availability and photo changes, so it is not a reliable "edited" event.

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "request:5d0c…:accepted",
        "type": "request_accepted",
        "occurredAt": "2026-11-04T10:12:00.000Z",
        "actor": { "id": "…", "displayName": "Ahmed", "isYou": false },
        "listing": { "id": "…", "title": "Camping tent", "imageUrl": null },
        "request": { "id": "5d0c…", "status": "accepted", "startDate": "2026-11-12", "endDate": "2026-11-14", "viewerRole": "borrower" },
        "conversationId": null,
        "preview": null
      }
    ],
    "unavailable": []
  }
}
```

`unavailable` names any source (`borrowRequests`, `conversations`, `listings`, `handovers`, `returns`) that could not be read this time; the others are still returned. If all of them fail, the response is the first error (usually `503 DATABASE_UNAVAILABLE`). Errors: `401`, `400 VALIDATION_ERROR` (`limit`).

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
| 400 | `INVALID_PHONE` | Phone start: Supabase refused the number |
| 400 | `PHONE_COUNTRY_NOT_SUPPORTED` | Phone start: country not allowed |
| 400 | `OTP_INVALID_OR_EXPIRED` | Phone confirm: wrong, expired or used code |
| 409 | `PHONE_ALREADY_ON_ACCOUNT` | Phone start: number already confirmed in Supabase but not through this API |
| 409 | `NO_PENDING_PHONE_VERIFICATION` | Phone resend/confirm: no matching code request |
| 401 | `UNAUTHENTICATED` | No `Authorization` header |
| 401 | `INVALID_TOKEN` | Bad, expired or revoked access token |
| 401 | `INVALID_CREDENTIALS` | Login |
| 401 | `INVALID_REFRESH_TOKEN` | Refresh |
| 403 | `EMAIL_NOT_CONFIRMED` | Login |
| 403 | `ACCOUNT_BLOCKED` | Login: user banned in Supabase Auth |
| 403 | `ACCOUNT_SUSPENDED` | Status-guarded routes |
| 403 | `ACCOUNT_DELETION_PENDING` | Status-guarded routes |
| 403 | `ACCOUNT_RESTRICTED` | Status-guarded routes that exclude restricted accounts (listing create, photo upload, listing edits other than availability) |
| 403 | `SIGNUP_DISABLED` | Signup turned off in Supabase |
| 403 | `FORBIDDEN` | Not permitted (e.g. missing role) |
| 404 | `ROUTE_NOT_FOUND` | Unknown path or method |
| 404 | `LISTING_NOT_FOUND` | Listings: no such listing, or archived and not yours |
| 404 | `IMAGE_NOT_FOUND` | Listing photo delete |
| 404 | `BORROW_REQUEST_NOT_FOUND` | Borrow requests: no such request, or you are not a participant |
| 403 | `CANNOT_BORROW_OWN_LISTING` | Borrow request for your own listing |
| 409 | `LISTING_NOT_BORROWABLE` | Borrow request for an archived or unavailable listing; accept on an archived listing |
| 409 | `DATES_UNAVAILABLE` | Borrow request or accept overlapping an accepted request |
| 409 | `DUPLICATE_PENDING_REQUEST` | You already have a pending request for this listing |
| 409 | `INVALID_STATUS_TRANSITION` | Accept/decline/cancel on a request that is no longer pending |
| 404 | `CONVERSATION_NOT_FOUND` | Chat: no such conversation, or you are not a participant |
| 409 | `CHAT_NOT_AVAILABLE` | Chat for a request that is not accepted |
| 409 | `CLIENT_ID_REUSED` | Chat: the same `clientId` sent again with different text |
| 400 | `INVALID_MESSAGE` | Chat: the database refused the message (normally caught first as `VALIDATION_ERROR`) |
| 400 | `INVALID_DATES` | Database refused the dates (normally caught first as `VALIDATION_ERROR`) |
| 409 | `LISTING_ARCHIVED` | Listings: change or photo upload on an archived listing |
| 409 | `IMAGE_LIMIT_REACHED` | Listing photo upload: already 5 photos |
| 400 | `INVALID_LISTING` | Listings: a database constraint refused a value |
| 400 | `INVALID_LOCATION` | Pickup spot: the database refused the coordinates (normally caught first as `VALIDATION_ERROR`) |
| 400 | `INVALID_PICKUP_CODE` | Handover: no such code for this request |
| 409 | `REQUEST_NOT_ACCEPTED` | Handover: the request is not accepted |
| 409 | `ALREADY_HANDED_OVER` | Handover: already recorded for this request |
| 409 | `ACTIVE_AUTHORIZATION_EXISTS` | Handover: revoke the active authorization first |
| 409 | `AUTHORIZATION_NOT_ACTIVE` | Handover: nothing to revoke |
| 409 | `AUTHORIZATION_REVOKED`, `AUTHORIZATION_ALREADY_USED`, `AUTHORIZATION_EXPIRED` | Handover: the code cannot be used |
| 409 | `HANDOVER_NOT_CONFIRMED`, `EVIDENCE_LIMIT_REACHED`, `EVIDENCE_WINDOW_CLOSED` | Handover photos |
| 400 | `INVALID_RETURN_CODE` | Return: no such return code for this request |
| 409 | `NOT_PICKED_UP`, `RETURN_NOT_INITIATED`, `ALREADY_RETURNED`, `RETURN_NOT_CONFIRMED` | Return lifecycle |
| 400 | `INVALID_EXTENSION_DATE` | Extension: date not allowed |
| 409 | `EXTENSION_PENDING`, `EXTENSION_ALREADY_DECIDED` | Extensions |
| 404 | `EXTENSION_NOT_FOUND` | Extensions |
| 400 | `EMPTY_IMAGE` | Listing photo upload with an empty body |
| 415 | `UNSUPPORTED_IMAGE_TYPE` | Listing photo upload: not JPEG/PNG/WebP, or content does not match `Content-Type` |
| 409 | `EMAIL_ALREADY_REGISTERED` | Signup, only if email confirmation is disabled |
| 413 | `PAYLOAD_TOO_LARGE` | JSON body over 100 kB; photo over 5 MB |
| 422 | `WEAK_PASSWORD` | Signup: Supabase's password check failed; `details.reasons` |
| 429 | `RATE_LIMITED` | This API's limits or Supabase's own; see `Retry-After` |
| 500 | `INTERNAL_ERROR` | Unexpected server error (logged with the `requestId`) |
| 500 | `PROFILE_MISSING` | Account exists without a profile (should not happen) |
| 502 | `AUTH_PROVIDER_ERROR` | Supabase returned an error or result the API does not recognise |
| 503 | `PHONE_VERIFICATION_NOT_CONFIGURED` | Phone verification endpoints: Supabase or database not set up; `details.reason` says which |
| 503 | `SMS_DELIVERY_UNAVAILABLE` | Supabase or its SMS provider could not send the code |
| 503 | `AUTH_UNAVAILABLE` | Supabase Auth unreachable, failing, or slower than 12 s |
| 503 | `DATABASE_UNAVAILABLE` | Database query failed |
| 503 | `EMAIL_DELIVERY_UNAVAILABLE` | Supabase cannot send email (custom SMTP not configured) |
| 503 | `SERVER_NOT_CONFIGURED` | A server-side feature lacks its configuration |
| 503 | `STORAGE_NOT_CONFIGURED` | Listing photos: the `listing-images` bucket does not exist (migration not applied) |
| 503 | `STORAGE_UNAVAILABLE` | Listing photos: Supabase Storage failed |

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
| `POST /verification/phone/start` | 10 / hour | Client IP |
| `POST /verification/phone/start` | 5 / hour | Account (signed-in user) |
| `POST /verification/phone/start` | 5 / hour | Destination number (across all accounts) |
| `POST /verification/phone/resend` | 10 / hour | Client IP |
| `POST /verification/phone/resend` | 5 / hour | Account |
| `POST /verification/phone/confirm` | 30 / 15 min | Client IP |
| `POST /verification/phone/confirm` | 10 / 15 min | Account |
| `POST /items` | 20 / hour | Account |
| `POST /items/:id/images` | 60 / hour | Account |
| `PUT /items/:id/location` | 60 / hour | Account |
| `POST /borrow-requests/:id/pickup-authorizations` | 20 / hour | Account |
| `POST …/handover/verify` and `POST …/handover` (shared) | 30 / 15 min | Account |
| `POST …/handover/photos` | 30 / hour | Account |
| `POST …/return-authorizations` | 20 / hour | Account (separate counter) |
| `POST …/return/verify` and `POST …/return/confirm` (shared) | 30 / 15 min | Account (separate counter) |
| `POST …/return/photos` | 30 / hour | Account (separate counter) |
| `POST …/extensions` | 10 / hour | Account |
| `POST /borrow-requests` | 20 / hour | Account |
| Chat messages (REST and socket together) | 30 / minute | Account |
| Socket.IO events | 120 / minute | Socket |
| Phone start + resend | 1 SMS per `PHONE_OTP_RESEND_COOLDOWN_SECONDS` (default 60 s) | Account; **stored in the database**, so it holds across API instances and makes double taps safe |

IPv6 clients are grouped by /56. Behind a reverse proxy, set `TRUST_PROXY_HOPS` so the real client IP is used. Supabase applies its own limits as well (notably on sending email and SMS, and on OTP verifications per IP); those also surface as `429 RATE_LIMITED`. Phone limits are keyed by a hash of the user id or number, never the raw value, and never include the code.
