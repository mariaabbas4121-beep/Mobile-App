# NeighborShare — Mobile App (frontend)

The Expo and React Native app for NeighborShare. Users can browse sample listings, inspect item details, request a borrow, offer an item, view a map and track sample transactions.

> **Current implementation:** listings, users, profile data and transactions are held in in-memory mock data from `data/mockData.ts` and `context/AppContext.tsx`. They reset when the app restarts. **Sign-in and sign-up are not connected yet**: the screens validate their fields and then say that authentication is coming. In the next phase they will call the NeighborShare API's `/api/auth/*` endpoints. Map and camera features depend on a real device or platform support.

## Technology

- React Native 0.86 with React 19.2
- Expo SDK 57 with file-based navigation through Expo Router
- TypeScript for screens and shared app state
- Expo Location, Camera, Image Picker, Linear Gradient, Blur and Haptics packages
- React Native Maps and QR code rendering
- Backend (planned integration): the Express API in [`../backend`](../backend). The app talks only to this API; authentication, the database and file storage (Supabase) are reached through it, never directly from the app.

## Requirements

- Node.js 22.13 or later and npm
- Android Studio with an emulator, an iOS simulator on macOS, or Expo Go on a supported phone

Neither the API nor a Supabase project is needed to run the app in its current state.

## Getting started

Run these from the `frontend` folder:

```powershell
cd frontend
npm install
Copy-Item .env.example .env   # optional for now; the values are placeholders
npx expo start -c
```

In PowerShell, if the execution policy blocks `npm.ps1`, use `npm.cmd` and `npx.cmd` in place of `npm` and `npx`. This does not require changing the machine's execution policy.

Use `npm run android`, `npm run ios` (macOS), or `npm run web` to target a platform. Follow the Expo CLI prompt to open a simulator or scan its QR code with Expo Go.

### Exploring the mock-data screens

Because sign-in is not connected yet, development builds show a **"Development: explore with mock data"** link under the sign-in form. It opens the main tabs with the local sample data. It does not sign anyone in, check credentials or contact a server, and it is hidden in production builds (`__DEV__` is false there).

## Environment variables

The app needs one value, the address of the NeighborShare API:

| Variable | Value |
| --- | --- |
| `EXPO_PUBLIC_API_URL` | Base URL of the API in `../backend`, e.g. `http://192.168.1.20:4000` |

Pick the address that the device running the app can reach:

| Running the app on | `EXPO_PUBLIC_API_URL` |
| --- | --- |
| Expo web or iOS simulator, same computer as the API | `http://localhost:4000` |
| Android emulator | `http://10.0.2.2:4000` (the emulator's alias for the host computer) |
| Physical phone with Expo Go | `http://<your computer's LAN IP>:4000`. Find the IPv4 address with `ipconfig`; the phone must be on the same Wi-Fi network. |

`localhost` on a phone or emulator means the device itself, not your computer, so it will not reach the API there. Restart Expo with `npx expo start -c` after changing `.env`.

Expo copies every `EXPO_PUBLIC_*` variable into the app bundle, where anyone can read it, so **no keys or credentials go in the frontend**. The app does not use a Supabase client or any Supabase keys: sign-in, data and file uploads all go through the API, which holds the Supabase configuration on the server. `.env` is ignored by Git; `.env.example` is committed.

## Screens and routes

Expo Router maps files under `app/` to routes:

| Route | Screen |
| --- | --- |
| `/auth/welcome` | Welcome and entry point to sign in or sign up |
| `/auth/login` | Email and password sign in (pending the API's auth endpoints) |
| `/auth/signup` | Account creation (pending the API's auth endpoints) |
| `/(tabs)` | Main tab navigator |
| `/(tabs)/index` | Browse, search and filter sample item listings |
| `/(tabs)/map` | Map-based item discovery |
| `/(tabs)/activity` | Borrow/lend transaction activity |
| `/(tabs)/profile` | Sample user profile, trust score and badges |
| `/item/[id]` | Details for the item identified by `id` |
| `/lend/new` | Form for creating a local item listing |
| `/qr/[txnId]` | QR view for a transaction |
| `/teach/[txnId]` | Teach-me flow for a transaction |

`app/_layout.tsx` provides the app-wide providers, status bar, toast notifications and authentication-aware route redirect. `app/auth/_layout.tsx` and `app/(tabs)/_layout.tsx` provide nested navigators. Parentheses mark a route group and are not part of the URL.

## Folder and file guide

```text
frontend/
├── app/                         Expo Router screens and navigation layouts
│   ├── _layout.tsx              Root providers, stack and auth redirects
│   ├── auth/                    Welcome, login, signup and auth stack
│   ├── (tabs)/                  Browse, map, activity, profile and tab bar
│   ├── item/[id].tsx            Dynamic item details route
│   ├── lend/new.tsx             New lending listing form
│   ├── qr/[txnId].tsx           Dynamic transaction QR route
│   └── teach/[txnId].tsx        Dynamic teaching session route
├── assets/                      App icon assets (PNG and AVIF copies)
├── components/                  Reusable UI components (currently Button)
├── context/                     Shared React state and app actions
├── data/                        Typed mock users, items, transactions, categories
├── utils/                       Design tokens (theme)
├── .env.example                 API address template (EXPO_PUBLIC_API_URL)
├── app.json                     Expo name, identifiers, permissions and plugins
├── babel.config.js              Babel preset configuration for Expo
├── expo-env.d.ts                Expo TypeScript environment declarations
├── package.json                 Scripts and direct dependencies
├── package-lock.json            Locked npm dependency tree
└── tsconfig.json                TypeScript settings and path alias
```

### Main source files

- `context/AppContext.tsx` owns mock app state: login flag, listings, transactions, search and category selection. It exposes actions to request a borrow, complete a transaction, add a listing and log in or out.
- `data/mockData.ts` defines the `Item`, `User`, `Badge` and `Transaction` types and the sample records used by the UI.
- `utils/theme.ts` defines the shared color palette, typography, spacing, corner radii and shadows.
- `components/button.tsx` contains a small reusable button with an optional loading indicator.

## Project scripts

| Command | Purpose |
| --- | --- |
| `npm start` | Start the Expo development server |
| `npm run android` | Start Expo and open Android |
| `npm run ios` | Start Expo and open iOS Simulator (macOS) |
| `npm run web` | Start Expo for web |

## Notes and limitations

- `README.txt` is an empty legacy file; this Markdown file is the maintained guide for the app.
- Item photos and avatars in the sample data use remote image URLs and need an internet connection to display.
- Location, camera, QR scanning and map behavior should be checked on the intended device/platform; browser support differs from native support.
- The sign-in screen links to a password recovery route, but no recovery screen exists yet.
- Photos picked in the "Lend" form are previewed but not yet saved to the new listing.
