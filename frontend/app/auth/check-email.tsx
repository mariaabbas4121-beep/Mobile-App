import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '../../context/AuthContext';
import { isApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/auth/messages';
import { emailError } from '../../lib/auth/validation';
import { useSubmit } from '../../components/auth/useSubmit';
import { AuthHeader, AuthScreen, Card, Notice, PrimaryButton, SecondaryButton, styles } from '../../components/auth/AuthUI';

const RESEND_COOLDOWN_SECONDS = 60;

export default function CheckEmailScreen() {
  const router = useRouter();
  const { resendConfirmation } = useAuth();
  const params = useLocalSearchParams<{ email?: string; reason?: string }>();
  const email = typeof params.email === 'string' && !emailError(params.email) ? params.email : null;
  const unconfirmed = params.reason === 'unconfirmed';

  const [cooldown, setCooldown] = useState(0);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const [resend, resending] = useSubmit(async () => {
    if (!email) return;
    setNotice(null);
    try {
      await resendConfirmation(email);
      // The API answers the same way for every address, so this cannot say
      // an email was definitely sent.
      setNotice({ tone: 'success', text: 'If this address is waiting for confirmation, a new link is on its way.' });
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setNotice({ tone: 'error', text: errorMessage(err) });
      if (isApiError(err) && err.code === 'RATE_LIMITED') setCooldown(err.retryAfterSeconds ?? RESEND_COOLDOWN_SECONDS);
    }
  });

  return (
    <AuthScreen onBack={() => router.replace('/auth/login')}>
      <AuthHeader
        title={unconfirmed ? 'Confirm your email' : 'Check your inbox'}
        subtitle={
          unconfirmed
            ? 'Your email address has not been confirmed yet.'
            : 'If this address can be registered, we have sent it a confirmation link.'
        }
      />
      <Card>
        {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}

        <Text style={[styles.subtitle, { marginTop: 0 }]}>
          {email ? `Look for a message sent to ${email}. ` : ''}
          Open the link in it to confirm your address, then come back and sign in. It can take a few minutes to arrive, and
          it may be in your spam or promotions folder.
        </Text>

        <PrimaryButton title="Go to sign in" onPress={() => router.replace('/auth/login')} />
        {email ? (
          <SecondaryButton
            title={resending ? 'Sending…' : cooldown > 0 ? `Resend link (${cooldown}s)` : 'Resend confirmation link'}
            icon="refresh-outline"
            onPress={() => void resend()}
            disabled={resending || cooldown > 0}
          />
        ) : null}
        <SecondaryButton title="Use a different email" icon="create-outline" onPress={() => router.replace('/auth/signup')} />
      </Card>
    </AuthScreen>
  );
}
