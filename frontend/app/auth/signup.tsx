import { useRef, useState } from 'react';
import type { TextInput } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../../context/AuthContext';
import { isApiError } from '../../lib/api/client';
import { errorMessage, fieldErrorsFrom } from '../../lib/auth/messages';
import { normaliseEmail, validateSignup, type SignupErrors, type SignupForm } from '../../lib/auth/validation';
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

const FIELDS = ['displayName', 'email', 'password'] as const;

export default function SignupScreen() {
  const router = useRouter();
  const { signUp } = useAuth();
  const [form, setForm] = useState<SignupForm>({ displayName: '', email: '', password: '', confirmPassword: '' });
  const [errors, setErrors] = useState<SignupErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const google = useGoogleSignIn(setFormError);

  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);

  const set = (key: keyof SignupForm) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const [submit, submitting] = useSubmit(async () => {
    setFormError(null);
    const found = validateSignup(form);
    setErrors(found);
    if (Object.keys(found).length) return;

    try {
      const result = await signUp({ email: form.email, password: form.password, displayName: form.displayName });
      if (result.emailConfirmationRequired) {
        // The response is identical whether or not the address already has
        // an account, and email delivery is not guaranteed, so the next
        // screen does not claim an email was sent.
        router.replace({ pathname: '/auth/check-email', params: { email: normaliseEmail(form.email), reason: 'signup' } });
      }
      // Otherwise the account is signed in and navigation follows the auth state.
    } catch (err) {
      const fieldErrors = fieldErrorsFrom(err, FIELDS);
      if (isApiError(err) && err.code === 'WEAK_PASSWORD') {
        setErrors({ password: errorMessage(err) });
      } else if (Object.keys(fieldErrors).length) {
        setErrors(fieldErrors);
      } else {
        setFormError(errorMessage(err));
      }
    }
  });

  const busy = submitting || google.busy;

  return (
    <AuthScreen onBack={() => (router.canGoBack() ? router.back() : router.replace('/auth/welcome'))}>
      <AuthHeader title="Join the neighborhood" subtitle="Create your NeighborShare account" />

      <Card>
        {formError ? <Notice tone="error">{formError}</Notice> : null}

        <GoogleButton onPress={google.start} loading={google.busy} disabled={busy} />
        <Divider label="or sign up with email" />

        <Field
          label="Full name"
          icon="person-outline"
          value={form.displayName}
          onChangeText={set('displayName')}
          error={errors.displayName}
          placeholder="Your name"
          autoCapitalize="words"
          autoComplete="name"
          textContentType="name"
          returnKeyType="next"
          onSubmitEditing={() => emailRef.current?.focus()}
          editable={!busy}
        />
        <Field
          ref={emailRef}
          label="Email"
          icon="mail-outline"
          value={form.email}
          onChangeText={set('email')}
          error={errors.email}
          placeholder="you@example.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          textContentType="emailAddress"
          returnKeyType="next"
          onSubmitEditing={() => passwordRef.current?.focus()}
          editable={!busy}
        />
        <Field
          ref={passwordRef}
          label="Password"
          icon="lock-closed-outline"
          password
          value={form.password}
          onChangeText={set('password')}
          error={errors.password}
          hint="At least 8 characters, with a letter and a number."
          placeholder="Create a password"
          autoCapitalize="none"
          autoComplete="new-password"
          textContentType="newPassword"
          returnKeyType="next"
          onSubmitEditing={() => confirmRef.current?.focus()}
          editable={!busy}
        />
        <Field
          ref={confirmRef}
          label="Confirm password"
          icon="lock-closed-outline"
          password
          value={form.confirmPassword}
          onChangeText={set('confirmPassword')}
          error={errors.confirmPassword}
          placeholder="Repeat your password"
          autoCapitalize="none"
          autoComplete="new-password"
          textContentType="newPassword"
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
          editable={!busy}
        />

        <PrimaryButton title="Create account" onPress={() => void submit()} loading={submitting} disabled={busy} />
      </Card>

      <LinkRow text="Already a member?" link="Sign in" onPress={() => router.replace('/auth/login')} />
    </AuthScreen>
  );
}
