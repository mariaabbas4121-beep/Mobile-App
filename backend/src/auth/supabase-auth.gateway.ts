import type { Session, User } from '@supabase/supabase-js';
import type { Config } from '../config/env.js';
import type { SupabaseClients } from '../config/supabase.js';
import type { Logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';
import { mapAuthError } from './auth.errors.js';
import type { AuthGateway, AuthSession, AuthUser } from './auth.types.js';

export function toAuthUser(user: User): AuthUser {
  const providers = user.app_metadata?.providers;
  return {
    id: user.id,
    email: user.email ?? null,
    emailConfirmedAt: user.email_confirmed_at ?? null,
    createdAt: user.created_at,
    lastSignInAt: user.last_sign_in_at ?? null,
    providers: Array.isArray(providers) ? providers.filter((p): p is string => typeof p === 'string') : [],
  };
}

export function toAuthSession(session: Session): AuthSession {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    tokenType: 'bearer',
    expiresIn: session.expires_in,
    expiresAt: session.expires_at ?? null,
  };
}

// Supabase returns an error object rather than throwing for API failures;
// both paths are normalised to AppError here.
export function createSupabaseAuthGateway(
  clients: SupabaseClients,
  config: Pick<Config, 'auth'>,
  logger: Logger,
): AuthGateway {
  const auth = () => clients.anon().auth;

  const sessionResult = (data: { user: User | null; session: Session | null }, operation: 'login' | 'refresh') => {
    if (!data.user || !data.session) {
      logger.error({ operation }, 'auth provider returned no session');
      throw AppError.unavailable('Authentication service is temporarily unavailable', 'AUTH_UNAVAILABLE');
    }
    return { user: toAuthUser(data.user), session: toAuthSession(data.session) };
  };

  return {
    async signUp({ email, password, displayName }) {
      try {
        const { data, error } = await auth().signUp({
          email,
          password,
          options: {
            ...(config.auth.emailRedirectUrl ? { emailRedirectTo: config.auth.emailRedirectUrl } : {}),
            // Only display_name is read by the provisioning trigger.
            data: displayName ? { display_name: displayName } : {},
          },
        });
        if (error) throw error;
        return {
          user: data.user ? toAuthUser(data.user) : null,
          session: data.session ? toAuthSession(data.session) : null,
        };
      } catch (err) {
        throw mapAuthError(err, 'signup', logger);
      }
    },

    async signIn({ email, password }) {
      try {
        const { data, error } = await auth().signInWithPassword({ email, password });
        if (error) throw error;
        return sessionResult(data, 'login');
      } catch (err) {
        throw mapAuthError(err, 'login', logger);
      }
    },

    async refresh(refreshToken) {
      try {
        const { data, error } = await auth().refreshSession({ refresh_token: refreshToken });
        if (error) throw error;
        return sessionResult(data, 'refresh');
      } catch (err) {
        throw mapAuthError(err, 'refresh', logger);
      }
    },

    async resendSignupConfirmation(email) {
      try {
        const { error } = await auth().resend({
          type: 'signup',
          email,
          ...(config.auth.emailRedirectUrl ? { options: { emailRedirectTo: config.auth.emailRedirectUrl } } : {}),
        });
        if (error) throw error;
      } catch (err) {
        throw mapAuthError(err, 'resend', logger);
      }
    },

    async getUser(accessToken) {
      try {
        // Asks the Auth server, which checks the signature, expiry, that the
        // user still exists and that the session has not been signed out.
        const { data, error } = await auth().getUser(accessToken);
        if (error) throw error;
        return toAuthUser(data.user);
      } catch (err) {
        throw mapAuthError(err, 'get_user', logger);
      }
    },

    async signOut(accessToken, scope) {
      try {
        // Authorised by the user's own access token; no secret key needed.
        const { error } = await auth().admin.signOut(accessToken, scope);
        if (error) throw error;
      } catch (err) {
        throw mapAuthError(err, 'logout', logger);
      }
    },
  };
}
