import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '../../context/AuthContext';
import { errorMessage } from '../../lib/auth/messages';
import { AuthHeader, AuthScreen, Card, Notice, PrimaryButton, styles } from '../../components/auth/AuthUI';
import { Colors } from '../../utils/theme';

// Deep-link target for Google sign-in (neighborshare://auth/callback). Usually
// the browser session hands the redirect straight back to the sign-in call;
// on some Android devices the link also opens this route. Both paths share
// one code exchange (see lib/auth/googleAuth.ts), so the session is created
// once. Parameters are never logged.
export default function OAuthCallbackScreen() {
  const router = useRouter();
  const { completeOAuthCallback } = useAuth();
  const params = useLocalSearchParams();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    completeOAuthCallback(params)
      .then((outcome) => {
        // Success: the auth state changes and navigation leaves this screen.
        if (outcome === 'cancelled') router.replace('/auth/login');
      })
      .catch((err) => setError(errorMessage(err)));
    // Parameters are read once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <AuthScreen>
        <AuthHeader title="Sign-in not completed" />
        <Card>
          <Notice tone="error">{error}</Notice>
          <PrimaryButton title="Back to sign in" onPress={() => router.replace('/auth/login')} />
        </Card>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 }} accessibilityLiveRegion="polite">
        <ActivityIndicator size="large" color={Colors.green} />
        <Text style={styles.subtitle}>Finishing sign-in…</Text>
      </View>
    </AuthScreen>
  );
}
