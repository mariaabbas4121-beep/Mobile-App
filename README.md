# NeighborShare

NeighborShare is a mobile app for borrowing and lending items within trusted local communities such as universities, hostels and housing societies.

The repository contains two independent applications:

| Folder | What it is | Stack |
| --- | --- | --- |
| [`frontend/`](frontend) | Mobile app | React Native, Expo SDK 57, Expo Router, TypeScript |
| [`backend/`](backend) | REST API | Node.js 22, Express 5, TypeScript, Supabase JS client |

Supabase is the backend platform: Supabase Auth for accounts, PostgreSQL with Row-Level Security for data, and Supabase Storage for files. **The mobile app talks to the Express API** for authentication and every data operation; the API holds all secret Supabase configuration. The one exception is Google sign-in, where the app uses the Supabase SDK with the public, publishable key to start the flow and obtain a session, which it then uses with the API. A Python research module (scikit-learn, SHAP) is planned for a later phase.

## Current status

- The app runs on in-memory mock data. Sign-in and sign-up screens are in place but not yet connected to Supabase Auth.
- The API implements email/password authentication (signup, email confirmation, login, refresh, logout), the current-user and onboarding-status endpoints, and profile editing, backed by Supabase with Row-Level Security. See [backend/docs/API.md](backend/docs/API.md).
- The API needs a Supabase project to start: it validates its configuration at startup. The app does not.
- The app signs users in through the API (email and password) or with Google via Supabase, keeps the session in secure device storage, and routes by account status. Google sign-in still needs its dashboard setup and a device test.
- Phone verification (an optional step from the Profile tab) is implemented in the API and the app using Supabase Auth's SMS codes. It needs a database migration and an SMS provider configured in Supabase before it can send texts; see [backend/docs/SUPABASE.md](backend/docs/SUPABASE.md#sms-setup-for-phone-verification). Identity verification is not implemented yet.

## Running locally

Each app has its own dependencies. Run them in separate terminals.

```powershell
# Frontend
cd frontend
npm install
npx expo start -c
```

```powershell
# Backend
cd backend
npm install
npm run dev
```

Check the API at http://localhost:4000/api/v1/health.

In PowerShell, use `npm.cmd` and `npx.cmd` if the execution policy blocks `npm.ps1`.

## Environment files

Each app has a `.env.example` template. To create your local copy, run this inside `frontend/` or `backend/`:

```powershell
Copy-Item .env.example .env
```

The values in the templates are placeholders, not real credentials; see each app's README for what to fill in. Real `.env` files are ignored by Git and must never be committed.

- `frontend/.env` holds `EXPO_PUBLIC_API_URL` (the API address; on a physical phone use your computer's LAN IP, e.g. `http://192.168.1.20:4000`, not `localhost`) and the public Supabase URL and publishable key for Google sign-in.
- `backend/.env` holds all secret Supabase configuration. The secret key, database password and access tokens never go in the frontend or in any `EXPO_PUBLIC_*` variable.

## Documentation

- [frontend/README.md](frontend/README.md): screens, routes, folder guide, app setup
- [backend/README.md](backend/README.md): API overview, setup, environment variables, security model
- [backend/docs/API.md](backend/docs/API.md): endpoint contracts and error codes
- [backend/docs/SUPABASE.md](backend/docs/SUPABASE.md): data model, access control, migrations, dashboard checklist
- [backend/docs/TESTING.md](backend/docs/TESTING.md): test suites and how to run them


