# NeighborShare API reference (v1)

This is the contract the mobile app integrates against. Everything here is implemented and covered by tests; anything not listed (identity verification) does not exist yet. Google sign-in has no endpoint here: the app completes it with Supabase Auth and then uses the resulting access token with these endpoints like any other.

- [Conventions](#conventions)
- [Health](#health)
- [Auth](#auth): [signup](#post-apiv1authsignup), [login](#post-apiv1authlogin), [refresh](#post-apiv1authrefresh), [resend confirmation](#post-apiv1authemailresend), [logout](#post-apiv1authlogout), [me](#get-apiv1authme), [status](#get-apiv1authstatus)
- [Profile](#profile): [update](#patch-apiv1profileme)
- [Phone verification](#phone-verification): [status](#get-apiv1verificationphone), [start](#post-apiv1verificationphonestart), [resend](#post-apiv1verificationphoneresend), [confirm](#post-apiv1verificationphoneconfirm)
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
| 502 | `AUTH_PROVIDER_ERROR` | Supabase returned an error or result the API does not recognise |
| 503 | `PHONE_VERIFICATION_NOT_CONFIGURED` | Phone verification endpoints: Supabase or database not set up; `details.reason` says which |
| 503 | `SMS_DELIVERY_UNAVAILABLE` | Supabase or its SMS provider could not send the code |
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
| `POST /verification/phone/start` | 10 / hour | Client IP |
| `POST /verification/phone/start` | 5 / hour | Account (signed-in user) |
| `POST /verification/phone/start` | 5 / hour | Destination number (across all accounts) |
| `POST /verification/phone/resend` | 10 / hour | Client IP |
| `POST /verification/phone/resend` | 5 / hour | Account |
| `POST /verification/phone/confirm` | 30 / 15 min | Client IP |
| `POST /verification/phone/confirm` | 10 / 15 min | Account |
| Phone start + resend | 1 SMS per `PHONE_OTP_RESEND_COOLDOWN_SECONDS` (default 60 s) | Account; **stored in the database**, so it holds across API instances and makes double taps safe |

IPv6 clients are grouped by /56. Behind a reverse proxy, set `TRUST_PROXY_HOPS` so the real client IP is used. Supabase applies its own limits as well (notably on sending email and SMS, and on OTP verifications per IP); those also surface as `429 RATE_LIMITED`. Phone limits are keyed by a hash of the user id or number, never the raw value, and never include the code.
