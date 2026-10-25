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
| `server.test.ts` | Starts `src/server.ts` as a process: boots with valid config; exits 1 with a sanitized message on invalid config |

## Database tests (`tests/db`)

`tests/db/pglite.ts` creates a fresh database, adds a minimal stand-in for Supabase (roles `anon`, `authenticated`, `service_role`; `auth.users`; `auth.uid()`; Supabase's default grants), then applies every file in `supabase/migrations` in order. `asUser()` runs SQL as the `authenticated` role with a chosen user id, the way Supabase runs a request carrying that user's token.

They cover signup provisioning, retries and bad metadata, email confirmation, verification transitions, provider-reference uniqueness, per-user read and update rules, protected columns, suspended accounts, anonymous access, the append-only audit log (including `TRUNCATE`), and user deletion.

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

## Not covered by automated tests

| Area | Why | How to verify manually |
| --- | --- | --- |
| Email delivery and the link in the email | Needs a real mailbox and SMTP | Sign up through the API with your own address, open the email, click the link, then log in and check `/status` |
| Expiry of an untampered access token | Takes an hour in real time | Log in, wait until `expiresAt`, call `/me`: expect `401 INVALID_TOKEN` |
| Rate limits across several API instances | Counters are per process | Only relevant once a shared store is added |
| Google sign-in end to end | Needs a device, a browser and Google consent | See `frontend/README.md#google-sign-in` |
| Phone and identity verification | Not implemented | — |

## Adding tests

- Unit: build the app with `testApp()` from `tests/helpers.ts`; its `gateway` and `profiles` are spies you can override per test.
- Database: `createMigratedDb()`, `createAuthUser()`, `asUser()`, `asRole()` and `sqlState()` from `tests/db/pglite.ts`.
- Integration: use `TestUsers` from `tests/integration/setup.ts` for every user you create, so cleanup is guaranteed.
