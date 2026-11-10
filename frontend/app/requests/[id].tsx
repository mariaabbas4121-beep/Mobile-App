import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import { useBorrowRequests } from '../../context/BorrowRequestsContext';
import { useChat } from '../../context/ChatContext';
import type { BorrowRequest, HandoverState, PickupAuthorization, PickupAuthorizationStatus, ReturnState } from '../../lib/api/types';
import { DueDateCard, ReturnCard } from '../../components/returns/ReturnPanels';
import { errorMessage } from '../../lib/auth/messages';
import { formatRange } from '../../lib/borrow/dates';
import { AUTH_STATUS, when } from '../../lib/handover/format';
import { Colors, Radii, Shadows, Spacing, Typography } from '../../utils/theme';

const GREEN = Colors.green || '#2e7d32';
const DARK = Colors.greenDark || '#1b5e20';

function StatusChip({ status }: { status: PickupAuthorizationStatus }) {
  const s = AUTH_STATUS[status];
  return (
    <View style={[styles.chip, { backgroundColor: s.bg }]}>
      <Text style={[styles.chipText, { color: s.color }]}>{s.label}</Text>
    </View>
  );
}

function AuthorizationCard({ a, lending }: { a: PickupAuthorization; lending: boolean }) {
  return (
    <View style={styles.authCard} accessibilityLabel={`Authorization for ${a.recipientName}, ${AUTH_STATUS[a.status].label}`}>
      <View style={styles.rowBetween}>
        <Text style={styles.authName}>{a.recipientName}</Text>
        <StatusChip status={a.status} />
      </View>
      {a.recipientPhone ? <Text style={styles.meta}>Phone: {a.recipientPhone}</Text> : null}
      {a.note ? <Text style={styles.meta}>Note: {a.note}</Text> : null}
      <Text style={styles.meta}>
        {a.status === 'active'
          ? `${lending ? 'May collect' : 'Valid'} until ${when(a.expiresAt)}`
          : a.status === 'redeemed' && a.redeemedAt
            ? `Used ${when(a.redeemedAt)}`
            : a.status === 'revoked' && a.revokedAt
              ? `Revoked ${when(a.revokedAt)}`
              : `Expired ${when(a.expiresAt)}`}
      </Text>
    </View>
  );
}

// One borrow request with its pickup: who collects it, the QR state, and,
// once the owner confirms, when it was handed over and in what condition.
export default function RequestDetailsScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { get, handover: loadHandover, returnState: loadReturn, revokePickup, revision } = useBorrowRequests();
  const { openForRequest, handoverRevision } = useChat();
  const [request, setRequest] = useState<BorrowRequest | null>(null);
  const [state, setState] = useState<HandoverState | null>(null);
  // Loaded on its own: a failure here never hides the pickup.
  const [returns, setReturns] = useState<ReturnState | null>(null);
  const [returnsError, setReturnsError] = useState<unknown>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showSelfInfo, setShowSelfInfo] = useState(false);
  const latest = useRef(0);

  const load = useCallback(
    async (mode: 'initial' | 'quiet' | 'refresh') => {
      const ticket = ++latest.current;
      if (mode === 'refresh') setRefreshing(true);
      try {
        const r = await get(id);
        const accepted = r.status === 'accepted';
        const [h, ret] = await Promise.all([
          accepted ? loadHandover(id) : Promise.resolve(null),
          accepted ? loadReturn(id).then((x) => ({ ok: x }), (e: unknown) => ({ failed: e })) : Promise.resolve(null),
        ]);
        if (ticket !== latest.current) return;
        setRequest(r);
        setState(h);
        setReturns(ret && 'ok' in ret ? ret.ok : null);
        setReturnsError(ret && 'failed' in ret ? ret.failed : null);
        setStatus('ready');
      } catch (err) {
        if (ticket !== latest.current) return;
        setError(err);
        if (mode === 'initial') setStatus('error');
        else Toast.show({ type: 'error', text1: 'Could not refresh', text2: errorMessage(err) });
      } finally {
        if (ticket === latest.current) setRefreshing(false);
      }
    },
    [get, loadHandover, loadReturn, id],
  );

  useEffect(() => {
    void load('initial');
  }, [load]);
  // Changes here, on the other participant's device (socket hint), or on return.
  const seen = useRef({ revision, handoverRevision });
  useEffect(() => {
    if (seen.current.revision === revision && seen.current.handoverRevision === handoverRevision) return;
    seen.current = { revision, handoverRevision };
    void load('quiet');
  }, [revision, handoverRevision, load]);
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      void load('quiet');
    }, [load]),
  );

  const openChat = async () => {
    try {
      const conversation = await openForRequest(id);
      router.push(`/chat/${conversation.id}`);
    } catch (err) {
      Toast.show({ type: 'error', text1: 'Could not open chat', text2: errorMessage(err) });
    }
  };

  const revoke = (a: PickupAuthorization) =>
    Alert.alert(`Revoke ${a.recipientName}’s pickup?`, 'Their QR will stop working at once. You can authorize someone again afterwards.', [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Revoke',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await revokePickup(id, a.id);
            Toast.show({ type: 'success', text1: 'Authorization revoked' });
          } catch (err) {
            Toast.show({ type: 'error', text1: 'Could not revoke', text2: errorMessage(err) });
          } finally {
            setBusy(false);
            void load('quiet');
          }
        },
      },
    ]);

  const header = (
    <View style={styles.header}>
      <SafeAreaView edges={['top']}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Go back">
            <Ionicons name="arrow-back" size={20} color={Colors.navy} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Borrow request</Text>
          <View style={{ width: 40 }} />
        </View>
      </SafeAreaView>
    </View>
  );

  if (status !== 'ready' || !request) {
    return (
      <View style={styles.container}>
        {header}
        <View style={styles.centered}>
          {status === 'loading' ? (
            <ActivityIndicator size="large" color={GREEN} accessibilityLabel="Loading request" />
          ) : (
            <>
              <Text style={styles.title}>Could not load this request</Text>
              <Text style={styles.meta}>{errorMessage(error)}</Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={() => void load('initial')} accessibilityRole="button" accessibilityLabel="Try again">
                <Text style={styles.primaryText}>Try again</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    );
  }

  const lending = request.viewerRole === 'lender';
  const other = lending ? (request.borrower.displayName ?? 'The borrower') : (request.lender.displayName ?? 'The owner');
  const done = state?.handover ?? null;
  const active = state?.activeAuthorization ?? null;
  const past = (state?.authorizations ?? []).filter((a) => a.id !== active?.id);

  return (
    <View style={styles.container}>
      {header}
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load('refresh')} tintColor={GREEN} />}
      >
        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.title} numberOfLines={2}>{request.listing.title}</Text>
            <View style={[styles.chip, { backgroundColor: request.status === 'accepted' ? '#dbeafe' : Colors.fog }]}>
              <Text style={[styles.chipText, { color: request.status === 'accepted' ? '#1d4ed8' : Colors.slate }]}>
                {request.status === 'accepted' ? 'Accepted' : request.status[0]!.toUpperCase() + request.status.slice(1)}
              </Text>
            </View>
          </View>
          <Text style={styles.meta}>{lending ? `Borrower: ${other}` : `Owner: ${other}`}</Text>
          <Text style={styles.meta}>
            {formatRange(request.startDate, request.endDate)} · {request.days} {request.days === 1 ? 'day' : 'days'}
          </Text>
          {request.status === 'accepted' ? (
            <TouchableOpacity style={styles.secondaryBtn} onPress={() => void openChat()} accessibilityRole="button" accessibilityLabel={`Open chat with ${other}`}>
              <Ionicons name="chatbubbles-outline" size={16} color={DARK} />
              <Text style={styles.secondaryText}>Chat with {other}</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {request.status !== 'accepted' ? (
          <Text style={styles.note}>Pickup can be arranged once the request is accepted.</Text>
        ) : done ? (
          <View style={styles.card} accessibilityLabel="Pickup completed">
            <View style={styles.rowBetween}>
              <Text style={styles.sectionTitle}>Pickup</Text>
              <View style={[styles.chip, { backgroundColor: '#e8f5e9' }]}>
                <Text style={[styles.chipText, { color: DARK }]}>Handed over</Text>
              </View>
            </View>
            <Text style={styles.body1}>Handed over {when(done.confirmedAt)}</Text>
            <Text style={styles.meta}>
              {done.method === 'personal'
                ? `Collected in person by ${lending ? other : 'you'}`
                : `Collected by ${done.recipientName}${done.recipientPhone ? ` (${done.recipientPhone})` : ''}, authorized by ${lending ? other : 'you'}`}
            </Text>
            <Text style={styles.meta}>Confirmed by {lending ? 'you' : (done.confirmedBy.displayName ?? 'the owner')}</Text>
            <Text style={styles.label}>Condition at pickup</Text>
            <Text style={styles.meta}>{done.conditionNotes ?? 'No notes.'}</Text>
            {done.photos.length > 0 ? (
              <View style={styles.photos}>
                {done.photos.map((p) =>
                  p.url ? (
                    <Image key={p.id} source={{ uri: p.url }} style={styles.photo} accessibilityLabel="Condition photo" />
                  ) : (
                    <View key={p.id} style={[styles.photo, styles.photoMissing]}>
                      <Ionicons name="image-outline" size={18} color={Colors.slate} />
                    </View>
                  ),
                )}
              </View>
            ) : (
              <Text style={styles.meta}>No condition photos.</Text>
            )}
          </View>
        ) : (
          <View style={styles.card}>
            <View style={styles.rowBetween}>
              <Text style={styles.sectionTitle}>Pickup</Text>
              <View style={[styles.chip, { backgroundColor: '#fef3c7' }]}>
                <Text style={[styles.chipText, { color: '#92400e' }]}>Not picked up yet</Text>
              </View>
            </View>

            {lending ? (
              <>
                <Text style={styles.meta}>
                  {active
                    ? `${other} authorized someone else to collect it. Scan their QR, check their name, then confirm.`
                    : `${other} plans to collect it. When you hand it over, confirm it here.`}
                </Text>
                {active ? <AuthorizationCard a={active} lending /> : null}
                <TouchableOpacity
                  style={styles.primaryBtn}
                  onPress={() => router.push({ pathname: '/handover/confirm', params: { requestId: id, mode: 'scan' } })}
                  accessibilityRole="button"
                  accessibilityLabel="Scan pickup QR"
                >
                  <Ionicons name="qr-code-outline" size={16} color={Colors.white} />
                  <Text style={styles.primaryText}>Scan Pickup QR</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.secondaryBtn}
                  onPress={() => router.push({ pathname: '/handover/confirm', params: { requestId: id, mode: 'personal' } })}
                  accessibilityRole="button"
                  accessibilityLabel={`Confirm pickup by ${other}`}
                >
                  <Ionicons name="checkmark-circle-outline" size={16} color={DARK} />
                  <Text style={styles.secondaryText}>Confirm Pickup ({other} in person)</Text>
                </TouchableOpacity>
              </>
            ) : active ? (
              <>
                <Text style={styles.meta}>This person may collect the item with the one-time QR.</Text>
                <AuthorizationCard a={active} lending={false} />
                <TouchableOpacity
                  style={styles.primaryBtn}
                  onPress={() => router.push({ pathname: '/handover/authorize', params: { requestId: id, authorizationId: active.id } })}
                  accessibilityRole="button"
                  accessibilityLabel="Show pickup QR"
                >
                  <Ionicons name="qr-code-outline" size={16} color={Colors.white} />
                  <Text style={styles.primaryText}>Show or share QR</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.dangerBtn}
                  onPress={() => revoke(active)}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={`Revoke ${active.recipientName}’s authorization`}
                >
                  <Text style={styles.dangerText}>Revoke</Text>
                </TouchableOpacity>
                <Text style={styles.small}>Collecting it yourself instead? Just meet the owner; their confirmation cancels this QR.</Text>
              </>
            ) : (
              <>
                <Text style={styles.meta}>How will the item be collected?</Text>
                <TouchableOpacity
                  style={styles.option}
                  onPress={() => setShowSelfInfo((v) => !v)}
                  accessibilityRole="button"
                  accessibilityLabel="Collect the item myself"
                  accessibilityState={{ expanded: showSelfInfo }}
                >
                  <Ionicons name="person-outline" size={20} color={DARK} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.optionTitle}>Collect the item myself</Text>
                    <Text style={styles.small}>Agree a time in chat. The owner confirms the handover in the app.</Text>
                  </View>
                </TouchableOpacity>
                {showSelfInfo ? (
                  <Text style={styles.note}>
                    Nothing else to set up. Meet {other}, check the item together, and they will confirm the pickup. You cannot mark it yourself.
                  </Text>
                ) : null}
                <TouchableOpacity
                  style={styles.option}
                  onPress={() => router.push({ pathname: '/handover/authorize', params: { requestId: id } })}
                  accessibilityRole="button"
                  accessibilityLabel="Authorize someone else to collect it"
                >
                  <Ionicons name="people-outline" size={20} color={DARK} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.optionTitle}>Authorize someone else to collect it</Text>
                    <Text style={styles.small}>A friend or relative shows a one-time QR. They do not need the app.</Text>
                  </View>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}

        {request.status === 'accepted' && returns ? (
          <>
            <DueDateCard request={request} state={returns} onChanged={() => void load('quiet')} />
            <ReturnCard request={request} state={returns} onChanged={() => void load('quiet')} />
          </>
        ) : request.status === 'accepted' && returnsError ? (
          <Text style={styles.note} accessibilityRole="alert">
            Return and due-date details could not be loaded. {errorMessage(returnsError)} Pull down to try again.
          </Text>
        ) : null}

        {request.status === 'accepted' && past.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Earlier authorizations</Text>
            {past.map((a) => (
              <AuthorizationCard key={a.id} a={a} lending={lending} />
            ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.offWhite },
  header: { backgroundColor: Colors.white, paddingHorizontal: Spacing.xl, paddingBottom: Spacing.md, borderBottomWidth: 1, borderColor: Colors.fog, ...Shadows.sm },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: Spacing.sm },
  backBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.fog, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: Typography.sizes.md, fontWeight: Typography.weights.bold, color: Colors.navy },
  body: { padding: Spacing.xl, gap: Spacing.lg, paddingBottom: 60 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl, gap: Spacing.sm },
  card: { backgroundColor: Colors.white, borderRadius: Radii.lg, padding: Spacing.lg, gap: Spacing.sm, borderWidth: 1, borderColor: Colors.fog, ...Shadows.sm },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.sm },
  title: { flex: 1, fontSize: Typography.sizes.lg, fontWeight: Typography.weights.bold, color: DARK },
  sectionTitle: { fontSize: Typography.sizes.base, fontWeight: Typography.weights.bold, color: DARK },
  body1: { fontSize: Typography.sizes.base, color: Colors.navy, fontWeight: Typography.weights.semibold },
  label: { fontSize: Typography.sizes.sm, fontWeight: Typography.weights.bold, color: Colors.navy, marginTop: Spacing.xs },
  meta: { fontSize: Typography.sizes.sm, color: Colors.slate },
  small: { fontSize: Typography.sizes.xs, color: Colors.slate },
  note: { fontSize: Typography.sizes.sm, color: Colors.navyMid, backgroundColor: '#f1f8e9', borderRadius: Radii.md, padding: Spacing.md },
  chip: { borderRadius: Radii.full, paddingHorizontal: 8, paddingVertical: 3 },
  chipText: { fontSize: 11, fontWeight: Typography.weights.bold },
  authCard: { borderWidth: 1, borderColor: Colors.fog, borderRadius: Radii.md, padding: Spacing.md, gap: 2 },
  authName: { fontSize: Typography.sizes.base, fontWeight: Typography.weights.bold, color: Colors.navy },
  option: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, borderWidth: 1, borderColor: Colors.fog, borderRadius: Radii.md, padding: Spacing.md },
  optionTitle: { fontSize: Typography.sizes.base, fontWeight: Typography.weights.semibold, color: Colors.navy },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: GREEN, borderRadius: Radii.full,
    paddingVertical: Spacing.sm + 2, paddingHorizontal: Spacing.lg, marginTop: Spacing.xs,
  },
  primaryText: { color: Colors.white, fontWeight: Typography.weights.bold, fontSize: Typography.sizes.sm },
  secondaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderColor: GREEN, borderRadius: Radii.full,
    paddingVertical: Spacing.sm + 2, paddingHorizontal: Spacing.lg, marginTop: Spacing.xs,
  },
  secondaryText: { color: DARK, fontWeight: Typography.weights.bold, fontSize: Typography.sizes.sm },
  dangerBtn: { alignItems: 'center', borderWidth: 1, borderColor: '#fca5a5', borderRadius: Radii.full, paddingVertical: Spacing.sm },
  dangerText: { color: '#b91c1c', fontWeight: Typography.weights.bold, fontSize: Typography.sizes.sm },
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  photo: { width: 72, height: 72, borderRadius: Radii.md },
  photoMissing: { backgroundColor: Colors.fog, alignItems: 'center', justifyContent: 'center' },
});
