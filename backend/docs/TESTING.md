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
| `listings.routes.test.ts` | Listing endpoints with an in-memory repository: create/read/update/archive contract, rejecting client-supplied owners and unknown fields, validation of every field and query parameter, pagination, search and filters, owner-only edits and archives (403), unknown and malformed ids (404/400), account-status rules, archived listings, photo type/content/size checks (415/413), the 5-photo limit, photo ownership, rate limit |
| `borrow-requests.routes.test.ts` | Borrow-request endpoints with in-memory repositories: create (dates in Pakistan time, inclusive, same-day, 30-day and 90-day limits, bad formats), auth and account status, own/archived/unavailable listings, client-supplied ids rejected, overlap with accepted requests, duplicate pending, accept/decline/cancel by the right side only, outsiders get 404, every invalid transition, losing an accept race gives 409, lists and filters, booked dates, rate limit |
| `listing-locations.routes.test.ts` | Nearby search through the API: 3 km default, nearest first, rounded distances, wider radii, a distant city never included, listings without a spot excluded from nearby but in city and default browsing, filters and pagination, explicit sort; every invalid lat/lng/radius/city/sort combination refused, empty `lat` treated as absent, unchanged default search; pickup spot set by the owner only, precise values never in public responses, clearing, archived refused, editing never moves it, rate limit |
| `chat.routes.test.ts` | Chat REST endpoints with in-memory repositories: get-or-create is idempotent for both sides, pending/declined/cancelled refused, outsiders get 404 everywhere, participant ids rejected, list with last message and unread count, mark read, cursor pagination and bad cursors, send validation and sanitising, retry with the same clientId stored and published once, clientId reuse, account status, archived listing, rate limit |
| `chat.socket.test.ts` | The Socket.IO server on a real localhost HTTP server with real `socket.io-client` connections: no token, bad token, valid token, disconnect on token expiry; join only for participants (room membership checked); messages stored before broadcast and delivered only to room members; content-free hints to participants outside the room; retries delivered once; validation and client-supplied sender ids; outsiders, non-accepted requests and suspended accounts refused; `message:error` without an ack; REST sends reach sockets; leaving a room |
| `supabase-phone-auth.test.ts` | The Supabase adapter with fake HTTP and SDK: request shape (caller's token), error mapping, settings caching, revoking the session `verifyOtp` issues |

## Database tests (`tests/db`)

`tests/db/pglite.ts` creates a fresh database, adds a minimal stand-in for Supabase (roles `anon`, `authenticated`, `service_role`; `auth.users`; `auth.uid()`; Supabase's default grants), then applies every file in `supabase/migrations` in order. `asUser()` runs SQL as the `authenticated` role with a chosen user id, the way Supabase runs a request carrying that user's token.

They cover signup provisioning, retries and bad metadata, email confirmation, verification transitions, provider-reference uniqueness, per-user read and update rules, protected columns, suspended accounts, anonymous access, the append-only audit log (including `TRUNCATE`), and user deletion.

`phone-verification.test.ts` covers the phone functions: pending never means verified, completion only for the requested number, one user's result never touching another's, the cooldown, number changes, stale claims on a number, re-verification after revocation, audit events without numbers or codes, and that clients can neither call the functions nor write the phone columns.

`listings.test.ts` covers the listings migration: only active users create, only for themselves; others' updates match nothing; ownership cannot move; archiving is server-stamped and final; no deletes; suspended owners vanish from discovery; anonymous reads expose only listing columns; `search_listings` word search (wildcards literal), filters, paging with a stable total, sorting and the page-size cap; photo rows tied to the owner's own listing and folder, not on archived listings, at most 5; and the Storage bucket's privacy, limits and upload/read/delete policies (on a minimal `storage` schema stand-in).

`borrow-requests.test.ts` covers the borrow-request migration: lender filled from the listing and not choosable, borrower identity enforced, anonymous access refused, own/archived/unavailable/suspended-owner listings refused, the date window and limits, one pending per borrower, every allowed and forbidden transition and actor, immutable request details, account-status rules, auto-decline on archive, no deletes, and the exclusion constraint (touching inclusive ranges conflict, the next day does not, the service role and a single multi-row update cannot bypass it, declined/cancelled reserve nothing), plus both read helpers. PGlite has one connection, so two transactions cannot truly race here; the guarantee under real concurrency is PostgreSQL's exclusion constraint, which these tests show is in place and enforced.

`listing-locations.test.ts` covers the location migration: precise spot readable only by its owner, offsets readable by nobody; the public point 150–460 m from the precise one and rounded; stable across re-saves and shared by an owner's listings; no direct writes; owner/active/unarchived rules and coordinate validation; clearing; nearby search (radius, nearest first, rounding matching an independent haversine, wider radii, the 50 km cap, distant cities, listings without a spot, filters, pagination, invalid coordinates, archived and suspended owners, the ±180° wrap); city search; and the city backfill of listings created before the migration.

`chat.test.ts` covers the chat migration: accepting creates the conversation with the request's participants; no conversation for pending, declined or cancelled requests; `open_conversation` idempotent and on demand; outsiders get null; no direct writes to conversations and no access to internal helpers; only participants read conversations and messages; anonymous gets nothing; the conversation list (other participant, last message, unread count, ordering); mark read; cursor pagination with no gaps or repeats; send validation (empty, blank, over 2000); idempotent client ids and refusing a reused id; no impersonation, no chosen ids or timestamps, no edits or deletes; suspended refused and restricted allowed; refused once the request is no longer accepted; archived listings keep chat open.

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

### Listings, Phase 2A (2026-10-28)

| Check | Result |
| --- | --- |
| Backend type check, build | Clean |
| `npm test` (unit + database) | 370 / 370 passed (286 earlier + 50 listing route tests + 34 listing database tests) |
| Frontend type check | Clean (the earlier `app/lend/new.tsx` error is gone with the rewrite of that screen) |
| Frontend tests (`npx jest`) | 202 / 202 passed (178 earlier + 24 listing tests: feed loading/empty/error/retry, server-side search and category, detail for owner and neighbor, availability toggle, archive, form validation, double tap, server field errors, photo uploads with partial failure, edit mode, API client query strings and raw uploads) |
| `npx expo install --check` | Dependencies up to date |
| Live API against the dev project | `/health` 200; listing reads `503 DATABASE_UNAVAILABLE` (log: `PGRST202`, function missing) because the migration is **not applied**; auth (401) and validation (400) behave as documented |
| Listing create/update/archive/photos against Supabase | **Not tested live**: needs the migration applied and a signed-in test user |
| Later the same day, migration applied (live, throwaway user, cleaned up) | Through the local API: create 201 with the persisted listing; on page 1 of the feed signed in and anonymous; hidden by a non-matching category; JPEG upload 201; signed URL serves the image; archive 200. Photo upload **from a phone** still untested |
| Feed refresh after create (frontend, `listingFeedRefresh.test.tsx`) | 9 / 9: new listing appears without a full-screen spinner, one refetch per change, no duplicate request on later filter changes, filter hint with "Show all", visible failure banner, retry on returning to the tab, no request when already up to date, failed create, pull-to-refresh |
| Integration suite for listings | **None yet** |

### Borrow requests, Phase 2B (2026-11-02)

| Check | Result |
| --- | --- |
| Backend type check, build | Clean |
| `npm test` (unit + database) | 445 / 445 passed (370 earlier + 41 borrow route tests + 34 borrow database tests) |
| Frontend type check | Clean |
| Frontend tests (`npx jest`) | 239 / 239 passed (22 new: date rules, request form, item screen, requests screen) |
| Hosted Supabase | **Migration not applied**; nothing about borrow requests was run against the hosted project |
| Concurrent accepts on a real server | **Not run** (PGlite has one connection; the exclusion constraint is the guarantee) |

### Secure returns and due-date extensions, Phase 3B.2 (2026-11-10)

| Check | Result |
| --- | --- |
| Backend type check, build | Clean |
| `npm test` (unit + database) | **639 / 639 passed** (43 new: 20 database, 22 route, 1 socket). The server-process test's start-up wait went from 30 s to 60 s, because `tsx` compiling the server alongside the parallel suites took longer than 30 s. It passed alone with the old limit; its assertions are unchanged |
| Frontend type check | Clean |
| Frontend tests (`npx jest`) | **341 / 341 passed** (23 new). One 3B.1 assertion was narrowed from `/Authorize someone/` to the exact pickup label, because the new return card legitimately offers "Authorize someone else to return it" |
| Android bundle (`expo export --platform android`) | Built (6.5 MB Hermes bundle) |
| Hosted Supabase | **Not tested.** The migration is not applied |
| Real devices, camera, QR, share sheet | **Not tested** |

New backend tests:

- **`tests/db/returns.test.ts`** (20), on the real migration:
  - Personal and delivery initiation; only the borrower; only after pickup.
  - App roles cannot read or write the return tables or `end_date` directly.
  - Return codes are hashed; a replacement revokes the previous code atomically.
  - The lender cannot authorize; revoke is borrower-only.
  - Pickup and return codes never work for each other, in either direction and through every function.
  - Verify changes nothing; confirm records once with the recipient and notes; the borrower cannot confirm.
  - Invalid, expired, revoked, other-request and used codes are refused.
  - Personal and delivery receipt need an initiated return and retire an unused code.
  - Three simultaneous confirmations produce exactly one receipt.
  - Evidence: only the confirming lender, at most 5, never before confirmation, 24-hour window, participant-only files, private bucket.
  - Extensions:
    - A pending request does not move the due date; approval moves it, including in the booking calendar.
    - A duplicate pending request is refused; rejection leaves the date unchanged.
    - Invalid dates and the wrong people are refused.
    - It cannot extend over someone else's booking, at request or at approval.
    - Overdue follows the approved due date, and the late-request flags are kept.
    - Not overdue before pickup or after the return.
    - The due date cannot be changed any other way.
  - Visibility: state and events for participants only.
- **`tests/unit/returns.routes.test.ts`** (22) covers the same rules through the API, plus:
  - Strict bodies and a confirmation flag.
  - Pickup QR refused at return verify, and return QR refused at pickup verify.
  - Four concurrent confirmations give one success.
  - Files over 5 MB get 413; a failed upload leaves the return intact and can be retried.
  - Overdue days from the server's Pakistan date.
  - Activity for participants only; every endpoint needs a token.
- **`chat.socket.test.ts`** (+1): `return:updated` reaches both participants, carries no details, and reaches no outsider.

New frontend tests (`__tests__/returns.test.tsx`, 23):

- Code separation.
- Borrower: ready-to-return state with the due date; personal return needs the owner (no self-confirm); delivery details; authorize someone else; awaiting-confirmation state with active and expired codes, show again and revoke; return failure does not hide the pickup.
- Lender: delivery, in-person and QR confirmation entry points; nothing to confirm before the borrower starts; the returned state with notes and photos.
- Due date:
  - Server overdue on both sides.
  - No overdue after an approved extension.
  - The extension request stepper, a refused request, and a pending request that changes nothing.
  - Lender approve and decline.
  - Reload on `return:updated`.
- Return authorization screen: a return code (not a pickup code), the QR, sharing and revoking.
- Lender confirmation screen:
  - A pickup QR is refused; the return QR leads to the checklist and then the receipt.
  - A typed code works; an expired code says not to accept it.
  - Delivery receipt with a failed photo reported and then retried.
  - A repeated confirmation is explained.
- Activity wording.

### Secure handover and authorized pickup, Phase 3B.1 (2026-11-08)

| Check | Result |
| --- | --- |
| Backend type check, build | Clean |
| `npm test` (unit + database) | **596 / 596 passed**. 39 new tests: 17 database, 21 route and 1 socket. Details follow the table |
| Frontend type check | Clean |
| Frontend tests (`npx jest`) | **318 / 318 passed**. 20 new tests, listed after the backend groups |
| Android bundle (`expo export --platform android`) | Built (6.5 MB Hermes bundle, includes `expo-camera`, `expo-sharing`) |
| Hosted Supabase | **Not tested.** The migration is not applied |
| Real devices, camera, QR scanning, share sheet | **Not tested** |

New backend tests:

- **`tests/db/handover.test.ts`** (17), on the real migration:
  - Only the borrower authorizes, and only for accepted requests.
  - The code is stored as a hash and audited.
  - One active authorization at a time; revoking allows a new one.
  - App roles cannot read or write the tables directly.
  - Only the lender verifies; verifying changes nothing.
  - A wrong code, or a code from another request, is invalid.
  - The correct lender redeems once; replays are refused.
  - Revoked and expired codes are refused.
  - Three simultaneous confirmations produce exactly one handover.
  - Personal pickup works, and the borrower cannot confirm it.
  - State and history are visible to the participants only.
  - Evidence: only the confirming lender, at most 5 photos, within 24 hours; files and records readable by the participants only; the bucket is private.
- **`tests/unit/handover.routes.test.ts`** (21), through the API:
  - Code format, CSPRNG output and the QR payload.
  - The code is returned once and only its hash is stored.
  - Explicit confirmation and strict bodies are required.
  - Outsider gets 404 and lender 403 when authorizing.
  - Pending, declined and cancelled requests are refused.
  - Revoke, then a replacement with a new code.
  - Scanning does not hand over.
  - A wrong lender, the borrower or an outsider cannot redeem.
  - The correct lender confirms once; the borrow request stays accepted.
  - A code cannot be used for another request.
  - Revoked and expired codes are refused.
  - Invalid input is refused without being echoed back.
  - Four concurrent confirmations give one 201 and three 409s.
  - Personal pickup works and retires an unused authorization.
  - Evidence rules hold, including the 24-hour window.
  - Activity events reach participants only.
  - Every endpoint needs a token.
- **`chat.socket.test.ts`** (+1): `handover:updated` reaches both participants, carries no details, and reaches no outsider.

New frontend tests (`__tests__/handover.test.tsx`, 20):

- Code parsing.
- Borrower details: collect myself (it cannot mark the pickup itself), authorize someone else, an active authorization with revoke, the completed handover with notes and photos, and reload on the socket hint.
- Lender details: scan and confirm actions; not-accepted requests show none.
- Authorization: form validation, then review, then explicit confirmation, then the QR and share. A server refusal is shown. The QR can be shown again from this device's copy, or is unavailable (other device, expired, revoked).
- Scanner:
  - Camera permission: ask, then Settings.
  - A valid QR leads to the review, which needs both checks before confirming.
  - Non-NeighborShare QR codes are refused without a server call.
  - Expired, revoked, used and wrong codes say "Do not hand over".
  - A typed code works.
- Personal confirmation: confirmed before any photo upload. A failed photo is reported and retryable, and a refused confirmation is explained.
- Activity wording for the pickup events.

### Discovery and activity polish, Phase 3A.1 (2026-11-04)

| Check | Result |
| --- | --- |
| Backend type check, build | Clean |
| `npm test` (unit + database) | 557 / 557 passed (4 new database tests in `browse-exclude-owner.test.ts`: exclusion in plain/word/nearby/city search with matching totals, paging, others still see the owner's items, anonymous use; 12 new route tests in `browse-and-activity.routes.test.ts`: `owner=others` in every kind of search, exclusion taken from the token, `owner=me` unchanged; `/activity` needs a token, is empty for a new user, covers requests/decisions/messages/listings from each side newest first, never includes another user's records, records archiving but not edits, reports an unavailable source, validates `limit`). The database project's `hookTimeout` was raised from 60 s to 180 s: with eight files migrating PGlite alongside the unit tests, set-up timed out under load (the database tests alone passed in 39 s) |
| Frontend type check | Clean |
| Frontend tests (`npx jest`) | 298 / 298 passed (15 new: GPS off with the Android dialog, left off, and iOS Settings; return from Settings re-checks without prompting, and no re-check otherwise; a double tap never stacks prompts; map labels, nearest item previewed without a tap, marker selection, shared-point grouping and stepping; activity wording, data, navigation, empty, error and partial states; My Listings). Feed tests now expect `owner=others` and the "listed; see My Listings" note |
| Android bundle (`expo export --platform android`) | Built |
| Hosted Supabase | **Not tested.** `20261105120000_browse_exclude_owner.sql` is not applied |
| Real devices | **Not tested**, including the permission and GPS dialogs |

### Nearby discovery, Phase 3A (2026-11-04)

| Check | Result |
| --- | --- |
| Backend type check, build | Clean |
| `npm test` (unit + database) | 541 / 541 passed, twice in a row (501 earlier + 16 location database + 24 location route tests). The server-process test's start-up wait was raised from 15 s to 30 s: it had timed out under load, never alone |
| Frontend type check | Clean |
| Frontend tests (`npx jest`) | 283 / 283 passed (19 new: permission explained first and never requested automatically, granted/denied/blocked/unavailable/timeout, radius chips and expansion, manual neighbourhood, city-wide and all areas, GPS movement threshold, foreground-only watching, map fallback/markers/preview/expansion, pickup spot set/denied/kept/removed in the lend form) |
| Android bundle (`expo export --platform android`) | Built (includes `react-native-maps` and `expo-location`) |
| Hosted Supabase | **Not tested.** The migration is not applied |
| Real devices | **Not tested** |

### Chat, Phase 2C (2026-11-02)

| Check | Result |
| --- | --- |
| Backend type check, build | Clean |
| `npm test` (unit + database) | 501 / 501 passed (445 earlier + 23 chat database + 18 chat route + 15 socket tests); the server-process test now also checks that the real entry point refuses an unauthenticated socket |
| Frontend type check | Clean |
| Frontend tests (`npx jest`) | 264 / 264 passed (24 chat tests: conversation list, conversation screen, send/retry/fallback, reconnect, older messages, Open chat, lender redirect after accept, connection handling; plus one updated borrow-request test) |
| Hosted Supabase | **Not tested.** Neither the borrow-request nor the chat migration is applied to the dev project |
| Real devices | **Not tested.** Two-device steps are in API.md |

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
