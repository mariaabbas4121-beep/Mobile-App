import { Router } from 'express';
import type { AuthGateway, ProfileRepository } from '../auth/auth.types.js';
import {
  loginBody,
  logoutBody,
  refreshBody,
  resendConfirmationBody,
  signupBody,
  type LoginBody,
  type LogoutBody,
  type RefreshBody,
  type ResendConfirmationBody,
  type SignupBody,
} from '../auth/auth.schemas.js';
import { deriveOnboarding } from '../auth/onboarding.js';
import { AppError } from '../lib/errors.js';
import { getAuth, requireAuth } from '../middleware/auth.middleware.js';
import { validateBody } from '../middleware/validate.middleware.js';

export interface AuthRouteDeps {
  gateway: AuthGateway;
  profiles: ProfileRepository;
}

// Same wording whether or not the address already has an account, so the
// endpoint cannot be used to discover registered emails.
const CONFIRMATION_SENT =
  'If this email address can be registered, a confirmation link has been sent to it. Confirm it, then sign in.';

export function authRoutes({ gateway, profiles }: AuthRouteDeps) {
  const router = Router();
  const authenticated = requireAuth(gateway);

  const loadProfile = async (accessToken: string, userId: string) => {
    const profile = await profiles.getProfile(accessToken, userId);
    // The signup trigger creates it in the same transaction as the user, so
    // absence means something is wrong server-side.
    if (!profile) throw new AppError(500, 'PROFILE_MISSING', 'Account profile is unavailable');
    return profile;
  };

  router.post('/signup', validateBody(signupBody), async (req, res) => {
    const { email, password, displayName } = req.body as SignupBody;
    const { user, session } = await gateway.signUp({ email, password, displayName });

    if (session && user) {
      // Email confirmation is disabled in the Supabase project.
      res.status(201).json({ success: true, data: { emailConfirmationRequired: false, user, session } });
      return;
    }
    res.status(202).json({ success: true, data: { emailConfirmationRequired: true, message: CONFIRMATION_SENT } });
  });

  router.post('/login', validateBody(loginBody), async (req, res) => {
    const { email, password } = req.body as LoginBody;
    const { user, session } = await gateway.signIn({ email, password });
    res.status(200).json({ success: true, data: { user, session } });
  });

  router.post('/refresh', validateBody(refreshBody), async (req, res) => {
    const { refreshToken } = req.body as RefreshBody;
    const { user, session } = await gateway.refresh(refreshToken);
    res.status(200).json({ success: true, data: { user, session } });
  });

  router.post('/email/resend', validateBody(resendConfirmationBody), async (req, res) => {
    const { email } = req.body as ResendConfirmationBody;
    try {
      await gateway.resendSignupConfirmation(email);
    } catch (err) {
      // Only rate limiting and outages are reported; anything else (such as an
      // unknown or already-confirmed address) gets the generic answer.
      if (err instanceof AppError && (err.status === 429 || err.status === 503)) throw err;
    }
    res.status(202).json({ success: true, data: { message: CONFIRMATION_SENT } });
  });

  router.post('/logout', authenticated, validateBody(logoutBody), async (req, res) => {
    const { scope } = req.body as LogoutBody;
    const { accessToken } = getAuth(req);
    try {
      await gateway.signOut(accessToken, scope);
    } catch (err) {
      // Already signed out: the goal of the request is met.
      if (!(err instanceof AppError && err.code === 'INVALID_TOKEN')) throw err;
    }
    res.status(204).end();
  });

  router.get('/me', authenticated, async (req, res) => {
    const { user, accessToken } = getAuth(req);
    const profile = await loadProfile(accessToken, user.id);
    res.status(200).json({ success: true, data: { user, profile } });
  });

  router.get('/status', authenticated, async (req, res) => {
    const { user, accessToken } = getAuth(req);
    const [profile, verifications] = await Promise.all([
      loadProfile(accessToken, user.id),
      profiles.getVerifications(accessToken, user.id),
    ]);
    res.status(200).json({ success: true, data: deriveOnboarding(user, profile, verifications) });
  });

  return router;
}
