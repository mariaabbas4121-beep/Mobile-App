# NeighborShare — API (backend)

Node.js and Express REST API for NeighborShare, backed by Supabase (PostgreSQL, Auth and Storage). JavaScript with ES modules; requires Node.js 22 or later.

At this stage the API provides only a health check and the Supabase connection setup. Authentication, database tables and feature endpoints come in later phases.

## Architecture: the API is the only path to Supabase

The mobile app talks only to this API. It has no Supabase client and no Supabase keys. Sign-up, sign-in, sessions, database reads and writes, and file storage all go through Express endpoints, and every Supabase key lives only in this backend's environment.

Authentication endpoints planned for the next phase:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/auth/signup` | Register with Supabase Auth (email verification as configured in Supabase) |
| `POST /api/auth/login` | Check credentials with Supabase Auth; return the Supabase-issued session |
| `POST /api/auth/logout` | Revoke the session |
| `POST /api/auth/refresh` | Exchange a refresh token for a new session |
| `GET /api/auth/me` | Return the user identified by a verified access token |

Rules these will follow:

- **Supabase-issued tokens only.** No custom token format. Protected routes verify the `Authorization: Bearer` access token with Supabase (`auth.getClaims()`, which checks the signature against the project's published signing keys), and never trust an unverified JWT.
- **Row-Level Security stays on.** Requests made for a user run with that user's access token, so RLS policies apply. The secret key is used only for specific privileged operations after the backend has checked the caller is allowed. RLS is never disabled as a shortcut.
- **Nothing sensitive is logged.** Passwords, access tokens, refresh tokens and keys never appear in logs or error responses.
- **Session storage on the device.** The app will keep refresh tokens in the platform's secure storage (Keychain/Keystore via `expo-secure-store`), never in AsyncStorage or plain files. That storage is designed together with the auth endpoints.

## Getting started

```powershell
cd backend
npm install
Copy-Item .env.example .env   # optional until you connect Supabase
npm run dev
```

The API listens on `http://localhost:4000` (or `PORT`). It starts without Supabase credentials and prints a warning that Supabase-backed requests will return 503.

In PowerShell, use `npm.cmd` if the execution policy blocks `npm.ps1`.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start with automatic restart on file changes (`node --watch`) |
| `npm start` | Start without file watching |
| `npm test` | Run the tests in `tests/` with Node's built-in test runner |

## Endpoints

| Method and path | Response |
| --- | --- |
| `GET /health` | `200 {"success": true, "message": "NeighborShare API is running"}` |
| `GET /api/health` | Same as `/health` |
| Any unknown route | `404 {"success": false, "message": "Route not found: ..."}` |

The health check confirms the process is running. It does not contact Supabase and reveals no configuration. Every error is returned as `{"success": false, "message": "..."}`; internal errors return `"Internal server error"` and never include stack traces.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | Port to listen on (default `4000`) |
| `NODE_ENV` | `development`, `production` or `test` |
| `FRONTEND_ORIGIN` | Comma-separated browser origins allowed by CORS (default `http://localhost:8081`, Expo web). Native mobile requests are not affected by CORS. |
| `SUPABASE_URL` | Supabase dashboard → Project Settings → Data API → **Project URL** |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase dashboard → Project Settings → API Keys → **Publishable key** (`sb_publishable_...`) |
| `SUPABASE_SECRET_KEY` | Supabase dashboard → Project Settings → API Keys → **Secret key** (`sb_secret_...`). Leave empty until a server-only feature needs it. |

The placeholder values in `.env.example` are not credentials; the server treats them as "not configured".

## Supabase access (`src/config/supabase.js`)

- `getSupabaseClient()` returns a client using the publishable key, for Supabase Auth calls and token verification. Queries through it are restricted by Row-Level Security.
- `getSupabaseAdminClient()` returns a client using the secret key, which **bypasses Row-Level Security**. Use it only for server-side operations that have already verified the caller is allowed to perform them, never for routine queries made on a user's behalf.
- Both are created on first use. If their variables are missing, they throw a `ConfigurationError`, which the error handler returns as `503` with a message naming the missing variables (never their values). They never return a fake client or fake data.

All Supabase values stay on the server. The secret key in particular must never be committed, logged, returned in a response, or copied into the frontend or any `EXPO_PUBLIC_*` variable.

## Structure

```text
backend/
├── src/
│   ├── config/
│   │   ├── env.js                 Reads environment variables (.env via dotenv)
│   │   └── supabase.js            Lazily created Supabase clients
│   ├── middleware/
│   │   └── error.middleware.js    JSON 404 and error handlers
│   ├── routes/
│   │   └── health.routes.js       GET /health
│   ├── app.js                     Express app: CORS, JSON parsing, routes
│   └── server.js                  Starts the server; graceful shutdown on SIGINT/SIGTERM
├── tests/
│   └── app.test.js                Health, 404, error and configuration tests
├── .env.example
└── package.json
```
