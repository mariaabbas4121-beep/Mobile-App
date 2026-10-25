import { useRef, useState } from 'react';
import type { TextInput } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../../context/AuthContext';
import { isApiError } from '../../lib/api/client';
import { errorMessage, fieldErrorsFrom } from '../../lib/auth/messages';
import { normaliseEmail, validateLogin } from '../../lib/auth/validation';
import { useSubmit } from '../../components/auth/useSubmit';
import { useGoogleSignIn } from '../../components/auth/useGoogleSignIn';
import {
  AuthHeader,
  AuthScreen,
  Card,
  Divider,
  Field,
  GoogleButton,
  LinkRow,
  Notice,
  PrimaryButton,
} from '../../components/auth/AuthUI';

export default function LoginScreen() {
  const router = useRouter();
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const google = useGoogleSignIn(setFormError);
  const passwordRef = useRef<TextInput>(null);

  const [submit, submitting] = useSubmit(async () => {
    setFormError(null);
    const found = validateLogin({ email, password });
    setErrors(found);
    if (Object.keys(found).length) return;

    try {
      await signIn(email, password);
      // Navigation follows the auth state.
    } catch (err) {
      if (isApiError(err) && err.code === 'EMAIL_NOT_CONFIRMED') {
        router.push({ pathname: '/auth/check-email', params: { email: normaliseEmail(email), reason: 'unconfirmed' } });
        return;
      }
      const fieldErrors = fieldErrorsFrom(err, ['email', 'password'] as const);
      if (Object.keys(fieldErrors).length) setErrors(fieldErrors);
      else setFormError(errorMessage(err));
      // Never keep a rejected password in the field.
      if (isApiError(err) && err.code === 'INVALID_CREDENTIALS') setPassword('');
    }
  });

  const busy = submitting || google.busy;

  return (
    <AuthScreen onBack={() => (router.canGoBack() ? router.back() : router.replace('/auth/welcome'))}>
      <AuthHeader title="Welcome back" subtitle="Sign in to your NeighborShare account" />

      <Card>
        {formError ? <Notice tone="error">{formError}</Notice> : null}

        <GoogleButton onPress={google.start} loading={google.busy} disabled={busy} />
        <Divider label="or sign in with email" />

        <Field
          label="Email"
          icon="mail-outline"
          value={email}
          onChangeText={(v) => {
            setEmail(v);
            if (errors.email) setErrors((e) => ({ ...e, email: undefined }));
          }}
          error={errors.email}
          placeholder="you@example.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          textContentType="username"
          returnKeyType="next"
          onSubmitEditing={() => passwordRef.current?.focus()}
          editable={!busy}
        />
        <Field
          ref={passwordRef}
          label="Password"
          icon="lock-closed-outline"
          password
          value={password}
          onChangeText={(v) => {
            setPassword(v);
            if (errors.password) setErrors((e) => ({ ...e, password: undefined }));
          }}
          error={errors.password}
          placeholder="Your password"
          autoCapitalize="none"
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
          editable={!busy}
        />

        <PrimaryButton title="Sign in" onPress={() => void submit()} loading={submitting} disabled={busy} />
      </Card>

      <LinkRow text="Don't have an account?" link="Sign up" onPress={() => router.replace('/auth/signup')} />
    </AuthScreen>
  );
}
