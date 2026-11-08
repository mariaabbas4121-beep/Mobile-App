import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import Toast from 'react-native-toast-message';
import { useBorrowRequests } from '../../context/BorrowRequestsContext';
import { useChat } from '../../context/ChatContext';
import type { BorrowRequest, PickupAuthorization } from '../../lib/api/types';
import { errorMessage } from '../../lib/auth/messages';
import { AUTH_STATUS, when } from '../../lib/handover/format';
import { formatPickupCode } from '../../lib/handover/pickupCode';
import { sharePickupQr } from '../../lib/handover/share';
import { Colors, Radii, Shadows, Spacing, Typography } from '../../utils/theme';

const GREEN = Colors.green || '#2e7d32';
const DARK = Colors.greenDark || '#1b5e20';
const PHONE = /^\+?[0-9]{7,15}$/;

type Step =
  | { kind: 'loading' }
  | { kind: 'form' }
  | { kind: 'review' }
  | { kind: 'qr'; authorization: PickupAuthorization; code: string }
  // An existing authorization whose QR this device cannot show (created on
  // another device, or no longer usable).
  | { kind: 'unavailable'; authorization: PickupAuthorization | null }
  | { kind: 'error'; error: unknown };

const qrPayload = (code: string) => `neighborshare://pickup?v=1&code=${code}`;

// Borrower: authorize someone else to collect the item with a one-time QR.
// With `authorizationId`, shows the QR of an existing authorization again
// (only on the device that created it).
export default function AuthorizePickupScreen() {
  const router = useRouter();
  const { requestId, authorizationId } = useLocalSearchParams<{ requestId: string; authorizationId?: string }>();
  const { get, handover, authorizePickup, revokePickup, storedPickupCode } = useBorrowRequests();
  const { handoverChanged } = useChat();
  const [request, setRequest] = useState<BorrowRequest | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'loading' });
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const qrRef = useRef<{ toDataURL?: (cb: (data: string) => void) => void } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await get(requestId);
      setRequest(r);
      if (!authorizationId) {
        setStep({ kind: 'form' });
        return;
      }
      const state = await handover(requestId);
      const a = state.authorizations.find((x) => x.id === authorizationId) ?? null;
      const code = a?.status === 'active' ? await storedPickupCode(a.id) : null;
      setStep(a && code ? { kind: 'qr', authorization: a, code } : { kind: 'unavailable', authorization: a });
    } catch (err) {
      setStep({ kind: 'error', error: err });
    }
  }, [get, handover, storedPickupCode, requestId, authorizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const cleanPhone = phone.replace(/[\s()-]/g, '');
  const nameOk = name.trim().length >= 2;
  const phoneOk = cleanPhone === '' || PHONE.test(cleanPhone);

  const create = async () => {
    setBusy(true);
    setSubmitError(null);
    try {
      const created = await authorizePickup(requestId, {
        recipientName: name.trim(),
        recipientPhone: cleanPhone || null,
        note: note.trim() || null,
      });
      handoverChanged();
      setStep({ kind: 'qr', authorization: created.authorization, code: created.code });
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const share = async (authorization: PickupAuthorization, code: string) => {
    const png = await new Promise<string | null>((resolve) => {
      const ref = qrRef.current;
      if (!ref?.toDataURL) return resolve(null);
      try {
        ref.toDataURL((data) => resolve(data));
      } catch {
        resolve(null);
      }
    });
    try {
      await sharePickupQr({
        qrPngBase64: png,
        recipientName: authorization.recipientName,
        itemTitle: request?.listing.title ?? 'the item',
        displayCode: formatPickupCode(code),
        expiresAt: authorization.expiresAt,
      });
    } catch {
      Toast.show({ type: 'error', text1: 'Could not open the share sheet' });
    }
  };

  const revoke = (authorization: PickupAuthorization) =>
    Alert.alert(`Revoke ${authorization.recipientName}’s pickup?`, 'The QR stops working at once.', [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Revoke',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await revokePickup(requestId, authorization.id);
            handoverChanged();
            Toast.show({ type: 'success', text1: 'Authorization revoked' });
            router.back();
          } catch (err) {
            Toast.show({ type: 'error', text1: 'Could not revoke', text2: errorMessage(err) });
          } finally {
            setBusy(false);
          }
        },
      },
    ]);

  const header = (
    <View style={styles.header}>
      <SafeAreaView edges={['top']}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Close">
            <Ionicons name="close" size={20} color={Colors.navy} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Authorize pickup</Text>
          <View style={{ width: 40 }} />
        </View>
      </SafeAreaView>
    </View>
  );

  let content: React.ReactNode;
  if (step.kind === 'loading') {
    content = <ActivityIndicator size="large" color={GREEN} style={{ marginTop: 60 }} accessibilityLabel="Loading" />;
  } else if (step.kind === 'error') {
    content = (
      <View style={styles.card}>
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.meta}>{errorMessage(step.error)}</Text>
        <TouchableOpacity style={styles.primaryBtn} onPress={() => void load()} accessibilityRole="button" accessibilityLabel="Try again">
          <Text style={styles.primaryText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (step.kind === 'form') {
    content = (
      <View style={styles.card}>
        <Text style={styles.title}>Who will collect {request?.listing.title}?</Text>
        <Text style={styles.meta}>They do not need NeighborShare. They show a one-time QR to {request?.lender.displayName ?? 'the owner'}.</Text>
        <Text style={styles.label}>Their name (required)</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="e.g. Ali Khan" maxLength={80} accessibilityLabel="Authorized person's name" />
        {name.length > 0 && !nameOk ? <Text style={styles.error}>Enter at least 2 characters.</Text> : null}
        <Text style={styles.label}>Their phone number (optional)</Text>
        <TextInput
          style={styles.input}
          value={phone}
          onChangeText={setPhone}
          placeholder="e.g. 0300 1234567"
          keyboardType="phone-pad"
          maxLength={20}
          accessibilityLabel="Authorized person's phone number"
        />
        {!phoneOk ? <Text style={styles.error}>Enter a phone number of 7 to 15 digits, or leave it empty.</Text> : null}
        <Text style={styles.label}>Note for the owner (optional)</Text>
        <TextInput
          style={[styles.input, { minHeight: 60 }]}
          value={note}
          onChangeText={setNote}
          placeholder="e.g. My brother, around 5 pm"
          maxLength={200}
          multiline
          accessibilityLabel="Note for the owner"
        />
        <Text style={styles.small}>Only you and the owner see these details. No ID numbers are needed.</Text>
        <TouchableOpacity
          style={[styles.primaryBtn, !(nameOk && phoneOk) && styles.disabled]}
          disabled={!(nameOk && phoneOk)}
          onPress={() => setStep({ kind: 'review' })}
          accessibilityRole="button"
          accessibilityLabel="Review authorization"
          accessibilityState={{ disabled: !(nameOk && phoneOk) }}
        >
          <Text style={styles.primaryText}>Review</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (step.kind === 'review') {
    content = (
      <View style={styles.card}>
        <Text style={styles.title}>Confirm authorization</Text>
        <Text style={styles.meta}>
          You are allowing <Text style={styles.strong}>{name.trim()}</Text>
          {cleanPhone ? ` (${cleanPhone})` : ''} to collect <Text style={styles.strong}>{request?.listing.title}</Text> on your behalf.
        </Text>
        {note.trim() ? <Text style={styles.meta}>Note: {note.trim()}</Text> : null}
        <Text style={styles.note}>
          Anyone holding the QR can collect the item, once, until it expires. Share it only with {name.trim()}. You can revoke it while it is unused.
        </Text>
        {submitError ? <Text style={styles.error} accessibilityRole="alert">{submitError}</Text> : null}
        <TouchableOpacity
          style={[styles.primaryBtn, busy && styles.disabled]}
          disabled={busy}
          onPress={() => void create()}
          accessibilityRole="button"
          accessibilityLabel="Confirm and create QR"
        >
          {busy ? <ActivityIndicator size="small" color={Colors.white} /> : null}
          <Text style={styles.primaryText}>Confirm and create QR</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryBtn} onPress={() => setStep({ kind: 'form' })} accessibilityRole="button" accessibilityLabel="Edit details">
          <Text style={styles.secondaryText}>Edit details</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (step.kind === 'qr') {
    const { authorization, code } = step;
    content = (
      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.title}>{authorization.recipientName} can collect it</Text>
          <View style={[styles.chip, { backgroundColor: AUTH_STATUS[authorization.status].bg }]}>
            <Text style={[styles.chipText, { color: AUTH_STATUS[authorization.status].color }]}>{AUTH_STATUS[authorization.status].label}</Text>
          </View>
        </View>
        <Text style={styles.meta}>Valid once, until {when(authorization.expiresAt)}.</Text>
        <View style={styles.qrBox} accessibilityLabel="Pickup QR code">
          <QRCode value={qrPayload(code)} size={220} getRef={(c: unknown) => (qrRef.current = c as typeof qrRef.current)} />
        </View>
        <Text style={styles.small}>Can’t scan? The owner can type this code:</Text>
        <Text style={styles.code} selectable accessibilityLabel="Pickup code">
          {formatPickupCode(code)}
        </Text>
        <TouchableOpacity style={styles.primaryBtn} onPress={() => void share(authorization, code)} accessibilityRole="button" accessibilityLabel="Share QR">
          <Ionicons name="share-outline" size={16} color={Colors.white} />
          <Text style={styles.primaryText}>Share with {authorization.recipientName}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.dangerBtn}
          disabled={busy}
          onPress={() => revoke(authorization)}
          accessibilityRole="button"
          accessibilityLabel="Revoke authorization"
        >
          <Text style={styles.dangerText}>Revoke</Text>
        </TouchableOpacity>
      </View>
    );
  } else {
    const a = step.authorization;
    content = (
      <View style={styles.card}>
        <Text style={styles.title}>
          {!a ? 'Authorization not found' : a.status === 'active' ? 'QR not available on this device' : `This authorization is ${AUTH_STATUS[a.status].label.toLowerCase()}`}
        </Text>
        <Text style={styles.meta}>
          {!a
            ? 'It may have been removed.'
            : a.status === 'active'
              ? 'For security the code is shown only on the device that created it. Revoke it and create a new one to share again.'
              : a.status === 'redeemed'
                ? 'It was used to collect the item.'
                : 'It can no longer be used. You can authorize someone again from the request.'}
        </Text>
        {a?.status === 'active' ? (
          <TouchableOpacity style={styles.dangerBtn} disabled={busy} onPress={() => revoke(a)} accessibilityRole="button" accessibilityLabel="Revoke authorization">
            <Text style={styles.dangerText}>Revoke</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {header}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {content}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.offWhite },
  header: { backgroundColor: Colors.white, paddingHorizontal: Spacing.xl, paddingBottom: Spacing.md, borderBottomWidth: 1, borderColor: Colors.fog, ...Shadows.sm },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: Spacing.sm },
  backBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.fog, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: Typography.sizes.md, fontWeight: Typography.weights.bold, color: Colors.navy },
  body: { padding: Spacing.xl, paddingBottom: 60 },
  card: { backgroundColor: Colors.white, borderRadius: Radii.lg, padding: Spacing.lg, gap: Spacing.sm, borderWidth: 1, borderColor: Colors.fog, ...Shadows.sm },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.sm },
  title: { flexShrink: 1, fontSize: Typography.sizes.lg, fontWeight: Typography.weights.bold, color: DARK },
  strong: { fontWeight: Typography.weights.bold, color: Colors.navy },
  label: { fontSize: Typography.sizes.sm, fontWeight: Typography.weights.bold, color: Colors.navy, marginTop: Spacing.xs },
  meta: { fontSize: Typography.sizes.sm, color: Colors.slate },
  small: { fontSize: Typography.sizes.xs, color: Colors.slate },
  note: { fontSize: Typography.sizes.sm, color: Colors.navyMid, backgroundColor: '#fef3c7', borderRadius: Radii.md, padding: Spacing.md },
  error: { fontSize: Typography.sizes.sm, color: '#b91c1c' },
  input: {
    borderWidth: 1, borderColor: Colors.fog, borderRadius: Radii.md, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    fontSize: Typography.sizes.base, color: Colors.navy, backgroundColor: Colors.offWhite,
  },
  chip: { borderRadius: Radii.full, paddingHorizontal: 8, paddingVertical: 3 },
  chipText: { fontSize: 11, fontWeight: Typography.weights.bold },
  qrBox: { alignSelf: 'center', padding: Spacing.lg, backgroundColor: Colors.white, borderRadius: Radii.lg, borderWidth: 1, borderColor: Colors.fog, marginVertical: Spacing.sm },
  code: { textAlign: 'center', fontSize: Typography.sizes.base, fontWeight: Typography.weights.bold, color: Colors.navy, letterSpacing: 1 },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: GREEN, borderRadius: Radii.full,
    paddingVertical: Spacing.sm + 2, paddingHorizontal: Spacing.lg, marginTop: Spacing.sm,
  },
  primaryText: { color: Colors.white, fontWeight: Typography.weights.bold, fontSize: Typography.sizes.sm },
  secondaryBtn: { alignItems: 'center', borderWidth: 1, borderColor: GREEN, borderRadius: Radii.full, paddingVertical: Spacing.sm },
  secondaryText: { color: DARK, fontWeight: Typography.weights.bold, fontSize: Typography.sizes.sm },
  dangerBtn: { alignItems: 'center', borderWidth: 1, borderColor: '#fca5a5', borderRadius: Radii.full, paddingVertical: Spacing.sm, marginTop: Spacing.xs },
  dangerText: { color: '#b91c1c', fontWeight: Typography.weights.bold, fontSize: Typography.sizes.sm },
  disabled: { opacity: 0.5 },
});
