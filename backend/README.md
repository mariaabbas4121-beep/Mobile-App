# NeighborShare — API (backend)

REST API for NeighborShare: Node.js 22, Express 5 and strict TypeScript, backed by Supabase (Auth, PostgreSQL, Storage).

The app talks to this API for everything except one step of Google sign-in: it uses the Supabase SDK with the **publishable** key only to start the Google flow and exchange its one-time code for a session (see [frontend/README.md](../frontend/README.md#google-sign-in)). The resulting tokens are then used with this API like any other session. The secret key and every other credential stay in this backend's environment.

## What is implemented

| Area | Status |
| --- | --- |
| Email and password signup, login, refresh, logout, current user | Implemented and tested live |
| Email confirmation (Supabase's confirmation email) | Implemented; live-tested with confirmation tokens, real email delivery needs custom SMTP |
| Onboarding status (`/auth/status`) and profile editing | Implemented and tested live |
| Database schema, provisioning triggers, RLS and grants | Applied to the dev project and tested live |
| Rate limiting, account-status and role checks, sanitized errors and logs | Implemented and tested |
| Google sign-in | Runs in the app through Supabase Auth (PKCE + deep link); this API accepts the resulting tokens. Code complete; end-to-end test on a device still pending |
| Phone verification (Supabase Auth phone-change OTP) | Implemented and unit/database tested. **Needs** the `20261026120000` migration applied and an SMS provider configured in Supabase ([setup](docs/SUPABASE.md#sms-setup-for-phone-verification)); real SMS delivery not yet tested |
| Identity (CNIC) verification | **Not implemented**: schema only; no provider chosen |

## Documentation

| Document | For |
| --- | --- |
| [docs/API.md](docs/API.md) | Endpoint contracts, error codes, rate limits: what the app integrates against |
| [docs/SUPABASE.md](docs/SUPABASE.md) | Data model, access control, keys, migrations, dashboard checklist |
| [docs/TESTING.md](docs/TESTING.md) | Test suites, safety guards, current results, manual checks |

## Getting started

```powershell
cd backend
npm.cmd install
Copy-Item .env.example .env   # then fill in the Supabase values
npm.cmd run dev
```

The API listens on `http://localhost:4000` (or `PORT`). Check `http://localhost:4000/api/v1/health`.

The server **refuses to start** if the configuration is invalid. It prints which variables are wrong and why, never their values.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start with auto-restart (`tsx watch`) |
| `npm run build` / `npm start` | Compile to `dist/`, then run the compiled server |
| `npm run typecheck` | Strict TypeScript check |
| `npm test` | Unit and database tests (offline) |
| `npm run test:integration` | Live tests against the dev Supabase project (see [docs/TESTING.md](docs/TESTING.md)) |
| `npm run test:all` | Type check and every suite |
| `npm run db:*` | Supabase CLI migration commands (see [docs/SUPABASE.md](docs/SUPABASE.md#migrations)) |

## Environment variables

Defined and validated in [src/config/env.ts](src/config/env.ts); template in [.env.example](.env.example).

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | Yes | Project URL (`https://<ref>.supabase.co`); https required in production |
| `SUPABASE_PUBLISHABLE_KEY` | Yes | `sb_publishable_…`; Auth calls and per-user database access |
| `SUPABASE_SECRET_KEY` | No | `sb_secret_…`; bypasses RLS. Server-only; needed by phone verification (to record results) and integration tests |
| `PHONE_OTP_RESEND_COOLDOWN_SECONDS` | No | Seconds between SMS codes per user, 30–3600 (default `60`). At least Supabase's SMS max frequency |
| `PHONE_OTP_LENGTH` | No | Digits in the SMS code, 6–10 (default `6`). Must match Supabase's SMS OTP length |
| `PHONE_ALLOWED_COUNTRY_CODES` | No | Comma-separated calling codes SMS may go to, e.g. `92`. Empty allows all; set it in production |
| `PORT` | No | Default `4000` |
| `NODE_ENV` | No | `development` (default), `test` or `production` |
| `LOG_LEVEL` | No | Default `info` (`silent` in tests) |
| `FRONTEND_ORIGIN` | No | Comma-separated browser origins for CORS (default `http://localhost:8081`). Native apps are unaffected. |
| `TRUST_PROXY_HOPS` | No | Reverse proxies in front of the API, for correct client IPs (default `0`) |
| `AUTH_EMAIL_REDIRECT_URL` | No | Where the confirmation link lands; must be in Supabase's Redirect URLs |
| `AUTH_OAUTH_REDIRECT_URL` | No | Reserved; not used (the app supplies its own OAuth redirect) |
| `INTEGRATION_PROJECT_REF` | Tests only | Must equal the ref in `SUPABASE_URL` for integration tests to run; dev/test projects only |
| `INTEGRATION_SIGNUP_EMAIL` | Tests only | Optional mailbox for the real-signup test |

`.env` is gitignored. Never commit it. The only Supabase values the app may hold are the project URL and the **publishable** key; never copy the secret key into the frontend or any `EXPO_PUBLIC_*` variable.

## Security model in brief

- **Supabase Auth is the identity source.** The API never stores or hashes passwords. Access tokens are validated with Supabase on every request, so logout and revocation take effect immediately. User ids come only from the validated token.
- **Two layers of authorization.** The API checks account status and roles; the database enforces per-user Row-Level Security and column-level grants on its own, which the integration tests verify by calling Supabase directly with user tokens.
- **Users cannot grant themselves anything.** Account status, verification results, roles and audit events are writable only by the server (secret key) or database triggers.
- **Safe failure.** Supabase errors are mapped to fixed codes; responses never contain stack traces, provider messages or submitted values. Supabase calls time out (10 s per request, 12 s per auth operation) and return `503`.
- **Logs** record method, path, status and timing, never headers, bodies, tokens or query strings. Unexpected errors are logged with their message for debugging, so server code must not put secrets into error messages.
- **Timing.** Each request's log line has `responseTime` (ms) and `reqId`, which is the `X-Request-Id` response header. Every Supabase Auth and database call made while serving it is logged with the same `reqId`, its name (`dependency`, e.g. `supabase_auth.get_user`, `database.get_profile`), `durationMs` and `outcome`: at `debug` level normally, at `warn` when it takes 2 s or more. Set `LOG_LEVEL=debug` to see them all. Arguments and results are never logged.
- **Abuse limits** on signup, login (per IP and per account), refresh and confirmation resends, and on phone verification (per IP, per account, per destination number, plus a database-backed resend cooldown).
- **Phone verification trusts only Supabase Auth.** Supabase sends and checks the code. The API records `verified` only after re-reading the user from Supabase with the caller's own token, and only for a number requested through the API. OTPs are never stored or logged. The SMS provider's credentials live in the Supabase dashboard, not here.

## Structure

```text
backend/
├── src/
│   ├── auth/
│   │   ├── auth.types.ts                 API shapes and the gateway/repository interfaces
│   │   ├── auth.schemas.ts               Zod request schemas (password policy, profile fields)
│   │   ├── auth.errors.ts                Supabase error -> API error code mapping
│   │   ├── onboarding.ts                 /status derivation
│   │   ├── supabase-auth.gateway.ts      Supabase Auth calls (with deadlines)
│   │   └── supabase-profile.repository.ts  Database reads/writes as the calling user
│   ├── config/
│   │   ├── env.ts                        Environment validation
│   │   └── supabase.ts                   Supabase clients (anon, per-user, admin) with request timeouts
│   ├── lib/                              AppError, logger
│   ├── middleware/                       auth, account status, rate limits, validation, errors
│   ├── routes/                           health, auth, profile, verification
│   ├── verification/
│   │   ├── phone.ts                      Number parsing, request schemas, masking
│   │   ├── phone.types.ts                Provider and store interfaces
│   │   ├── phone-verification.service.ts The trust rules: when a number may be recorded as verified
│   │   ├── supabase-phone-auth.ts        Supabase Auth phone-change calls and error mapping
│   │   └── supabase-phone-verification.store.ts  Server-only database functions
│   ├── app.ts                            Express app assembly
│   └── server.ts                         Entry point: loads .env, validates, starts
├── supabase/
│   ├── migrations/                       Versioned SQL migrations
│   └── config.toml                       Local Supabase stack settings (not pushed)
├── tests/
│   ├── unit/                             No network
│   ├── db/                               Migrations on PGlite
│   └── integration/                      Live dev project (guarded)
└── docs/                                 API, Supabase, testing
```

## Next steps

1. Configure custom SMTP and the redirect URLs in Supabase ([checklist](docs/SUPABASE.md#dashboard-checklist)).
2. Integrate the Expo app against [docs/API.md](docs/API.md): secure token storage, refresh on `INVALID_TOKEN`, and handling of the confirmation deep link.
3. Finish the Google sign-in dashboard setup and test it on a device ([frontend/README.md](../frontend/README.md#google-sign-in)).
4. Phone verification: apply the `20261026120000` migration, choose and configure an SMS provider ([setup](docs/SUPABASE.md#sms-setup-for-phone-verification)), then run the [manual test](docs/TESTING.md#manual-phone-verification-test).
5. Choose an identity provider for CNIC verification.
6. Before running several API instances, move rate-limit counters to a shared store. (The phone resend cooldown already lives in the database.)
