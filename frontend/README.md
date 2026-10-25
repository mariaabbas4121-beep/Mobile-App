# NeighborShare — Mobile App (frontend)

The Expo and React Native app for NeighborShare. Users sign up or sign in, with email and password or with Google, complete their profile, and then browse sample listings, request borrows, offer items, view a map and track sample transactions.

> **Current implementation:** authentication, sessions, account status and profile completion use the real NeighborShare API (`../backend`). Listings, transactions, trust score and badges are still in-memory sample data from `data/mockData.ts` and reset when the app restarts.

## Technology

- React Native 0.86 with React 19.2, TypeScript (strict)
- Expo SDK 57 with file-based navigation through Expo Router (protected routes)
- `expo-secure-store` for the session, `expo-web-browser` for Google sign-in, `@supabase/supabase-js` for the Google OAuth handshake only
- Expo Location, Camera, Image Picker, Linear Gradient, Blur and Haptics; React Native Maps and QR codes
- Jest (`jest-expo`) and React Native Testing Library for tests

## Requirements

- Node.js 22.13 or later and npm
- The API in `../backend` running and reachable from the device (see [backend/README.md](../backend/README.md))
- Android Studio with an emulator, an iOS simulator on macOS, or Expo Go on a phone

## Getting started

```powershell
# Terminal 1: the API
cd backend
npm.cmd run dev

# Terminal 2: the app
cd frontend
npm.cmd install
Copy-Item .env.example .env   # then fill in the values below
npx.cmd expo start -c
```

Press `a` for Android, `i` for iOS (macOS), `w` for web, or scan the QR code with Expo Go. In PowerShell, use `npm.cmd` / `npx.cmd` if the execution policy blocks `npm.ps1`. Restart with `-c` after any `.env` change.

## Environment variables

Expo copies every `EXPO_PUBLIC_*` value into the app bundle, where anyone can read it, so **only public values go here**. The app refuses a secret key placed in these variables.

| Variable | Value | Needed for |
| --- | --- | --- |
| `EXPO_PUBLIC_API_URL` | API base URL, without `/api/v1` (see below) | Everything |
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase dashboard → Project Settings → Data API → Project URL | Google sign-in only |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase dashboard → Project Settings → API Keys → Publishable key (`sb_publishable_…`) | Google sign-in only |

Never put the secret key (`sb_secret_…`), a `service_role` key, the database password or a personal access token in the frontend.

**`EXPO_PUBLIC_API_URL` depends on where the app runs.** `localhost` on a phone or emulator means the device itself, not your computer.

| Running the app on | `EXPO_PUBLIC_API_URL` |
| --- | --- |
| Expo web or iOS simulator, same computer as the API | `http://localhost:4000` |
| Android emulator | `http://10.0.2.2:4000` |
| Physical phone (same Wi-Fi as the computer) | `http://<your computer's LAN IP>:4000`, e.g. `http://192.168.1.20:4000`. Find it with `ipconfig`. Allow Node.js through Windows Firewall on private networks if the phone cannot connect. |

For Expo web, the API's `FRONTEND_ORIGIN` must include the web origin (default `http://localhost:8081`). Native apps are not subject to CORS.

## Authentication

### Screens and flow

| Route | Purpose |
| --- | --- |
| `/auth/welcome` | Entry point |
| `/auth/signup` | Name, email, password + confirmation, or Google |
| `/auth/login` | Email and password, or Google |
| `/auth/check-email` | "Check your inbox" after sign-up, or "confirm your email" after an unconfirmed login; resend with cooldown |
| `/auth/callback` | Deep-link target that finishes Google sign-in |
| `/onboarding/profile` | Required until display name, city and neighborhood are set |
| `/account/blocked` | Suspended or deletion-pending accounts |
| `/account/unreachable` | Signed in, but the API could not be reached at startup |

- **Sign-up** checks the same rules as the API before sending: email format, password of 8+ characters with a letter and a digit and at most 72 UTF-8 bytes, name of 2–50 characters, matching confirmation. The API answers the same way whether or not the email already has an account, so the next screen never says an email "was sent" or that an account exists.
- **Sign-in** shows one message for a wrong password or an unknown email. An unconfirmed email goes to the confirmation screen.
- **Errors** are chosen by the API's error `code` (see [backend/docs/API.md](../backend/docs/API.md#error-codes)). Rate limits show the wait time; network, timeout and server failures show safe messages.
- **Double taps** never send two requests; buttons are disabled while a request runs.

### Session lifecycle

All session handling lives in one place, `lib/auth/sessionManager.ts`, used through `context/AuthContext.tsx`:

1. **Startup:** the native splash screen stays up while the saved session is read from secure storage and the account is loaded from `/auth/me` and `/auth/status`. No screen is shown until the state is known.
2. **Requests:** an access token within 60 seconds of expiry is refreshed first, through `POST /auth/refresh`. If the API still rejects a token (`INVALID_TOKEN`), the session is refreshed once and the request retried once. Concurrent refreshes share one request, because Supabase rotates refresh tokens.
3. **Session ended:** if the refresh token is rejected, the session is cleared everywhere and the user returns to the sign-in screens with a notice.
4. **Offline:** network or server failures keep the session. If the account cannot be loaded at startup, a retry screen is shown instead of signing the user out.
5. **Sign-out** calls `POST /auth/logout` (this device's session), then clears the device. It succeeds locally even when offline.

Tokens are stored with `expo-secure-store` (Keychain/Keystore, readable only while the device is unlocked, not backed up). On Expo web there is no secure storage, so the session is kept in memory and a page reload signs the user out. Tokens, passwords and OAuth parameters are never logged.

### Navigation and account status

`app/_layout.tsx` uses Expo Router's `Stack.Protected` guards, derived in `lib/auth/routing.ts`, so exactly one group of screens is reachable at a time and protected screens never render without a loaded account:

| State | Open screens |
| --- | --- |
| Signed out (or still restoring behind the splash) | `auth/*` |
| Signed in, account could not be loaded | `account/unreachable` |
| Suspended or deletion pending | `account/blocked` (check again or sign out) |
| Profile incomplete | `onboarding/profile` |
| Active or restricted, profile complete | The app (tabs, item, lend, QR, teach) |

Account status comes only from the API. If the API refuses an action with `403`, the app reloads the status, so navigation follows a suspension straight away. Restricted accounts can use the app and see a notice on their profile. The profile form sends only `displayName`, `city`, `neighborhood` and `bio`.

## Testing email and password sign-in

1. Start the API and the app as above.
2. **Sign up** with a mailbox you can read. You land on "Check your inbox".
3. Open the confirmation email and its link. Supabase confirms the address and shows its redirect page (the project Site URL, or `AUTH_EMAIL_REDIRECT_URL`). The app does not need to receive that link.
4. Back in the app, **sign in**. Before confirming, sign-in shows the confirmation screen instead.
5. Complete the profile, use the app, then **Sign Out** from the Profile tab.
6. Restart the app while signed in: it should open directly in the app without flashing the sign-in screens.

**Until SMTP DNS verification is complete**, confirmation emails may be delayed, go to spam, or not arrive. Supabase's own email rate limit may also return "Too many attempts". You can confirm a test user manually in the Supabase dashboard (Authentication → Users) and then sign in.

## Google sign-in

### How it works

1. The app asks Supabase for a Google authorization URL using **PKCE**, with the redirect set to the app's deep link. The one-time code verifier stays in memory.
2. `expo-web-browser` opens the system browser. The user picks a Google account and consents.
3. Google returns to **Supabase**, and Supabase redirects to the **app's deep link** with a one-time `code`.
4. The app checks the link, exchanges the code (once; duplicate deliveries are ignored) for a Supabase session, and hands the tokens to the same session manager as email/password sign-in.
5. The app loads `/auth/me` and `/auth/status` from the API with that access token. Refresh and sign-out then go through the API as usual.

Cancelling or declining returns to the sign-in screen without an error. Provider errors, invalid callbacks and expired codes show a safe message.

### Three different redirect settings

These serve different purposes and are **not interchangeable**:

| Where | Setting | Value |
| --- | --- | --- |
| **Google Cloud Console** → APIs & Services → Credentials → OAuth client ID (type *Web application*) | Authorized redirect URIs | `https://<project-ref>.supabase.co/auth/v1/callback` (Supabase's callback, **not** the app) |
| **Supabase** → Authentication → Sign In / Providers → Google | Enabled; Client ID and Client Secret | The Client ID and Secret of that Google *Web application* client |
| **Supabase** → Authentication → URL Configuration → Redirect URLs | Allowed app redirects | The app's deep links, below |

The app's deep link is `Linking.createURL('auth/callback')`, with the app scheme `neighborshare`:

| Running in | Redirect URL to allow in Supabase |
| --- | --- |
| Development or store build (`npx expo run:android` / `run:ios`, EAS) | `neighborshare://auth/callback` |
| Expo Go | `exp://<computer LAN IP>:8081/--/auth/callback`, e.g. `exp://192.168.1.20:8081/--/auth/callback`. It changes with the IP; on a **development** project only, `exp://**` can be allowed instead. |
| Expo web | `http://localhost:8081/auth/callback` |

If the app's URL is not allowed, Supabase silently redirects to the Site URL instead, and the app never receives the code. Also configure the Google **OAuth consent screen** (app name, support email). While it is in *Testing* mode, add your Google accounts as test users.

### End-to-end test (manual)

Not yet performed: it needs the settings above, a device or emulator, and a Google account.

1. Complete the three settings above and set the two `EXPO_PUBLIC_SUPABASE_*` variables.
2. Start the API and the app, then tap **Continue with Google** on the sign-in screen.
3. Pick an account and consent. Expect to return to the app on "Complete your profile" (first sign-in) or the main tabs.
4. Check in the Supabase dashboard (Authentication → Users) that the user has provider `google`. Check in `profiles` that a profile row exists.
5. Close and reopen the app and confirm the session restores. Sign out and confirm you return to the welcome screen.
6. Repeat with **Cancel** in the browser: the sign-in screen should show no error.

## Tests and checks

| Command | What it does |
| --- | --- |
| `npm test` | Jest unit and component tests (no network; the API, storage and Google flow are faked) |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npx expo-doctor` | Checks dependencies against Expo SDK 57 |
| `npx expo export --platform android --platform ios --output-dir <temp dir>` | Confirms the app bundles for both platforms |

The tests cover validation, the API client (envelope, error codes, timeouts, offline), session restore, refresh (single-flight, failure, retry), sign-out, Google sign-in (success, cancel, provider errors, invalid callbacks, expired codes, missing configuration, duplicate callbacks), routing by account status, and the sign-up, sign-in and check-email screens (including duplicate taps). They do **not** exercise a real device, browser, email or Google account; see the manual checks above.

## Screens and routes

| Route | Screen |
| --- | --- |
| `/auth/*` | Authentication screens (see above) |
| `/(tabs)` | Main tab navigator: browse, map, activity, profile |
| `/item/[id]` | Details for an item |
| `/lend/new` | New listing form |
| `/qr/[txnId]` | QR view for a transaction |
| `/teach/[txnId]` | Teach-me flow for a transaction |

## Folder and file guide

```text
frontend/
├── app/                         Expo Router screens and layouts
│   ├── _layout.tsx              Providers, splash handling, protected route groups
│   ├── auth/                    welcome, login, signup, check-email, callback
│   ├── account/                 blocked, unreachable
│   ├── onboarding/profile.tsx   Profile completion
│   ├── (tabs)/                  Browse, map, activity, profile
│   └── item/, lend/, qr/, teach/
├── components/
│   ├── auth/                    Shared auth UI, submit and Google hooks
│   └── button.tsx
├── context/
│   ├── AuthContext.tsx          Central auth state and actions
│   └── AppContext.tsx           Sample listings and transactions
├── lib/
│   ├── config.ts                Public configuration (refuses secret keys)
│   ├── api/                     Typed API client and contract types
│   └── auth/                    Session manager, token storage, Google sign-in, routing, validation, messages
├── __tests__/                   Jest tests
├── data/mockData.ts             Sample data
├── utils/theme.ts               Design tokens
├── .env.example                 Public configuration template
└── app.json                     Expo config (scheme: neighborshare)
```

## Known limitations

- **Email delivery** depends on Supabase custom SMTP. Until its DNS verification is complete, confirmation emails may be delayed or missing.
- **Google sign-in** is implemented and unit-tested but has not been tested end to end. The PKCE verifier is held in memory, so if the operating system kills the app while the browser is open, the sign-in must be started again.
- **Password reset** is not available yet: the API has no reset endpoint, so the old "Forgot password?" link was removed.
- **Phone and identity verification** are not implemented; `/auth/status` reports them as not started.
- **Expo web** keeps the session in memory only (sign-in is lost on reload).
- The Profile tab's trust score, karma, badges and counts, and all listings and transactions, are still sample data.
- `app/lend/new.tsx` has a type error that predates this work (`images` is not a field of `Item`), and its picked photos are not saved to the listing.
- `README.txt` is an empty legacy file; this README is the maintained guide.
