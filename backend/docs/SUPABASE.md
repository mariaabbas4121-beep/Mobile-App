# Supabase: data model, security and setup

## Data model

Supabase Auth (`auth.users`) owns identity and credentials. Passwords, tokens and OTPs never touch application tables. The application stores:

| Table | Holds | Written by |
| --- | --- | --- |
| `profiles` | One row per user: display name, city, neighborhood, bio, avatar path, verified and pending phone, account status, profile-completed timestamp | Signup trigger; the user (four columns only); the server |
| `user_verifications` | One current row per user per type (`email`, `phone`, `identity`) with status, provider, opaque provider reference, timestamps | Triggers and the server only |
| `audit_events` | Append-only log of security events with small, non-sensitive metadata | Triggers and the server only |
| `listings` | Items offered for lending: title, description, category, condition, optional value/terms/area/city, availability, Teach Me flag, tags, `archived_at`, and the approximate public pickup point (`public_latitude`, `public_longitude`; written only by the database) | The owner (with their own token); the public point only via `set_listing_location()` |
| `listing_locations` | The precise pickup spot of a listing | Owner only, through `set_listing_location()` / `clear_listing_location()`; readable by the owner only |
| `location_privacy_offsets` | One secret displacement (bearing, 200–400 m) per owner, used to derive public points | Nobody: RLS on, no policies, no grants to API roles |
| `borrow_requests` | Requests to borrow a listing for inclusive dates: listing, lender (= listing owner), borrower, dates, optional message, status, decision/cancel times | The borrower (create, cancel) and lender (accept, decline), each with their own token |
| `conversations` | One private chat per accepted borrow request: request, listing, borrower, lender (copied from the request), each side's last-read time, last message time | Created by the accept trigger or `open_conversation()`; never written by users |
| `messages` | Text messages: conversation, sender, client id (idempotency key), body (1–2000 characters, not blank), time | Participants, each with their own token; immutable |
| `listing_images` | Photo metadata: listing, owner, Storage path, type, size. Files live in the private Storage bucket `listing-images` | The owner |

**Onboarding is modelled as independent records**, not one sequential state. Each verification has its own status (`not_started`, `pending`, `verified`, `rejected`, `expired`, `revoked`); profile completion is a server-maintained timestamp; account status (`active`, `restricted`, `suspended`, `deletion_pending`) is separate. `GET /auth/status` derives the onboarding stage from these.

**Verification transitions** are enforced by a trigger. Re-asserting the same status is always allowed; the other allowed changes are:

| From | To |
| --- | --- |
| `not_started` | `pending`, `verified` |
| `pending` | `verified`, `rejected`, `expired`, `not_started` |
| `verified` | `revoked`, `expired` |
| `rejected`, `expired`, `revoked` | `pending` |

Every status change writes an `audit_events` row, so history is kept although the verification table holds only the current state. A provider reference cannot be attached to two users.

**Nothing sensitive is stored:** no CNIC numbers or images, no OTPs, no raw provider payloads.

### Phone verification

Supabase Auth's phone-change flow sends and checks the SMS code (see [API.md](API.md#phone-verification)). The application tables record only the outcome:

| Column | Holds |
| --- | --- |
| `profiles.phone_e164` | The verified number (E.164). Kept, with `phone_verified_at` cleared, if the verification is later revoked |
| `profiles.phone_verified_at` | When Supabase Auth confirmed it. A partial unique index allows each number to be verified on one profile only |
| `profiles.pending_phone_e164` | The number a code was last requested for through the API. Never treated as verified |
| `profiles.phone_otp_sent_at` | When the API last asked Supabase to send a code (resend cooldown, shared by all API instances) |
| `user_verifications` (type `phone`) | Status, `verified_at`, `provider_name = 'supabase_auth'` |

The API changes these only through `security invoker` functions that `service_role` alone may execute. Clients cannot execute them and cannot write any phone column:

| Function | Does |
| --- | --- |
| `phone_verification_begin(user, cooldown)` | Locks the profile row and reserves one SMS send, or returns the seconds left in the cooldown. Refuses suspended and deletion-pending accounts (`PV403`) |
| `phone_verification_release(user)` | Undoes a reservation when nothing was sent |
| `phone_verification_pending(user, phone, resend)` | Records the requested number; moves the status to `pending` unless a number is already verified |
| `phone_verification_complete(user, phone, verified_at)` | Refuses unless `phone` is the pending number (`PV409`). Withdraws any stale verified claim on that number by another profile, then records `verified` |
| `phone_verification_failed(user, reason)` | Audits a rejected code; never changes the status |
| `phone_verification_revoke(user)` | `verified` → `revoked` when Supabase Auth no longer backs the result |

Audit events: `verification.phone_code_requested`, `verification.phone_code_resent`, `verification.phone_code_rejected` (with `reason`), `verification.phone_changed`, `verification.phone_superseded`, plus the generic `verification.status_changed`. None contains the number, the code or a token.

### Triggers on `auth.users`

| Trigger | Does |
| --- | --- |
| `on_auth_user_created` | In the signup transaction: creates the profile (using `display_name` from signup metadata only if valid), creates the three verification rows (email `pending`, or `verified` if already confirmed), and writes `auth.user_registered`. Idempotent: retries cannot duplicate rows, and bad metadata cannot fail signup. |
| `on_auth_user_email_confirmed` | When Supabase confirms the email: marks the email verification `verified` with Supabase's timestamp. |

All functions run with an empty `search_path` and fully qualified names, and cannot be called through the Data API.

### Pickup locations and nearby search (Phase 3A)

- The precise spot lives in `listing_locations`. The `listings` table is readable through the public API key, so the precise spot is deliberately kept off it.
- `set_listing_location(listing, lat, lng)` (SECURITY DEFINER) checks that the caller owns the unarchived listing and is `active`. It then stores the spot and writes the public point: the spot moved by the owner's secret offset (created at random on first use, never changed), rounded to 3 decimals. `clear_listing_location(listing)` removes both.
- One offset per owner, not per listing, so averaging several listings from the same home does not converge on it, and re-saving the same spot gives the same public point.
- `search_listings(...)` gained `p_latitude`, `p_longitude`, `p_radius_km` (clamped to 0.1–50) and `p_city`. Nearby filtering uses a latitude/longitude bounding box (served by `listings_public_point_idx`), then the haversine distance (`distance_km()`) on the **public** point, so results and distances reveal nothing beyond what is already public. Invalid or incomplete coordinates match nothing. The longitude box is skipped where it would wrap ±180°.
- **No PostGIS.** The B-tree bounding box plus haversine is accurate to well under 1% at these distances, needs no extension, and runs on the local PGlite tests. PostGIS can replace it later without changing the API.
- The migration backfills `listings.city` from each owner's profile city (triggers paused, so `updated_at` is untouched).

| Role | `listing_locations` | `location_privacy_offsets` |
| --- | --- | --- |
| `anon` | none | none |
| `authenticated` | read own (`listing_id, latitude, longitude, updated_at`); writes only through the functions | none |
| `service_role` | full | full |

### Listings

- Listings are **archived, never deleted** by users (`archived_at`, stamped by the database clock; one-way). This keeps them available for borrow history later.
- `availability` is a simple owner-controlled flag (`available` / `unavailable`). Date-based reservations are Phase 2B.
- At most 5 photos per listing (trigger, serialised with an advisory lock). Each photo row's path must be `<owner_id>/<listing_id>/<uuid>.<jpg|png|webp>`, and a composite foreign key ties it to a listing **owned by the same user**.
- `search_listings(...)` (SECURITY INVOKER, so RLS applies) does filtering, word search, sorting and paging, and returns `{ total, items }`.
- Two small SECURITY DEFINER helpers expose only what discovery needs: `listing_owner_is_listable(owner)` (boolean: account active or restricted) and `listing_owner_name(owner)` (display name, only for the caller or owners with a listing on show).

| Role | `listings` | `listing_images` | Storage `listing-images` |
| --- | --- | --- | --- |
| `anon` | read unarchived listings of owners in good standing | read rows of visible listings | read (signed URLs) files referenced by a visible image row |
| `authenticated` | the same, plus all own listings; insert own while `active`; update own unarchived listing while `active`/`restricted` (column grants exclude `owner_id`, `created_at`); no delete | the same, plus insert into own unarchived listing while `active`; delete own | the same, plus upload into `<own id>/<own unarchived listing id>/`; read and delete anything in `<own id>/` |
| `service_role` | full | full | (Supabase default) |

The bucket is **private** with a 5 MB limit and `image/jpeg`, `image/png`, `image/webp` only; the API enforces the same and also checks the file's first bytes.

### Borrow requests

- Lifecycle `pending` → `accepted` | `declined` | `cancelled`; the three outcomes are final. A trigger enforces the transitions and who makes them (lender accepts/declines, borrower cancels; `auth.uid()` from the caller's token), stamps `decided_at` / `cancelled_at`, and forbids changing anything else about a request.
- The lender is never chosen by the client: the insert trigger copies the listing's owner, and the composite foreign key `(listing_id, lender_id) → listings(id, owner_id)` guarantees it.
- **No double booking:** `exclude using gist (listing_id with =, period with &&) where (status = 'accepted')`, where `period = daterange(start_date, end_date, '[]')` (both ends inclusive). Needs the `btree_gist` extension, which the migration enables in the `extensions` schema. Concurrent accepts of overlapping requests cannot both commit; the loser fails with SQLSTATE `23P01`.
- Insert checks (trigger): listing exists, not archived, `available`, owner in good standing; not your own listing; start today..today+90 in **Asia/Karachi** (`public.borrow_today()`); no overlap with accepted requests. Table checks: end ≥ start, at most 30 days, message ≤ 500 characters. One pending request per borrower per listing (partial unique index).
- Archiving a listing declines its pending requests (trigger); accepted ones are kept.
- `list_borrow_requests(...)` and `listing_booked_ranges(...)` are SECURITY DEFINER read helpers: the first returns only rows where the caller is borrower or lender (with both display names and the listing title); the second returns accepted date ranges only, never who booked them.
- Custom SQLSTATEs `NSB01`–`NSB05` are mapped to API codes in `src/borrow/supabase-borrow.repository.ts`.

| Role | `borrow_requests` |
| --- | --- |
| `anon` | none |
| `authenticated` | read rows where borrower or lender; insert as borrower while `active` (columns `listing_id, borrower_id, start_date, end_date, message`); update `status` only, as a participant in good standing, subject to the trigger; no delete |
| `service_role` | full, still subject to the triggers and the exclusion constraint |

### Chat

- Accepting a borrow request creates its conversation in the same transaction (trigger `borrow_requests_open_conversation`). `open_conversation(request_id)` gets or creates it for a participant of an accepted request; it returns null for anyone else and raises `NSC01` for a request that is not accepted. `borrow_request_id` is unique, so neither can create a duplicate. The migration also backfills conversations for requests that were already accepted.
- Participants are copied from the request by the database. Request details cannot change after creation (borrow-request update trigger), so the copy cannot drift.
- `send_message(conversation_id, client_id, body)` is SECURITY INVOKER: the insert policy decides. You can send only as yourself, only in your own conversation, only while its request is `accepted`, and only while your account is `active` or `restricted`. `(conversation_id, sender_id, client_id)` is unique; a retry returns the stored row with `created = false`, and the same id with different text raises `NSC03`.
- Messages have no update or delete grants. `id` and `created_at` are not insertable, so the database always sets them.
- `list_messages(...)` is SECURITY INVOKER (row-level security filters it); it pages newest first with a `(created_at, id)` cursor. `list_conversations(...)` is SECURITY DEFINER to read the other participant's display name; it returns only the caller's conversations. `mark_conversation_read(...)` updates only the caller's own read time.
- Archiving a listing does not close its conversations (accepted requests are kept).
- Custom SQLSTATEs `NSC01`–`NSC03` are mapped to API codes in `src/chat/supabase-chat.repository.ts`.

| Role | `conversations` | `messages` |
| --- | --- | --- |
| `anon` | none | none |
| `authenticated` | read where borrower or lender | read in own conversations; insert (columns `conversation_id, sender_id, client_id, body`) per the policy above; no update or delete |
| `service_role` | full | full |

## Access control

Defence in depth: the API checks first, and the database enforces the same rules independently, so a client holding a valid token and calling Supabase directly gains nothing.

| Role | `profiles` | `user_verifications` | `audit_events` |
| --- | --- | --- | --- |
| `anon` (publishable key, no user) | none | none | none |
| `authenticated` (a user's token) | read own row; update own `display_name`, `city`, `neighborhood`, `bio`, `avatar_path` while `active` or `restricted` | read own rows | none |
| `service_role` (secret key) | read, insert, update, delete | read, insert, update, delete | read, insert only |

- Row-Level Security is enabled on all three tables. Column-level grants limit **which** columns a user can change; RLS policies limit **whose** row and **when**.
- `audit_events` cannot be updated, deleted or truncated by any role, including the table owner.
- Supabase grants every privilege on new tables to the API roles by default. The migrations revoke those and grant back only the table above. Keep doing this in future migrations.

### Keys

| Key | Where | Notes |
| --- | --- | --- |
| Publishable (`sb_publishable_…`) | `backend/.env`, and `frontend/.env` for Google sign-in only | Public by design. Used for Auth calls and per-user database access; RLS applies |
| Secret (`sb_secret_…`) | `backend/.env` only | Bypasses RLS. Use only for server operations whose authorization the API has already checked. Never log it, return it, or put it in the app or in any `EXPO_PUBLIC_*` variable. |
| Personal access token (`sbp_…`) | Only while running migrations | Can manage **every** project in your account. Revoke it after use. |
| Database password | Only while linking for migrations | |

The mobile app holds only the project URL and the publishable key, and uses them only for the Google sign-in handshake; everything else goes through the API.

### Administrative actions

There are no admin endpoints yet. When they are added, mount `requireAuth` then `requireRole('admin')`. Roles come from the user's Supabase `app_metadata.roles`, which only the secret key can write (dashboard or admin API), never from the request. Changes to account status or verification results must go through the server using the secret key, and are audited automatically.

## Migrations

Migrations live in `supabase/migrations/` and are applied with the Supabase CLI (a dev dependency). **Never edit a migration that has been applied; add a new one.**

| Migration | Purpose |
| --- | --- |
| `20261020120000_auth_foundation.sql` | Types, tables, triggers, RLS, grants |
| `20261020130000_tighten_service_role_grants.sql` | Makes `audit_events` append-only for `service_role` too; blocks `TRUNCATE` |
| `20261108120000_pickup_handover.sql` | Pickup authorizations (hashed one-time codes), handovers (one per request), handover photos and the private `handover-evidence` bucket, the handover audit trail, and the SECURITY DEFINER functions that check and record them atomically. `borrow_requests` is unchanged. **Not applied to the dev project.** Until it is, the pickup endpoints answer `503 DATABASE_UNAVAILABLE`, and Activity lists `handovers` under `unavailable` |
| `20261105120000_browse_exclude_owner.sql` | Replaces `search_listings` with one more optional parameter, `p_exclude_owner_id`, for `owner=others` (Browse leaves out the caller's own listings). Function only: no table, column, policy or data change. **Not applied to the dev project.** Until it is, signed-in browsing (`owner=others`, which the app sends from Phase 3A.1) answers `503 DATABASE_UNAVAILABLE`; `owner=me`, item pages and anonymous browsing keep working |
| `20261104120000_listing_locations.sql` | Pickup spots (private), per-owner privacy offsets, public approximate points and city on listings, nearby and city search in `search_listings`, city backfill. Applied to the dev project (reported by the user, 2026-11-04; not re-checked by Claude) |
| `20261103120000_chat.sql` | Conversations and messages, the accept trigger, chat functions, RLS. Needs `20261102120000_borrow_requests.sql` first. **Not applied to the dev project.** Until it is, chat endpoints answer `503 DATABASE_UNAVAILABLE` |
| `20261102120000_borrow_requests.sql` | Borrow requests, lifecycle triggers, the no-overlap exclusion constraint (`btree_gist`), RLS and read helpers. **Not applied to the dev project** (checked 2026-11-02: `borrow_requests` returns `PGRST205`). Until it is, borrow endpoints answer `503 DATABASE_UNAVAILABLE` |
| `20261028120000_listings.sql` | Listings, listing photos, `search_listings`, RLS, the private `listing-images` bucket and its Storage policies. **Not yet applied to the dev project** (checked 2026-10-28: `listings` returns `PGRST205`, the bucket `NoSuchBucket`). Until it is, listing reads answer `503 DATABASE_UNAVAILABLE` and photo uploads `503 STORAGE_NOT_CONFIGURED` |
| `20261026120000_phone_verification.sql` | Phone verification columns and `phone_verification_*` functions (service role only). **Not yet applied to the dev project** (re-checked 2026-10-28: `profiles.pending_phone_e164` returns `42703 undefined_column`). Until it is, every phone endpoint answers `503 PHONE_VERIFICATION_NOT_CONFIGURED` with `reason: database_migration_missing` |

Applying to the dev project, from `backend/`:

```powershell
npm.cmd run db:login                                    # opens a browser
npm.cmd run db:link -- --project-ref <ref from SUPABASE_URL>   # asks for the database password
npm.cmd run db:migrations                               # local vs remote history
npm.cmd run db:push:dry                                 # shows what would be applied
npm.cmd run db:push
```

Always read the dry run first and confirm the linked project is the intended one. Create a new migration with `npm.cmd run db:new -- <name>`, then test it with `npm.cmd run test:db` before pushing. `supabase/config.toml` configures a local Supabase stack only; it is not pushed to the hosted project.

## Dashboard checklist

### Required

- [ ] **Authentication → Sign In / Providers → Email:** *Confirm email* **on** for production. **The dev project currently has it off** (`mailer_autoconfirm: true`, 2026-10-28).
  - *Off* (acceptable on a development project for demos): signup returns `201` with a session and the app signs straight in; no email or SMTP is needed. But signing up with a registered address returns `409 EMAIL_ALREADY_REGISTERED`, so **anyone can find out which emails have accounts**, and nobody has proved they own the address. Three live signup tests are skipped while it is off.
  - *On*: signup returns the same `202` whether or not the address exists, and login waits for the emailed link. Needs custom SMTP for real users (below).
  - Google sign-in is unaffected either way: Google has already verified the address, and no email is sent.
- [ ] **Password policy:** minimum length **8**, requiring letters and digits (the API enforces the same).
- [ ] **Authentication → URL Configuration:** set the Site URL and add `AUTH_EMAIL_REDIRECT_URL` and **every app redirect** to Redirect URLs: `neighborshare://auth/callback` (development/store builds), `exp://<LAN IP>:8081/--/auth/callback` (Expo Go) and `http://localhost:8081/auth/callback` (Expo web). See [frontend/README.md](../../frontend/README.md#three-different-redirect-settings). On 2026-10-28 only the Expo Go URL was allowed.
- [ ] **Custom SMTP** (Authentication → Emails → SMTP Settings). The built-in mailer sends only to project team members and a few emails per hour; without custom SMTP, real users get `503 EMAIL_DELIVERY_UNAVAILABLE`.

### Recommended

- [ ] **Authentication → Rate Limits:** review the email-send limit (raise it on the dev project so the signup tests can run).
- [ ] Revoke the personal access token when not running migrations, and clear `SUPABASE_DB_PASSWORD` from `.env`.
- [ ] Use a separate Supabase project for production; never set `INTEGRATION_PROJECT_REF` there.

### Pickup and handover (Phase 3B.1)

- [ ] Apply `20261108120000_pickup_handover.sql` (after `20261105120000_browse_exclude_owner.sql`): `npm.cmd run db:push:dry`, check the pending list, then `npm.cmd run db:push`.
- [ ] Check in the dashboard that Storage now has a **private** bucket `handover-evidence` (5 MB, JPEG/PNG/WebP).
- [ ] Optional: `PICKUP_AUTHORIZATION_TTL_HOURS` in `backend/.env` (1–168, default 24).

How it is protected:

- Nobody reads `pickup_authorizations`, `handovers` or `handover_events` directly. Every API role is refused, and all access goes through functions that take the user from `auth.uid()`.
- Only code hashes are stored.
- Each write function locks the borrow request row (`FOR UPDATE`) and rechecks the role, request status, code and expiry in the same transaction. Unique constraints back this up: one handover per request, and one active authorization per request.
- Evidence files live under `<request>/<handover>/` and are readable only by the two participants. Only the confirming lender can write them, within 24 hours.

### Browse without your own listings (Phase 3A.1)

- [ ] Apply `20261105120000_browse_exclude_owner.sql`: `npm.cmd run db:push:dry`, check that only this file is pending, then `npm.cmd run db:push`. It only replaces `search_listings` and is safe to apply while the app is in use: calls without the new parameter behave exactly as before.
- [ ] No extension, environment variable or dashboard setting is needed. `GET /api/v1/activity` needs no migration (it reads existing tables).

### Nearby discovery (Phase 3A)

- [ ] Apply `20261104120000_listing_locations.sql` after the borrow-request and chat migrations: `npm.cmd run db:push:dry`, check the order, then `npm.cmd run db:push`. It replaces `search_listings`; the previous app build keeps working because the new parameters are optional.
- [ ] No extension, environment variable or dashboard setting is needed.

### Chat (Phase 2C)

- [ ] Apply the borrow-request migration first (below), then `20261103120000_chat.sql`: run `npm.cmd run db:push:dry`, check that it lists both files in that order, then `npm.cmd run db:push`. If the CLI is not logged in, run `npm.cmd run db:login` and `npm.cmd run db:link` first.
- [ ] No new environment variables and no dashboard settings. Supabase Realtime is not used; Socket.IO runs in the API.
- [ ] Afterwards, check with two accounts (see [API.md](API.md#testing-chat-with-two-accounts)).

### Borrow requests (Phase 2B)

- [ ] Apply `20261102120000_borrow_requests.sql` (`npm.cmd run db:push:dry`, read it, then `npm.cmd run db:push`). It runs `create extension if not exists btree_gist with schema extensions`; this is available on every Supabase project.
- [ ] No new environment variables, no dashboard toggles.

### Listings (Phase 2A)

- [ ] Apply `20261028120000_listings.sql` (see [Migrations](#migrations)). `db:push` will also apply the phone migration if it is still pending; read the dry run.
- [ ] After pushing, check **Storage → Buckets**: `listing-images` exists, is **not public**, 5 MB limit, the three image types. Check **Storage → Policies** shows the three `listing-images:` policies on `objects`.
- [ ] No new environment variables. The API uses the publishable key with each caller's token; `SUPABASE_SECRET_KEY` is not needed for listings.

### For later milestones

- [ ] **Google OAuth:** implemented in the app with PKCE and a deep-link callback. The provider settings, Google Cloud redirect URI and Supabase Redirect URLs it needs are listed in [frontend/README.md](../../frontend/README.md#google-sign-in).
- [ ] **Phone verification:** code complete; needs the migration applied **and** the Phone provider enabled (below). Test numbers are enough for development.
- [ ] **Identity (CNIC) verification:** needs a chosen identity provider; store only its opaque reference, never document numbers or images.

## SMS setup for phone verification

**State on 2026-10-28** (read from the project's public `GET /auth/v1/settings` and a live API call): the **Phone provider is disabled** (`external.phone: false`), even though test phone numbers may be saved in the dashboard. Phone confirmations are on (`phone_autoconfirm: false`). The `sms_provider: twilio` value it reports is Supabase's default, not a configured provider. Custom SMTP is for email only and does not enable SMS. The phone migration is **also not applied** ([Migrations](#migrations)). Live results: `GET /verification/phone` → `503 PHONE_VERIFICATION_NOT_CONFIGURED` (`database_migration_missing`); `POST /verification/phone/start` → `503 PHONE_VERIFICATION_NOT_CONFIGURED` (`phone_provider_disabled`). Both must be fixed; either alone still fails.

Check the provider state yourself at any time (the publishable key is public):

```powershell
cd backend
node --env-file=.env -e "fetch(process.env.SUPABASE_URL+'/auth/v1/settings',{headers:{apikey:process.env.SUPABASE_PUBLISHABLE_KEY}}).then(r=>r.json()).then(s=>console.log({phone:s.external.phone,phone_autoconfirm:s.phone_autoconfirm,mailer_autoconfirm:s.mailer_autoconfirm}))"
```

Expect `phone: true, phone_autoconfirm: false` before testing phone verification.

### Development with test phone numbers (no SMS)

Supabase test numbers (Authentication → Sign In / Providers → Phone → *Test Phone Numbers and OTPs*, entered as `923001234567=123456`) work with the API's flow as it is: no development bypass is needed or provided. Checked against the Supabase Auth source (`internal/api/phone.go`, `verify.go`, `user.go`, `conf/configuration.go`) on 2026-10-28, not yet against the live project:

- The authenticated phone change the API uses (`PUT /auth/v1/user` with `phone`) goes through the same code path as phone sign-in. For a configured test number it stores the fixed OTP and **skips the SMS provider entirely**, so no text is sent and no provider is contacted.
- `verifyOtp({ type: 'phone_change' })` accepts the fixed OTP for that number, and Supabase then marks the phone confirmed exactly as for a real code. The API's checks (same user, number confirmed in Auth, number requested through the API) are unchanged.
- Numbers are matched without `+` and spaces on both sides, so the app's `+923001234567` matches a dashboard entry `923001234567`.
- Requirements that still apply: the **Phone provider must be enabled** (and the dashboard may require SMS provider fields to save it); phone confirmations must stay on; *SMS max frequency* still applies between requests; the OTP must be `PHONE_OTP_LENGTH` digits (default 6); an optional test-OTP expiry date in the dashboard ends them.
- A number that is **not** in the test list goes to the real SMS provider. With placeholder credentials, that answers `503 SMS_DELIVERY_UNAVAILABLE`.

> Test numbers are a project-wide Supabase setting with a fixed, shared code: anyone who knows one can "verify" it on their account. **Never configure them on a production project.**

### Steps

1. **Apply the migration** (see [Migrations](#migrations)): `20261026120000_phone_verification.sql`. Read the dry run first.
2. **Choose and open an SMS provider account** (see below). Register the sender ID or number the provider and destination country require before going live.
3. **Authentication → Sign In / Providers → Phone:**
   - Enable the Phone provider and choose the SMS provider; enter its credentials **in the dashboard only**. They never go in `backend/.env`, the app or Git.
   - Keep **phone confirmations on**. If they are off, Supabase would accept numbers without a code; the API detects this and refuses to verify anyone.
   - **SMS OTP length:** match `PHONE_OTP_LENGTH` (default 6).
   - **SMS OTP expiry:** the default is 60 seconds. Raise it (e.g. 300 s) if users on slow networks report expired codes.
   - SMS template: something like `Your NeighborShare code is {{ .Code }}`. Do not add links.
   - **Allow new users to sign up with phone: off.** Accounts are created with email or Google; phone is a verification step only.
4. **Authentication → Rate Limits:** review *SMS sent per hour* (project-wide) and *token verifications* (per IP). All API traffic reaches Supabase from the API server's IP, so the per-IP verification limit is shared by every user; raise it before launch.
5. Set **SMS max frequency** no higher than `PHONE_OTP_RESEND_COOLDOWN_SECONDS` (default 60 s). If Supabase's interval is longer, some resends fail with `429`.
6. Set `PHONE_ALLOWED_COUNTRY_CODES` in `backend/.env` to the countries you serve (e.g. `92`). This limits SMS-pumping fraud, where attackers trigger texts to premium-rate numbers abroad. Also enable the provider's own geographic permissions.
7. Do a **deliberate manual test with your own phone** ([TESTING.md](TESTING.md#manual-phone-verification-test)). Automated tests never send SMS.

> **Security note:** enabling the Phone provider also enables **SMS sign-in** in Supabase Auth (`signInWithOtp({ phone })`) for any user whose phone is confirmed. The API offers no such endpoint, but a client holding the publishable key can call Supabase directly. That makes the phone number a second way into an account, exposed to SIM-swap. Weigh this before launch. Mitigations: keep phone signups off, keep Auth's per-IP OTP limits and CAPTCHA in mind, and check whether a Supabase [Send SMS hook](https://supabase.com/docs/guides/auth/auth-hooks/send-sms-hook) can tell phone-change messages from sign-in messages (not verified here). If phone sign-in is unacceptable, phone verification would need a different design.

### Provider options (initial market: Pakistan)

Supabase's built-in SMS providers are Twilio, Twilio Verify, MessageBird (Bird), Vonage and Textlocal ([docs](https://supabase.com/docs/guides/auth/phone-login)). A **Send SMS hook** can instead call any provider over HTTP, including Pakistani aggregators. None has been chosen or tested; verify current coverage, prices and registration rules with the provider before committing.

| Option | Fits | Notes for Pakistan |
| --- | --- | --- |
| **Twilio** (Programmable Messaging) | Simplest built-in setup; global coverage | Twilio's [Pakistan guidelines](https://www.twilio.com/guidelines/pk/sms) say not every operator supports numeric sender IDs, and sender IDs may be overwritten to keep delivery working. Check whether a registered alphanumeric sender ID is required |
| **Twilio Verify** | Built-in; Twilio manages the code and sender selection | Supabase keeps the trust boundary, but codes are generated by Twilio. Per-verification pricing |
| **Vonage** / **MessageBird (Bird)** | Built-in alternatives | Confirm Pakistan delivery rates and sender rules with each |
| **Textlocal** | Built-in, but UK-focused | Not suitable for Pakistan |
| **Local aggregator via Send SMS hook** | Often better local delivery and price | Needs a small hook function and provider credentials kept in Supabase secrets. Other providers' documentation ([example](https://www.infobip.com/docs/essentials/mena-registration/pakistan-letter-of-authorization-loa-guidelines.md)) describes PTA registration requirements for alphanumeric senders; confirm the current rules directly |

Do not assume any provider reaches every operator or supports every sender ID or template. Test real delivery to each major Pakistani operator (Jazz, Zong, Telenor, Ufone) before launch.
