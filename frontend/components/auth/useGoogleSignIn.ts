import { useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { errorMessage } from '../../lib/auth/messages';
import { useSubmit } from './useSubmit';

// Shared by the sign-in and sign-up screens. Cancelling is not an error.
export function useGoogleSignIn(onError: (message: string | null) => void) {
  const { signInWithGoogle, googleConfigured } = useAuth();

  const action = useCallback(async () => {
    onError(null);
    if (!googleConfigured) {
      onError('Google sign-in is not set up in this build of the app.');
      return;
    }
    try {
      await signInWithGoogle();
      // On success navigation follows the auth state; on cancel nothing changes.
    } catch (err) {
      onError(errorMessage(err));
    }
  }, [signInWithGoogle, googleConfigured, onError]);

  const [start, busy] = useSubmit(action);
  return { start: () => void start(), busy };
}
