# Supabase: data model, security and setup

## Data model

Supabase Auth (`auth.users`) owns identity and credentials. Passwords, tokens and OTPs never touch application tables. The application stores:

| Table | Holds | Written by |
| --- | --- | --- |
| `profiles` | One row per user: display name, city, neighborhood, bio, avatar path, verified and pending phone, account status, profile-completed timestamp | Signup trigger; the user (four columns only); the server |
| `user_verifications` | One current row per user per type (`email`, `phone`, `identity`) with status, provider, opaque provider reference, timestamps | Triggers and the server only |
| `audit_events` | Append-only log of security events with small, non-sensitive metadata | Triggers and the server only |

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
