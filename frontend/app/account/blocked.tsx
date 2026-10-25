import { useState } from 'react';
import { Text } from 'react-native';
import { useAuth } from '../../context/AuthContext';
import { errorMessage } from '../../lib/auth/messages';
import { useSubmit } from '../../components/auth/useSubmit';
import { AuthHeader, AuthScreen, Card, Notice, PrimaryButton, SecondaryButton, styles } from '../../components/auth/AuthUI';

// Shown while the backend reports the account as suspended or scheduled for
// deletion. The status is decided by the server; the user can only re-check
// it or sign out.
export default function AccountBlockedScreen() {
  const { onboarding, reloadAccount, signOut } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const deletion = onboarding?.accountStatus === 'deletion_pending';

  const [recheck, checking] = useSubmit(async () => {
    setError(null);
    try {
      await reloadAccount();
    } catch (err) {
      setError(errorMessage(err));
    }
  });
  const [leave, leaving] = useSubmit(() => signOut());

  return (
    <AuthScreen>
      <AuthHeader
        title={deletion ? 'Account scheduled for deletion' : 'Account suspended'}
        subtitle={deletion ? 'This account is being deleted and can no longer be used.' : 'Your account is currently suspended.'}
      />
      <Card>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Text style={[styles.subtitle, { marginTop: 0, marginBottom: 8 }]}>
          {deletion
            ? 'If you did not ask for this, contact NeighborShare support as soon as possible.'
            : 'You cannot use NeighborShare while your account is suspended. If you think this is a mistake, contact NeighborShare support.'}
        </Text>
        <PrimaryButton title="Check again" onPress={() => void recheck()} loading={checking} disabled={leaving} />
        <SecondaryButton title="Sign out" icon="log-out-outline" onPress={() => void leave()} disabled={checking || leaving} />
      </Card>
    </AuthScreen>
  );
}
