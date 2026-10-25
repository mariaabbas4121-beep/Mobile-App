import { useState } from 'react';
import { Text } from 'react-native';
import { useAuth } from '../../context/AuthContext';
import { errorMessage } from '../../lib/auth/messages';
import { useSubmit } from '../../components/auth/useSubmit';
import { AuthHeader, AuthScreen, Card, Notice, PrimaryButton, SecondaryButton, styles } from '../../components/auth/AuthUI';

// A saved session exists but the server could not be reached to load the
// account. The session is kept so the user does not have to sign in again.
export default function UnreachableScreen() {
  const { reloadAccount, signOut } = useAuth();
  const [error, setError] = useState<string | null>(null);

  const [retry, retrying] = useSubmit(async () => {
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
      <AuthHeader title="Can't reach NeighborShare" subtitle="Check your internet connection, then try again." />
      <Card>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Text style={[styles.subtitle, { marginTop: 0, marginBottom: 8 }]}>You are still signed in.</Text>
        <PrimaryButton title="Try again" onPress={() => void retry()} loading={retrying} disabled={leaving} />
        <SecondaryButton title="Sign out" icon="log-out-outline" onPress={() => void leave()} disabled={retrying || leaving} />
      </Card>
    </AuthScreen>
  );
}
