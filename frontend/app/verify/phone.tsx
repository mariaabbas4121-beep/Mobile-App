import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View, type TextInputInstance } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../context/AuthContext';
import { isApiError } from '../../lib/api/client';
import type { PhoneVerification } from '../../lib/api/types';
import { errorMessage, fieldErrorsFrom } from '../../lib/auth/messages';
import {
  COUNTRIES,
  DEFAULT_COUNTRY,
  cleanCode,
  codeError,
  maskPhone,
  secondsUntil,
  toE164,
  type Country,
} from '../../lib/verification/phone';
import { useSubmit } from '../../components/auth/useSubmit';
import {
  AuthHeader,
  AuthScreen,
  Card,
  Field,
  Notice,
  PrimaryButton,
  SecondaryButton,
  styles as ui,
} from '../../components/auth/AuthUI';
import { Colors, Radii, Spacing, Typography } from '../../utils/theme';

type Step = 'loading' | 'number' | 'code' | 'verified';
type Banner = { tone: 'error' | 'info' | 'success'; text: string } | null;

const isCooldown = (err: unknown) =>
  isApiError(err) &&
  err.code === 'RATE_LIMITED' &&
  typeof err.details === 'object' &&
  err.details !== null &&
  (err.details as { reason?: unknown }).reason === 'resend_cooldown';

// Tells the developer which Supabase setting is missing; users only see the
// plain message.
function warnIfSetupProblem(err: unknown) {
  if (!__DEV__ || !isApiError(err) || err.code !== 'PHONE_VERIFICATION_NOT_CONFIGURED') return;
  const reason = (err.details as { reason?: unknown } | null)?.reason;
  console.warn(`[phone] Server setup incomplete: ${String(reason)}. See backend/docs/SUPABASE.md (Phone verification).`);
}

// Phone verification for a signed-in account. Supabase Auth sends and checks
// the code through the backend; this screen never decides that a number is
// verified, it shows what the server reports. Codes are never logged.
export default function VerifyPhoneScreen() {
  const router = useRouter();
  const { getPhoneVerification, startPhoneVerification, resendPhoneVerification, confirmPhoneVerification } = useAuth();

  const [step, setStep] = useState<Step>('loading');
  const [verification, setVerification] = useState<PhoneVerification | null>(null);
  const [banner, setBanner] = useState<Banner>(null);

  const [country, setCountry] = useState<Country>(DEFAULT_COUNTRY);
  const [picking, setPicking] = useState(false);
  const [number, setNumber] = useState('');
  const [numberError, setNumberError] = useState<string | undefined>();
  // The full E.164 number the code was requested for. Kept in memory only.
  const [target, setTarget] = useState<string | null>(null);

  const [code, setCode] = useState('');
  const [codeErr, setCodeErr] = useState<string | undefined>();
  const [cooldown, setCooldown] = useState(0);
  const codeRef = useRef<TextInputInstance>(null);

  const codeLength = verification?.codeLength ?? 6;

  const load = useCallback(async () => {
    setBanner(null);
    try {
      const v = await getPhoneVerification();
      setVerification(v);
      setStep(v.status === 'verified' ? 'verified' : 'number');
      if (v.status === 'pending' && v.pendingPhone) {
        setBanner({ tone: 'info', text: `A code was requested for ${v.pendingPhone}. Enter that number again to continue.` });
      } else if (v.status === 'revoked' || v.status === 'expired') {
        setBanner({ tone: 'info', text: 'Your phone verification is no longer active. Verify your number again.' });
      }
    } catch (err) {
      warnIfSetupProblem(err);
      setStep('number');
      setBanner({ tone: 'error', text: errorMessage(err) });
    }
  }, [getPhoneVerification]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const goToCode = (phone: string, v: PhoneVerification | null, wait: number) => {
    setTarget(phone);
    setCode('');
    setCodeErr(undefined);
    if (v) setVerification(v);
    setCooldown(wait);
    setStep('code');
    setTimeout(() => codeRef.current?.focus(), 50);
  };

  const [send, sending] = useSubmit(async () => {
    setBanner(null);
    const parsed = toE164(country, number);
    if (!parsed.ok) {
      setNumberError(parsed.error);
      return;
    }
    setNumberError(undefined);
    try {
      const result = await startPhoneVerification(parsed.e164);
      if (!result.codeSent) {
        setVerification(result.verification);
        setStep('verified');
        return;
      }
      goToCode(parsed.e164, result.verification, secondsUntil(result.verification.resendAvailableAt));
      // The server knows only that the request was accepted, not that the
      // message arrived.
      setBanner({
        tone: 'info',
        text: `If ${maskPhone(parsed.e164)} can receive text messages, a code is on its way. It can take a minute to arrive.`,
      });
    } catch (err) {
      if (isCooldown(err) && isApiError(err)) {
        goToCode(parsed.e164, null, err.retryAfterSeconds ?? 60);
        setBanner({ tone: 'info', text: 'A code was requested a moment ago. Enter it below, or wait to request another.' });
        return;
      }
      warnIfSetupProblem(err);
      const fields = fieldErrorsFrom(err, ['phone'] as const);
      if (fields.phone) setNumberError(fields.phone);
      else setBanner({ tone: 'error', text: errorMessage(err) });
    }
  });

  const [resend, resending] = useSubmit(async () => {
    setBanner(null);
    try {
      const result = await resendPhoneVerification();
      setVerification(result.verification);
      if (!result.codeSent) {
        setStep('verified');
        return;
      }
      setCode('');
      setCooldown(secondsUntil(result.verification.resendAvailableAt));
      setBanner({ tone: 'info', text: 'If the number can receive text messages, a new code is on its way.' });
    } catch (err) {
      if (isApiError(err) && err.code === 'RATE_LIMITED') setCooldown(err.retryAfterSeconds ?? 60);
      setBanner({ tone: 'error', text: errorMessage(err) });
    }
  });

  const [verify, verifying] = useSubmit(async () => {
    if (!target) return;
    setBanner(null);
    const problem = codeError(code, codeLength);
    if (problem) {
      setCodeErr(problem);
      return;
    }
    setCodeErr(undefined);
    try {
      const v = await confirmPhoneVerification(target, code);
      setVerification(v);
      setCode('');
      setStep(v.status === 'verified' ? 'verified' : 'number');
    } catch (err) {
      // Never keep a rejected code on screen.
      setCode('');
      if (isApiError(err) && err.code === 'OTP_INVALID_OR_EXPIRED') setCodeErr(errorMessage(err));
      else setBanner({ tone: 'error', text: errorMessage(err) });
    }
  });

  const changeNumber = () => {
    setStep('number');
    setTarget(null);
    setCode('');
    setCodeErr(undefined);
    setBanner(null);
  };

  const done = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/profile'));
  const busy = sending || resending || verifying;

  if (step === 'loading') {
    return (
      <AuthScreen onBack={done}>
        <AuthHeader title="Verify your phone" />
        <ActivityIndicator color={Colors.green} accessibilityLabel="Loading verification status" />
      </AuthScreen>
    );
  }

  if (step === 'verified') {
    return (
      <AuthScreen onBack={done}>
        <AuthHeader title="Phone verified" subtitle="Neighbors can see that your account has a verified phone number." />
        <Card>
          <Notice tone="success">{`${verification?.phone ?? 'Your number'} is verified.`}</Notice>
          <PrimaryButton title="Done" onPress={done} />
          <SecondaryButton title="Use a different number" icon="create-outline" onPress={changeNumber} />
        </Card>
      </AuthScreen>
    );
  }

  if (step === 'code' && target) {
    return (
      <AuthScreen onBack={changeNumber}>
        <AuthHeader title="Enter the code" subtitle={`We sent a ${codeLength}-digit code by text message to ${maskPhone(target)}.`} />
        <Card>
          {banner ? <Notice tone={banner.tone}>{banner.text}</Notice> : null}
          <Field
            ref={codeRef}
            label="Verification code"
            icon="keypad-outline"
            value={code}
            onChangeText={(v) => {
              setCode(cleanCode(v, codeLength));
              if (codeErr) setCodeErr(undefined);
            }}
            error={codeErr}
            placeholder={'•'.repeat(codeLength)}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="sms-otp"
            maxLength={codeLength}
            returnKeyType="done"
            onSubmitEditing={() => void verify()}
            editable={!verifying}
          />
          <PrimaryButton title="Verify" onPress={() => void verify()} loading={verifying} disabled={busy || code.length !== codeLength} />
          <SecondaryButton
            title={resending ? 'Sending…' : cooldown > 0 ? `Resend code (${cooldown}s)` : 'Resend code'}
            icon="refresh-outline"
            onPress={() => void resend()}
            disabled={busy || cooldown > 0}
          />
          <SecondaryButton title="Change number" icon="create-outline" onPress={changeNumber} disabled={busy} />
        </Card>
        <Text style={[ui.hint, local.footnote]}>
          No code? Check the number is right and has signal. Codes expire after a short time; request a new one if needed.
        </Text>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen onBack={done}>
      <AuthHeader title="Verify your phone" subtitle="We'll text you a code to confirm this number belongs to you." />
      <Card>
        {banner ? <Notice tone={banner.tone}>{banner.text}</Notice> : null}

        <Text style={ui.label}>Country</Text>
        <TouchableOpacity
          style={local.countryButton}
          onPress={() => setPicking((p) => !p)}
          disabled={sending}
          accessibilityRole="button"
          accessibilityLabel={`Country: ${country.name}, +${country.dialCode}`}
          accessibilityHint="Choose the country of your phone number"
        >
          <Text style={local.countryText}>{`${country.flag}  ${country.name} (+${country.dialCode})`}</Text>
          <Ionicons name={picking ? 'chevron-up' : 'chevron-down'} size={18} color={Colors.green} />
        </TouchableOpacity>
        {picking ? (
          <View style={local.countryList} accessibilityRole="list">
            {COUNTRIES.map((c) => (
              <TouchableOpacity
                key={c.iso}
                style={[local.countryOption, c.iso === country.iso ? local.countryOptionSelected : null]}
                onPress={() => {
                  setCountry(c);
                  setPicking(false);
                  setNumberError(undefined);
                }}
                accessibilityRole="button"
                accessibilityLabel={`${c.name}, +${c.dialCode}`}
                accessibilityState={{ selected: c.iso === country.iso }}
              >
                <Text style={local.countryText}>{`${c.flag}  ${c.name}`}</Text>
                <Text style={local.dialCode}>{`+${c.dialCode}`}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        <Field
          label="Phone number"
          icon="call-outline"
          value={number}
          onChangeText={(v) => {
            setNumber(v);
            if (numberError) setNumberError(undefined);
          }}
          error={numberError}
          hint={`For example ${country.example}. Another country? Type the full number starting with +.`}
          placeholder={country.example}
          keyboardType="phone-pad"
          textContentType="telephoneNumber"
          autoComplete="tel"
          returnKeyType="send"
          onSubmitEditing={() => void send()}
          editable={!sending}
        />
        <PrimaryButton title="Send code" onPress={() => void send()} loading={sending} />
      </Card>
      <Text style={[ui.hint, local.footnote]}>
        Your number is used to verify your account and is not shown to other users. Standard text message rates may apply.
      </Text>
    </AuthScreen>
  );
}

const local = StyleSheet.create({
  countryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1.5,
    borderColor: Colors.fog,
    borderRadius: Radii.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    backgroundColor: Colors.offWhite,
    marginBottom: Spacing.base,
    minHeight: 48,
  },
  countryText: { fontSize: Typography.sizes.base, color: Colors.greenDark },
  countryList: {
    borderWidth: 1,
    borderColor: Colors.fog,
    borderRadius: Radii.md,
    marginTop: -Spacing.sm,
    marginBottom: Spacing.base,
    overflow: 'hidden',
  },
  countryOption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.fog,
    minHeight: 44,
  },
  countryOptionSelected: { backgroundColor: '#e8f5e9' },
  dialCode: { fontSize: Typography.sizes.base, color: Colors.slate },
  footnote: { textAlign: 'center', marginTop: Spacing.lg, paddingHorizontal: Spacing.md },
});
