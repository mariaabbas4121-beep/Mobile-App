import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isApiError, type ApiClient } from '../lib/api/client';
import type {
  LogoutScope,
  OnboardingStatus,
  PhoneStartResult,
  PhoneVerification,
  Profile,
  ProfileUpdate,
  Session,
  SignupResult,
  User,
} from '../lib/api/types';
import { SessionStorageError, type SessionManager } from '../lib/auth/sessionManager';
import type { CallbackParams, GoogleAuth, GoogleSignInResult } from '../lib/auth/googleAuth';
import { routeGuards, type AuthPhase, type RouteGuards } from '../lib/auth/routing';
import { normaliseEmail } from '../lib/auth/validation';

export interface AuthServices {
  api: ApiClient;
  sessionManager: SessionManager;
  googleAuth: GoogleAuth;
}

interface Account {
  user: User;
  profile: Profile;
  onboarding: OnboardingStatus;
}

export interface AuthContextValue {
  phase: AuthPhase;
  user: User | null;
  profile: Profile | null;
  onboarding: OnboardingStatus | null;
  guards: RouteGuards;
  // Set when the session ended on its own (refresh rejected); cleared on read.
  sessionEndedNotice: boolean;
  acknowledgeSessionEnded: () => void;

  signUp: (input: { email: string; password: string; displayName: string }) => Promise<SignupResult>;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<'signedIn' | 'cancelled'>;
  completeOAuthCallback: (params: CallbackParams) => Promise<'signedIn' | 'cancelled'>;
  resendConfirmation: (email: string) => Promise<void>;
  signOut: (scope?: LogoutScope) => Promise<void>;
  reloadAccount: () => Promise<void>;
  updateProfile: (changes: ProfileUpdate) => Promise<Profile>;
  // Phone verification is an extra step on a signed-in account; the result
  // is decided and stored by the server only.
  getPhoneVerification: () => Promise<PhoneVerification>;
  startPhoneVerification: (phoneE164: string) => Promise<PhoneStartResult>;
  resendPhoneVerification: () => Promise<PhoneStartResult>;
  confirmPhoneVerification: (phoneE164: string, code: string) => Promise<PhoneVerification>;
  googleConfigured: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Loaded lazily so tests can supply fakes without importing native modules.
function defaultServices(): AuthServices {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { api, sessionManager, googleAuth } = require('../lib/auth') as typeof import('../lib/auth');
  return { api, sessionManager, googleAuth };
}

const isTransient = (err: unknown) =>
  isApiError(err) && (err.code === 'NETWORK_ERROR' || err.code === 'TIMEOUT' || err.status >= 500);

// Central authentication state. Screens never hold tokens or call refresh;
// they use these actions, and navigation follows `guards`.
export function AuthProvider({ children, services }: { children: ReactNode; services?: AuthServices }) {
  const [{ api, sessionManager, googleAuth }] = useState<AuthServices>(() => services ?? defaultServices());

  const [phase, setPhase] = useState<AuthPhase>('restoring');
  const [account, setAccount] = useState<Account | null>(null);
  const [sessionEndedNotice, setSessionEndedNotice] = useState(false);
  // Sessions being or already applied, by access token. A duplicated OAuth
  // callback (browser result and deep link) shares the first one's outcome,
  // so it cannot sign in twice and cannot wait on a result it never hears.
  const applied = useRef(new Map<string, Promise<void>>());

  const fetchAccount = useCallback(async (): Promise<Account> => {
    const [{ user, profile }, onboarding] = await Promise.all([
      sessionManager.authorized((t) => api.me(t)),
      sessionManager.authorized((t) => api.status(t)),
    ]);
    return { user, profile, onboarding };
  }, [api, sessionManager]);

  // Loads the account and moves to the matching phase. Always rethrows on
  // failure after updating state, so callers can show the error.
  const reloadAccount = useCallback(async () => {
    try {
      const next = await fetchAccount();
      setAccount(next);
      setPhase('signedIn');
    } catch (err) {
      if (!sessionManager.current) {
        // The session ended while loading (refresh rejected).
        setAccount(null);
        setPhase('signedOut');
      } else if (isTransient(err)) {
        // Keep the session and the last known account; offer a retry if
        // there is nothing to show yet.
        setPhase((p) => (p === 'signedIn' ? p : 'unreachable'));
      } else {
        // Any other failure (e.g. a 401 that survived a refresh) means the
        // session cannot be used: sign out locally.
        await sessionManager.clear();
        setAccount(null);
        setPhase('signedOut');
      }
      throw err;
    }
  }, [fetchAccount, sessionManager]);

  // Restore on startup.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const session = await sessionManager.restore();
      if (cancelled) return;
      // A sign-in finished while storage was read; it loads the account
      // itself, so do not load it a second time or override its phase.
      if (applied.current.size > 0) return;
      if (!session) {
        setPhase('signedOut');
        return;
      }
      await reloadAccount().catch(() => undefined);
    })();
    return () => {
      cancelled = true;
    };
    // Runs once; reloadAccount reads the latest state when called.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A refresh rejected anywhere in the app ends the session everywhere.
  useEffect(
    () =>
      sessionManager.subscribe((event) => {
        if (event === 'expired') {
          setAccount(null);
          setPhase('signedOut');
          setSessionEndedNotice(true);
        }
      }),
    [sessionManager],
  );

  const applySession = useCallback(
    (session: Session): Promise<void> => {
      const existing = applied.current.get(session.accessToken);
      if (existing) return existing;
      const applying = (async () => {
        try {
          await sessionManager.setSession(session);
        } catch {
          // Not saved on the device: a session that would vanish on restart
          // is not used at all.
          await sessionManager.clear();
          throw new SessionStorageError();
        }
        await reloadAccount();
      })();
      applied.current.set(session.accessToken, applying);
      return applying;
    },
    [sessionManager, reloadAccount],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      const { session } = await api.login({ email: normaliseEmail(email), password });
      await applySession(session);
    },
    [api, applySession],
  );

  const signUp = useCallback(
    async ({ email, password, displayName }: { email: string; password: string; displayName: string }) => {
      const result = await api.signup({ email: normaliseEmail(email), password, displayName: displayName.trim() });
      // Only when email confirmation is disabled on the server.
      if (!result.emailConfirmationRequired) await applySession(result.session);
      return result;
    },
    [api, applySession],
  );

  const finishGoogle = useCallback(
    async (result: GoogleSignInResult) => {
      if (result.type === 'cancelled') return 'cancelled' as const;
      await applySession(result.session);
      return 'signedIn' as const;
    },
    [applySession],
  );

  const signInWithGoogle = useCallback(async () => finishGoogle(await googleAuth.signIn()), [googleAuth, finishGoogle]);
  const completeOAuthCallback = useCallback(
    async (params: CallbackParams) => finishGoogle(await googleAuth.completeFromParams(params)),
    [googleAuth, finishGoogle],
  );

  const resendConfirmation = useCallback(async (email: string) => {
    await api.resendConfirmation(normaliseEmail(email));
  }, [api]);

  const signOut = useCallback(
    async (scope: LogoutScope = 'local') => {
      await sessionManager.signOut(scope);
      applied.current.clear();
      setAccount(null);
      setPhase('signedOut');
    },
    [sessionManager],
  );

  const updateProfile = useCallback(
    async (changes: ProfileUpdate) => {
      try {
        const { profile } = await sessionManager.authorized((t) => api.updateProfile(t, changes));
        // Completion and stage are derived server-side; reload them.
        await reloadAccount().catch(() => undefined);
        return profile;
      } catch (err) {
        // Status changed on the server (e.g. suspended): refresh so navigation follows.
        if (isApiError(err) && err.status === 403) await reloadAccount().catch(() => undefined);
        throw err;
      }
    },
    [api, sessionManager, reloadAccount],
  );

  // Runs a phone verification call. A 403 means the account status changed
  // on the server (e.g. suspended): reload so navigation follows.
  const phoneCall = useCallback(
    async <T,>(call: (token: string) => Promise<T>): Promise<T> => {
      try {
        return await sessionManager.authorized(call);
      } catch (err) {
        if (isApiError(err) && err.status === 403) await reloadAccount().catch(() => undefined);
        throw err;
      }
    },
    [sessionManager, reloadAccount],
  );

  const getPhoneVerification = useCallback(
    async () => (await phoneCall((t) => api.phoneVerification(t))).verification,
    [api, phoneCall],
  );
  const startPhoneVerification = useCallback(
    (phoneE164: string) => phoneCall((t) => api.startPhoneVerification(t, phoneE164)),
    [api, phoneCall],
  );
  const resendPhoneVerification = useCallback(() => phoneCall((t) => api.resendPhoneVerification(t)), [api, phoneCall]);
  const confirmPhoneVerification = useCallback(
    async (phoneE164: string, code: string) => {
      const { verification } = await phoneCall((t) => api.confirmPhoneVerification(t, phoneE164, code));
      // The onboarding milestones come from the server; reload them.
      await reloadAccount().catch(() => undefined);
      return verification;
    },
    [api, phoneCall, reloadAccount],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      phase,
      user: account?.user ?? null,
      profile: account?.profile ?? null,
      onboarding: account?.onboarding ?? null,
      guards: routeGuards({ phase, onboarding: account?.onboarding ?? null }),
      sessionEndedNotice,
      acknowledgeSessionEnded: () => setSessionEndedNotice(false),
      signUp,
      signIn,
      signInWithGoogle,
      completeOAuthCallback,
      resendConfirmation,
      signOut,
      reloadAccount,
      updateProfile,
      getPhoneVerification,
      startPhoneVerification,
      resendPhoneVerification,
      confirmPhoneVerification,
      googleConfigured: googleAuth.isConfigured(),
    }),
    [
      phase, account, sessionEndedNotice, signUp, signIn, signInWithGoogle, completeOAuthCallback, resendConfirmation,
      signOut, reloadAccount, updateProfile, getPhoneVerification, startPhoneVerification, resendPhoneVerification,
      confirmPhoneVerification, googleAuth,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
