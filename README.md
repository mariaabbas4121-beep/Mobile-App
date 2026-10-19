# NeighborShare

NeighborShare is a mobile app for borrowing and lending items within trusted local communities such as universities, hostels and housing societies.

The repository contains two independent applications:

| Folder | What it is | Stack |
| --- | --- | --- |
| [`frontend/`](frontend) | Mobile app | React Native, Expo SDK 57, Expo Router, TypeScript |
| [`backend/`](backend) | REST API | Node.js 22, Express, Supabase JS client |

Supabase is the backend platform: Supabase Auth for accounts, PostgreSQL with Row-Level Security for data, and Supabase Storage for files. **The mobile app talks only to the Express API**; the API handles authentication and every Supabase operation on the server, and holds all Supabase keys. The app has no Supabase client or keys. A Python research module (scikit-learn, SHAP) is planned for a later phase.

## Current status

- The app runs on in-memory mock data. Sign-in and sign-up screens are in place but not yet connected to Supabase Auth.
- The API serves a health check and is ready to connect to Supabase; it has no feature endpoints yet.
- Neither app needs a Supabase project to start locally.

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

Check the API at http://localhost:4000/health.

In PowerShell, use `npm.cmd` and `npx.cmd` if the execution policy blocks `npm.ps1`.

## Environment files

Each app has a `.env.example` template. To create your local copy, run this inside `frontend/` or `backend/`:

```powershell
Copy-Item .env.example .env
```

The values in the templates are placeholders, not real credentials; see each app's README for what to fill in. Real `.env` files are ignored by Git and must never be committed.

- `frontend/.env` holds only `EXPO_PUBLIC_API_URL`, the address of the API. On a physical phone this must be your computer's LAN IP (e.g. `http://192.168.1.20:4000`), not `localhost`.
- `backend/.env` holds all Supabase configuration. No Supabase key ever goes in the frontend or in any `EXPO_PUBLIC_*` variable.

## Documentation

- [frontend/README.md](frontend/README.md): screens, routes, folder guide, app setup
- [backend/README.md](backend/README.md): endpoints, environment variables, Supabase access rules

## Course information

- **Course:** Mobile Application Development
- **Submitted by:** Maria Abbas (2023-ag-9845)
