# Supabase: data model, security and setup

## Data model

Supabase Auth (`auth.users`) owns identity and credentials. Passwords, tokens and OTPs never touch application tables. The application stores:

| Table | Holds | Written by |
| --- | --- | --- |
| `profiles` | One row per user: display name, city, neighborhood, bio, avatar path, phone, account status, profile-completed timestamp | Signup trigger; the user (four columns only); the server |
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

- [ ] **Authentication → Sign In / Providers → Email:** *Confirm email* **on**.
- [ ] **Password policy:** minimum length **8**, requiring letters and digits (the API enforces the same).
- [ ] **Authentication → URL Configuration:** set the Site URL and add `AUTH_EMAIL_REDIRECT_URL` (and later the app's deep link) to Redirect URLs.
- [ ] **Custom SMTP** (Authentication → Emails → SMTP Settings). The built-in mailer sends only to project team members and a few emails per hour; without custom SMTP, real users get `503 EMAIL_DELIVERY_UNAVAILABLE`.

### Recommended

- [ ] **Authentication → Rate Limits:** review the email-send limit (raise it on the dev project so the signup tests can run).
- [ ] Revoke the personal access token when not running migrations, and clear `SUPABASE_DB_PASSWORD` from `.env`.
- [ ] Use a separate Supabase project for production; never set `INTEGRATION_PROJECT_REF` there.

### For later milestones

- [ ] **Google OAuth:** implemented in the app with PKCE and a deep-link callback. The provider settings, Google Cloud redirect URI and Supabase Redirect URLs it needs are listed in [frontend/README.md](../../frontend/README.md#google-sign-in).
- [ ] **Phone verification:** needs an SMS provider and an OTP flow; the schema is ready.
- [ ] **Identity (CNIC) verification:** needs a chosen identity provider; store only its opaque reference, never document numbers or images.
