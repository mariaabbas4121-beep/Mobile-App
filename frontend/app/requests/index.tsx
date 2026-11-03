import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Image, RefreshControl, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import { useBorrowRequests, type BorrowAction } from '../../context/BorrowRequestsContext';
import { useChat } from '../../context/ChatContext';
import { isApiError } from '../../lib/api/client';
import type { BorrowRequest, BorrowRole, BorrowStatus } from '../../lib/api/types';
import { errorMessage } from '../../lib/auth/messages';
import { formatRange } from '../../lib/borrow/dates';
import { Colors, Radii, Shadows, Spacing, Typography } from '../../utils/theme';

type Tab = 'borrowing' | 'lending';
// What a card is busy with: a decision, or opening its chat.
type CardBusy = BorrowAction | 'chat';

const STATUS: Record<BorrowStatus, { label: string; color: string; bg: string; icon: string }> = {
  pending: { label: 'Waiting for answer', color: '#b45309', bg: '#fef3c7', icon: 'time-outline' },
  accepted: { label: 'Accepted', color: '#1d4ed8', bg: '#dbeafe', icon: 'checkmark-circle-outline' },
  declined: { label: 'Declined', color: '#b91c1c', bg: '#fee2e2', icon: 'close-circle-outline' },
  cancelled: { label: 'Cancelled', color: Colors.slate, bg: Colors.fog, icon: 'remove-circle-outline' },
};

const submittedOn = (iso: string) => {
  const d = new Date(iso);
  return `Sent ${d.toLocaleDateString()}`;
};

function RequestCard({
  request,
  busy,
  error,
  onAction,
  onOpenListing,
  onOpenChat,
}: {
  request: BorrowRequest;
  busy: CardBusy | null;
  error: string | null;
  onAction: (action: BorrowAction) => void;
  onOpenListing: () => void;
  onOpenChat: () => void;
}) {
  const cfg = STATUS[request.status];
  const lending = request.viewerRole === 'lender';
  const other = lending ? request.borrower.displayName ?? 'A neighbor' : request.lender.displayName ?? 'The owner';
  const pending = request.status === 'pending';

  return (
    <View style={styles.card} accessibilityLabel={`Request for ${request.listing.title}`}>
      <TouchableOpacity style={styles.cardTop} onPress={onOpenListing} disabled={request.listing.archived} accessibilityRole="link">
        {request.listing.imageUrl ? (
          <Image source={{ uri: request.listing.imageUrl }} style={styles.thumb} />
        ) : (
          <View style={[styles.thumb, styles.thumbEmpty]}>
            <Ionicons name="image-outline" size={20} color={Colors.slate} />
          </View>
        )}
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle} numberOfLines={1}>{request.listing.title}</Text>
          <Text style={styles.cardRole} numberOfLines={1}>
            {lending ? `${other} wants to borrow this` : `Owner: ${other}`}
          </Text>
          {request.listing.archived ? <Text style={styles.archived}>Listing removed</Text> : null}
        </View>
        <View style={[styles.statusChip, { backgroundColor: cfg.bg }]}>
          <Ionicons name={cfg.icon as never} size={12} color={cfg.color} />
          <Text style={[styles.statusText, { color: cfg.color }]}>{cfg.label}</Text>
        </View>
      </TouchableOpacity>

      <View style={styles.datesRow}>
        <Ionicons name="calendar-outline" size={15} color={Colors.sage} />
        <Text style={styles.datesText}>
          {formatRange(request.startDate, request.endDate)} · {request.days} {request.days === 1 ? 'day' : 'days'}
        </Text>
        <Text style={styles.sent}>{submittedOn(request.createdAt)}</Text>
      </View>

      {request.message ? (
        <Text style={styles.message}>
          {lending ? '“' : 'Your note: “'}
          {request.message}”
        </Text>
      ) : null}

      {request.status === 'accepted' ? (
        <Text style={styles.reserved}>These dates are reserved for {lending ? other : 'you'}.</Text>
      ) : null}
      {request.status === 'accepted' ? (
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.chatBtn]}
            onPress={onOpenChat}
            disabled={busy !== null}
            accessibilityRole="button"
            accessibilityLabel={`Open chat about ${request.listing.title}`}
          >
            {busy === 'chat' ? (
              <ActivityIndicator size="small" color={Colors.white} />
            ) : (
              <Ionicons name="chatbubbles-outline" size={16} color={Colors.white} />
            )}
            <Text style={[styles.actionText, { color: Colors.white }]}>Open chat with {other}</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {error ? <Text style={styles.cardError} accessibilityRole="alert">{error}</Text> : null}

      {pending && lending ? (
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.declineBtn]}
            onPress={() => onAction('decline')}
            disabled={busy !== null}
            accessibilityRole="button"
            accessibilityLabel={`Decline request for ${request.listing.title}`}
          >
            {busy === 'decline' ? <ActivityIndicator size="small" color={Colors.rose} /> : null}
            <Text style={[styles.actionText, { color: Colors.rose }]}>Decline</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, styles.acceptBtn]}
            onPress={() => onAction('accept')}
            disabled={busy !== null}
            accessibilityRole="button"
            accessibilityLabel={`Accept request for ${request.listing.title}`}
          >
            {busy === 'accept' ? <ActivityIndicator size="small" color={Colors.white} /> : null}
            <Text style={[styles.actionText, { color: Colors.white }]}>Accept</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {pending && !lending ? (
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.declineBtn]}
            onPress={() => onAction('cancel')}
            disabled={busy !== null}
            accessibilityRole="button"
            accessibilityLabel={`Cancel request for ${request.listing.title}`}
          >
            {busy === 'cancel' ? <ActivityIndicator size="small" color={Colors.rose} /> : null}
            <Text style={[styles.actionText, { color: Colors.rose }]}>Cancel request</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

// Borrowing: requests I sent. Lending: requests for my items.
export default function BorrowRequestsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<Tab>(params.tab === 'lending' ? 'lending' : 'borrowing');
  // Stable functions only: the context value itself changes on every revision.
  const { listOutgoing, listIncoming, act, revision } = useBorrowRequests();
  const { openForRequest } = useChat();

  const [items, setItems] = useState<BorrowRequest[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<{ id: string; action: CardBusy } | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const latest = useRef(0);

  const role: BorrowRole = tab === 'borrowing' ? 'borrower' : 'lender';
  const load = useCallback(
    async (mode: 'initial' | 'quiet' | 'refresh') => {
      const ticket = ++latest.current;
      if (mode === 'initial') setStatus('loading');
      if (mode === 'refresh') setRefreshing(true);
      try {
        const page = await (role === 'borrower' ? listOutgoing() : listIncoming());
        if (ticket !== latest.current) return;
        setItems(page.items);
        setLoadError(null);
        setStatus('ready');
      } catch (err) {
        if (ticket !== latest.current) return;
        setLoadError(err);
        if (mode === 'initial') setStatus('error');
        else Toast.show({ type: 'error', text1: 'Could not refresh requests', text2: errorMessage(err) });
      } finally {
        if (ticket === latest.current) setRefreshing(false);
      }
    },
    [listOutgoing, listIncoming, role],
  );

  useEffect(() => {
    setCardErrors({});
    void load('initial');
  }, [load]);

  // After any change (here or elsewhere), and when coming back to the screen.
  const seen = useRef(revision);
  useEffect(() => {
    if (revision !== seen.current) {
      seen.current = revision;
      void load('quiet');
    }
    // Keyed on revision only; a tab change is handled by the effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);
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

  const run = async (request: BorrowRequest, action: BorrowAction) => {
    if (busy) return;
    setBusy({ id: request.id, action });
    setCardErrors(({ [request.id]: _drop, ...rest }) => rest);
    let accepted = false;
    try {
      await act(request.id, action);
      accepted = action === 'accept';
      Toast.show({
        type: 'success',
        text1: action === 'accept' ? 'Request accepted' : action === 'decline' ? 'Request declined' : 'Request cancelled',
        ...(action === 'accept' ? { text2: `${formatRange(request.startDate, request.endDate)} is now reserved` } : {}),
      });
    } catch (err) {
      const text =
        isApiError(err) && err.code === 'DATES_UNAVAILABLE'
          ? 'These dates are no longer available: another request for them was accepted. You can decline this one.'
          : errorMessage(err);
      setCardErrors((e) => ({ ...e, [request.id]: text }));
    } finally {
      setBusy(null);
    }
    // Straight to the conversation so the lender can arrange the pickup. The
    // request is already accepted whatever happens here.
    if (accepted) {
      try {
        const conversation = await openForRequest(request.id);
        router.push(`/chat/${conversation.id}`);
      } catch {
        Toast.show({ type: 'info', text1: 'Request accepted', text2: 'Open the chat from the Chat tab or this request when you are ready.' });
      }
    }
  };

  const openChat = async (request: BorrowRequest) => {
    if (busy) return;
    setBusy({ id: request.id, action: 'chat' });
    setCardErrors(({ [request.id]: _drop, ...rest }) => rest);
    try {
      const conversation = await openForRequest(request.id);
      router.push(`/chat/${conversation.id}`);
    } catch (err) {
      setCardErrors((e) => ({ ...e, [request.id]: errorMessage(err) }));
    } finally {
      setBusy(null);
    }
  };

  const onAction = (request: BorrowRequest, action: BorrowAction) => {
    if (action === 'accept') return void run(request, action);
    Alert.alert(
      action === 'cancel' ? 'Cancel this request?' : 'Decline this request?',
      action === 'cancel' ? 'The owner will no longer see it as pending.' : 'The borrower will see that you declined.',
      [
        { text: 'Keep it', style: 'cancel' },
        { text: action === 'cancel' ? 'Cancel request' : 'Decline', style: 'destructive', onPress: () => void run(request, action) },
      ],
    );
  };

  const renderEmpty = () => {
    if (status === 'loading') {
      return <ActivityIndicator style={styles.spinner} size="large" color={Colors.sage} accessibilityLabel="Loading requests" />;
    }
    if (status === 'error') {
      return (
        <View style={styles.empty}>
          <Text style={styles.emptyEmoji}>📡</Text>
          <Text style={styles.emptyTitle}>Could not load requests</Text>
          <Text style={styles.emptyDesc}>{errorMessage(loadError)}</Text>
          <TouchableOpacity style={styles.retry} onPress={() => void load('initial')} accessibilityRole="button" accessibilityLabel="Try again">
            <Text style={styles.retryText}>Try again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyEmoji}>{tab === 'borrowing' ? '🔍' : '📦'}</Text>
        <Text style={styles.emptyTitle}>{tab === 'borrowing' ? 'No borrow requests yet' : 'No requests for your items yet'}</Text>
        <Text style={styles.emptyDesc}>
          {tab === 'borrowing' ? 'Find an item on Browse and tap “Request to Borrow”.' : 'When a neighbor asks to borrow something you listed, it shows up here.'}
        </Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <SafeAreaView edges={['top']}>
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityLabel="Go back">
              <Ionicons name="arrow-back" size={20} color={Colors.navy} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Borrow requests</Text>
            <View style={{ width: 40 }} />
          </View>
          <View style={styles.tabs} accessibilityRole="tablist">
            {(['borrowing', 'lending'] as const).map((t) => (
              <TouchableOpacity
                key={t}
                style={[styles.tab, tab === t && styles.tabActive]}
                onPress={() => setTab(t)}
                accessibilityRole="tab"
                accessibilityState={{ selected: tab === t }}
              >
                <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
                  {t === 'borrowing' ? 'Borrowing' : 'Lending'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </SafeAreaView>
      </View>

      <FlatList
        testID="requests-list"
        data={status === 'ready' ? items : []}
        keyExtractor={(r) => r.id}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={() => <View style={{ height: Spacing.md }} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load('refresh')} tintColor={Colors.sage} />}
        ListEmptyComponent={renderEmpty()}
        renderItem={({ item }) => (
          <RequestCard
            request={item}
            busy={busy?.id === item.id ? busy.action : null}
            error={cardErrors[item.id] ?? null}
            onAction={(action) => onAction(item, action)}
            onOpenListing={() => router.push(`/item/${item.listing.id}`)}
            onOpenChat={() => void openChat(item)}
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.offWhite },
  header: { backgroundColor: Colors.white, paddingHorizontal: Spacing.xl, paddingBottom: Spacing.md, borderBottomWidth: 1, borderColor: Colors.fog, ...Shadows.sm },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: Spacing.sm },
  backBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.fog, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: Typography.sizes.md, fontWeight: Typography.weights.bold, color: Colors.navy },
  tabs: { flexDirection: 'row', backgroundColor: Colors.offWhite, borderRadius: Radii.full, padding: 4, marginTop: Spacing.md },
  tab: { flex: 1, paddingVertical: Spacing.sm, borderRadius: Radii.full, alignItems: 'center' },
  tabActive: { backgroundColor: Colors.white, ...Shadows.sm },
  tabText: { fontSize: Typography.sizes.sm, fontWeight: Typography.weights.semibold, color: Colors.slate },
  tabTextActive: { color: Colors.navy, fontWeight: Typography.weights.bold },
  list: { padding: Spacing.xl, paddingBottom: 60 },
  card: { backgroundColor: Colors.white, borderRadius: Radii.lg, padding: Spacing.md, borderWidth: 1, borderColor: Colors.fog, ...Shadows.sm },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  thumb: { width: 48, height: 48, borderRadius: Radii.md },
  thumbEmpty: { backgroundColor: Colors.fog, alignItems: 'center', justifyContent: 'center' },
  cardHead: { flex: 1 },
  cardTitle: { fontSize: Typography.sizes.base, fontWeight: Typography.weights.bold, color: Colors.navy },
  cardRole: { fontSize: Typography.sizes.xs, color: Colors.slate, marginTop: 2 },
  archived: { fontSize: Typography.sizes.xs, color: Colors.rose, marginTop: 2 },
  statusChip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: Radii.full, paddingHorizontal: 8, paddingVertical: 3 },
  statusText: { fontSize: 11, fontWeight: Typography.weights.bold },
  datesRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: Spacing.md },
  datesText: { flex: 1, fontSize: Typography.sizes.sm, fontWeight: Typography.weights.semibold, color: Colors.navy },
  sent: { fontSize: Typography.sizes.xs, color: Colors.slate },
  message: { fontSize: Typography.sizes.sm, color: Colors.navyMid, marginTop: Spacing.sm, fontStyle: 'italic' },
  reserved: { fontSize: Typography.sizes.xs, color: '#1d4ed8', marginTop: Spacing.sm, fontWeight: Typography.weights.semibold },
  cardError: { fontSize: Typography.sizes.sm, color: '#b91c1c', marginTop: Spacing.sm, fontWeight: Typography.weights.semibold },
  actions: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md },
  actionBtn: { flex: 1, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', borderRadius: Radii.md, paddingVertical: Spacing.sm + 2 },
  declineBtn: { borderWidth: 1.5, borderColor: Colors.rose + '66' },
  acceptBtn: { backgroundColor: Colors.sage },
  chatBtn: { backgroundColor: '#1d4ed8' },
  actionText: { fontSize: Typography.sizes.sm, fontWeight: Typography.weights.bold },
  spinner: { marginTop: 60 },
  empty: { alignItems: 'center', paddingTop: 60, paddingHorizontal: Spacing.xl },
  emptyEmoji: { fontSize: 44, marginBottom: Spacing.md },
  emptyTitle: { fontSize: Typography.sizes.lg, fontWeight: Typography.weights.bold, color: Colors.navy, textAlign: 'center' },
  emptyDesc: { fontSize: Typography.sizes.base, color: Colors.slate, marginTop: Spacing.xs, textAlign: 'center' },
  retry: { marginTop: Spacing.lg, backgroundColor: Colors.sage, paddingHorizontal: Spacing.xl, paddingVertical: Spacing.sm + 2, borderRadius: Radii.full },
  retryText: { color: Colors.white, fontWeight: Typography.weights.bold, fontSize: Typography.sizes.sm },
});
