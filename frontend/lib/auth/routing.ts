import type { AccountStatus, OnboardingStatus } from '../api/types';

export type AuthPhase = 'restoring' | 'signedOut' | 'unreachable' | 'signedIn';

export interface RoutingInput {
  phase: AuthPhase;
  onboarding: OnboardingStatus | null;
}

// Which route groups are reachable. Exactly one group is open at a time, so
// there is always a single place to go and no redirect loops. Used with
// Expo Router's Stack.Protected, so a guarded screen never renders, even
// briefly, while its guard is false.
export interface RouteGuards {
  auth: boolean; // welcome, login, signup, check-email, OAuth callback
  unreachable: boolean; // signed in, but the account could not be loaded
  blocked: boolean; // suspended or deletion pending
  onboarding: boolean; // must complete the profile first
  app: boolean; // tabs and the rest of the app
}

const BLOCKED: AccountStatus[] = ['suspended', 'deletion_pending'];

export function routeGuards({ phase, onboarding }: RoutingInput): RouteGuards {
  const signedIn = phase === 'signedIn' && onboarding !== null;
  const blocked = signedIn && BLOCKED.includes(onboarding.accountStatus);
  const needsProfile = signedIn && !blocked && !onboarding.profile.complete;
  return {
    // While restoring, the splash screen stays up; the auth group is the
    // harmless default underneath it.
    auth: phase === 'signedOut' || phase === 'restoring',
    unreachable: phase === 'unreachable',
    blocked,
    onboarding: needsProfile,
    app: signedIn && !blocked && !needsProfile,
  };
}
