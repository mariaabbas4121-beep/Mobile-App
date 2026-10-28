# Testing guide

The backend has three test suites. They prove different things, so read results per suite.

| Suite | Command | Runs against | Proves | Does not prove |
| --- | --- | --- | --- | --- |
| Unit | `npm run test:unit` | Fakes, plus the real Supabase SDK pointed at a closed port, plus the real server process | API contract, validation, error mapping, rate limits, status and role checks, startup behaviour, outage handling | Anything about Supabase itself |
| Database | `npm run test:db` | The real migrations on [PGlite](https://pglite.dev) (in-process PostgreSQL) with a stand-in for Supabase's `auth` schema and roles | Triggers, constraints, transitions, grants and Row-Level Security logic | That the hosted project matches |
| Integration | `npm run test:integration` | Your Supabase **development/test** project | Live auth, email confirmation, token revocation, RLS and grants as deployed | Email delivery (opt-in test only), Google sign-in (tested in the app, see `frontend/README.md`) |

| Command | Runs |
| --- | --- |
| `npm test` | Unit + database (offline, no credentials needed) |
| `npm run test:all` | Type check + all three suites |
| `npm run typecheck` | Strict TypeScript check |

In PowerShell, use `npm.cmd` if the execution policy blocks `npm.ps1`.

## Unit tests (`tests/unit`)

They need no `.env`, network or Supabase project.

| File | Covers |
| --- | --- |
| `config.test.ts` | Environment validation; error messages never contain values |
| `app.test.ts` | Health, security headers, CORS, request ids, 404, malformed JSON, 413 |
| `errors.test.ts` | Error handler and body validation |
| `auth.routes.test.ts` | Every auth endpoint's contract, including signup that does not reveal existing accounts, and token handling |
| `auth.errors.test.ts` | Mapping of Supabase errors (real SDK error classes) to API codes |
| `onboarding.test.ts` | `/status` derivation: stages, independent milestones, expiry |
| `security.test.ts` | Rate limits, account-status guard, role check, profile field rules, log redaction |
| `outage.test.ts` | Real SDK against an unreachable host: prompt `503`, no internals |
| `slow-supabase.test.ts` | Real SDK against a server that accepts connections and never answers: login, refresh, `/me` and `/status` end with `503 AUTH_UNAVAILABLE` at the deadline; health answers at once; timing logs carry the request id and no credentials |
| `server.test.ts` | Starts `src/server.ts` as a process: boots with valid config; exits 1 with a sanitized message on invalid config |
| `phone-verification.test.ts` | Phone routes and service against an in-memory model of Supabase's phone-change flow: number parsing, auth and account status, start/resend/confirm success, provider disabled or misconfigured, SMS failure, numbers owned by other accounts, wrong/expired/repeated codes, other users' numbers, independent post-verification check, recovery after a lost database write, number changes, reconciliation, cooldown and double taps, per-IP/account/number limits, logs without codes |
| `supabase-phone-auth.test.ts` | The Supabase adapter with fake HTTP and SDK: request shape (caller's token), error mapping, settings caching, revoking the session `verifyOtp` issues |

## Database tests (`tests/db`)

`tests/db/pglite.ts` creates a fresh database, adds a minimal stand-in for Supabase (roles `anon`, `authenticated`, `service_role`; `auth.users`; `auth.uid()`; Supabase's default grants), then applies every file in `supabase/migrations` in order. `asUser()` runs SQL as the `authenticated` role with a chosen user id, the way Supabase runs a request carrying that user's token.

They cover signup provisioning, retries and bad metadata, email confirmation, verification transitions, provider-reference uniqueness, per-user read and update rules, protected columns, suspended accounts, anonymous access, the append-only audit log (including `TRUNCATE`), and user deletion.

`phone-verification.test.ts` covers the phone functions: pending never means verified, completion only for the requested number, one user's result never touching another's, the cooldown, number changes, stale claims on a number, re-verification after revocation, audit events without numbers or codes, and that clients can neither call the functions nor write the phone columns.

Passing here means the migration logic is right. It does not prove the hosted project is identical; the integration suite checks that.

## Integration tests (`tests/integration`)

### Safety guard

They create and delete real users, so `tests/integration/setup.ts` refuses to run unless **all** of these hold:

- `INTEGRATION_PROJECT_REF` in `backend/.env` equals the project ref in `SUPABASE_URL`. Set it only for a development/test project, never production.
- `NODE_ENV` is not `production`.
- `SUPABASE_SECRET_KEY` is set (needed to create and remove throwaway users).

Throwaway users use `it-<uuid>@neighborshare-integration.test` addresses and are created with the admin API, which sends no email. Every one is deleted in `afterAll`, even when a test fails. Audit events they generate remain, because the audit log is append-only by design; their user reference is cleared when the user is deleted.

### Files

| File | Covers |
| --- | --- |
| `auth.live.test.ts` | Login, wrong and unknown credentials, `/me`, `/status`, refresh, logout (local and global), revoked and tampered tokens, email confirmation via a confirmation token |
| `security.live.test.ts` | Profile update and completion; suspension enforcement in the API and directly in the database; user A vs user B; protected columns; verification and audit tables; internal functions; anonymous access |
| `signup.live.test.ts` | Duplicate and concurrent duplicate signups, Supabase-refused addresses, repeated email confirmation, opt-in real signup |
| `phone.live.test.ts` | Never sends SMS. While the Phone provider is disabled: `start` returns `503` (skipped once it is enabled). With the phone migration applied: a user token cannot call the phone functions or write phone columns (skipped until applied) |

Most security tests deliberately **bypass the API** and call Supabase's REST endpoint with a user's own token, as a malicious client could, to prove the database enforces the rules on its own.

### Skipped tests are not passes

- **Real signup with email delivery** runs only when `INTEGRATION_SIGNUP_EMAIL` is set to a mailbox you own. With Supabase's built-in mailer it must belong to a project team member. It is skipped if that address already has an account, so it can never delete a real account.
- **Signup tests skip when Supabase's email-send rate limit is reached.** The built-in mailer allows only a few emails per hour, and Supabase checks that limit on every signup call. The test still checks data consistency before skipping, and prints the reason. Raise the limit under **Authentication → Rate Limits** on the dev project, or configure custom SMTP.

## Results at handoff (2026-10-20)

| Suite | Result |
| --- | --- |
| Type check | Clean |
| Unit | 128 / 128 passed |
| Database | 35 / 35 passed |
| Integration | 23 passed, 2 skipped (Supabase email-send limit; opt-in signup not configured) |

The skipped Supabase-refused-address test passed earlier on the same day, before the email limit was reached.

### Phone verification (2026-10-26)

| Check | Result |
| --- | --- |
| Type check and build | Clean |
| `npm test` (unit + database) | 275 / 275 passed (107 of them new for phone verification) |
| `phone.live.test.ts` | 1 passed (`503 PHONE_VERIFICATION_UNAVAILABLE` from the live project; the code is now `PHONE_VERIFICATION_NOT_CONFIGURED`), 1 skipped (migration not yet applied) |
| Other integration files | Not re-run for this change |
| Real SMS delivery | **Not tested.** The Phone provider is not configured |

### Sign-in latency (2026-10-28)

Measured from the development computer against the hosted dev project, with a throwaway user created and deleted by the admin API. Over the LAN address, as a phone on the same Wi-Fi would connect; warm runs, cold first call in brackets.

| Step | Time |
| --- | --- |
| `GET /api/v1/health` (no Supabase) | 8–34 ms |
| `POST /auth/login` | 358–527 ms (869–1,348 ms) |
| `GET /auth/me` | 580–622 ms |
| `GET /auth/status` | 569–663 ms (up to 1,163 ms) |
| `/me` + `/status` in parallel, as the app loads them | 597–1,372 ms |
| `POST /auth/refresh` | 290–553 ms |
| Supabase `get_user` / sign-in / one database query, inside the API | ~280–360 / ~360–660 / ~280–880 ms |
| A request to an IP address no host answers (stale `EXPO_PUBLIC_API_URL`) | **21,125 ms**, then failure |

The API was not the cause of the reported hang; the app was configured with an address the computer no longer had. See `frontend/README.md` (troubleshooting).

### Authentication audit (2026-10-28, later)

| Check | Result |
| --- | --- |
| Backend type check | Clean |
| `npm test` (unit + database) | 286 / 286 passed |
| Integration (live dev project) | 24 passed, 5 skipped, 0 failed. Skipped: 3 signup tests that need *Confirm email* on (the project has it off), the opt-in real-email signup, and the phone-functions test (migration not applied). Before the skip guard was added, those 3 signup tests failed, and one of them left an untracked throwaway user behind (removed; the test now tracks anything it creates) |
| Frontend tests (`npx jest`) | 178 / 178 passed |
| Frontend type check | 1 error in `app/lend/new.tsx` (`images` is not on `Item`): **already present**, in a file this work did not change |
| `npx expo export` web / android / ios | All three succeed; no secret key in the bundles |
| Google sign-in on a device | **Not tested** (no device here). See below for what was checked instead |
| Phone verification end to end | **Not possible yet**: Phone provider disabled and migration not applied on the dev project |

Timings over the LAN address with a throwaway user (warm, cold in brackets): health 5–11 ms (28–79 ms), login 435–785 ms (1,433–1,570 ms), `/me` 1,028–1,157 ms, `/status` 732–1,513 ms, phone status 1,238–1,491 ms, refresh 715–975 ms, logout 741–878 ms. Each Supabase call takes ~300–700 ms from this network (debug logs: `get_user` ~300–770 ms, one database query ~300–710 ms); the API's own overhead is under 10 ms. Nothing hangs; every call ends within its 12 s (API) or 20 s (app) limit.

**What was established about Google sign-in without a device:**

- Supabase sends the Expo Go redirect (`exp://10.172.18.160:8081/--/auth/callback`) back to the app; `neighborshare://auth/callback` and `http://localhost:8081/auth/callback` are **not** allowed and fall back to the Site URL. Checked by starting an OAuth flow for each redirect and having Supabase report a denial, which redirects to the URL it accepted.
- Both Google users in the project were created by Supabase but **never signed in** (`last_sign_in_at` empty): no code exchange ever succeeded.
- Two client defects could each end such a sign-in silently, and are fixed with tests: Android's browser "dismiss" being taken as a cancel when the deep link arrives a moment later; and the callback screen waiting on an account load that a second delivery of the same session never reported, leaving a spinner.

## Manual test: phone verification with a Supabase test number

On the **dev project only**, once the migration is applied and the Phone provider is on (SUPABASE.md, *Development with test phone numbers*). No SMS is sent.

1. Run the settings check in SUPABASE.md; expect `phone: true, phone_autoconfirm: false`.
2. In the dashboard, add a test number, e.g. `923001234567=123456`.
3. In the app: **Profile → Phone number**, Pakistan, `300 1234567`, **Send code**. Expect the "code is on its way" notice, and `202` in the API log.
4. Enter `000000`: expect "That code is incorrect or has expired"; the status stays pending.
5. Enter `123456`: expect "Phone verified". In Supabase: `auth.users.phone = 923001234567` with `phone_confirmed_at`; `profiles.phone_verified_at` set; `user_verifications` phone `verified`.
6. Reopen the screen: it shows the masked number as verified (read from the server, not the app).
7. Sign out and in again with email or Google: sign-in does not depend on the phone.
8. Remove the test number from the dashboard when finished.

## Not covered by automated tests

| Area | Why | How to verify manually |
| --- | --- | --- |
| Email delivery and the link in the email | Needs a real mailbox and SMTP | Sign up through the API with your own address, open the email, click the link, then log in and check `/status` |
| Expiry of an untampered access token | Takes an hour in real time | Log in, wait until `expiresAt`, call `/me`: expect `401 INVALID_TOKEN` |
| Rate limits across several API instances | Counters are per process | Only relevant once a shared store is added |
| Google sign-in end to end | Needs a device, a browser and Google consent | See `frontend/README.md#google-sign-in` |
| SMS delivery and a real OTP round trip | Needs a configured SMS provider, a real phone and costs money | [Manual phone verification test](#manual-phone-verification-test) |
| Identity verification | Not implemented | — |

## Manual phone verification test

Only after the [SMS setup](SUPABASE.md#sms-setup-for-phone-verification). Use **your own** phone, on the **dev** project, and keep the number of texts small (each costs money).

1. Sign in to the app with a test account and open **Profile → Phone number**.
2. Enter your number and tap **Send code**. Expect the "a code is on its way" notice and a resend countdown. Check that a text arrives and how long it takes.
3. Enter a **wrong** code: expect "incorrect or has expired"; the profile still shows "Waiting for code".
4. Enter the **right** code within the expiry window: expect "is verified", and in Supabase: `auth.users.phone` set with `phone_confirmed_at`, `profiles.phone_verified_at` set, `user_verifications` phone `verified`, and **no extra session** left for that user from the verification (Authentication → Users → sessions).
5. Wait past the expiry, request again and use the old code: expect "incorrect or has expired".
6. Tap **Resend code** before the countdown ends: the button stays disabled. After it, a new text arrives.
7. With a second test account, try the same number: the response looks the same, no text arrives, and confirming fails.
8. Check `audit_events` contains the phone events and no number or code.
9. Record the date, provider, operator and result here.

## Adding tests

- Unit: build the app with `testApp()` from `tests/helpers.ts`; its `gateway` and `profiles` are spies you can override per test. `phoneAuth` (a model of Supabase's phone-change flow, code `FAKE_OTP`) and `phoneStore` (the database functions in memory) back the phone endpoints.
- Database: `createMigratedDb()`, `createAuthUser()`, `asUser()`, `asRole()` and `sqlState()` from `tests/db/pglite.ts`.
- Integration: use `TestUsers` from `tests/integration/setup.ts` for every user you create, so cleanup is guaranteed.
