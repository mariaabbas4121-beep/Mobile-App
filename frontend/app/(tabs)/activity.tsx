import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Image, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useBorrowRequests } from '../../context/BorrowRequestsContext';
import { useListings } from '../../context/ListingsContext';
import { useChat } from '../../context/ChatContext';
import { ACTIVITY_ICONS, activityDates, describeActivity, unavailableNote } from '../../lib/activity/describe';
import type { ActivityFeed, ActivityItem } from '../../lib/api/types';
import { errorMessage } from '../../lib/auth/messages';
import { bubbleTime } from '../../lib/chat/format';
import { Colors, Typography, Spacing, Radii, Shadows } from '../../utils/theme';

const GREEN = Colors.green || '#2e7d32';
const DARK = Colors.greenDark || '#1b5e20';

type Status = 'loading' | 'ready' | 'error';

function ActivityRow({ item, onPress }: { item: ActivityItem; onPress: () => void }) {
  const icon = ACTIVITY_ICONS[item.type];
  const text = describeActivity(item);
  const dates = activityDates(item);
  return (
    <TouchableOpacity style={styles.card} activeOpacity={0.88} onPress={onPress} accessibilityRole="button" accessibilityLabel={text}>
      {item.listing?.imageUrl ? (
        <Image source={{ uri: item.listing.imageUrl }} style={styles.cardImg} />
      ) : (
        <View style={[styles.cardImg, styles.cardIcon, { backgroundColor: icon.color + '15' }]}>
          <Ionicons name={icon.icon as never} size={22} color={icon.color} />
        </View>
      )}
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle} numberOfLines={2}>{text}</Text>
        {item.preview ? (
          <Text style={styles.cardPreview} numberOfLines={2}>“{item.preview}”</Text>
        ) : null}
        <View style={styles.cardMeta}>
          <Ionicons name={icon.icon as never} size={12} color={icon.color} />
          <Text style={styles.cardDate}>
            {bubbleTime(item.occurredAt)}
            {dates ? ` · for ${dates}` : ''}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

// What happened recently, built by the server from the signed-in user's own
// borrow requests, conversations and listings. Nothing here is made up: a
// new account shows the empty state.
export default function ActivityScreen() {
  const router = useRouter();
  const { activity, revision: requestRevision } = useBorrowRequests();
  const { revision: listingRevision } = useListings();
  // Pickup changes made on the other participant's device.
  const { handoverRevision } = useChat();
  const [feed, setFeed] = useState<ActivityFeed | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(0);

  const load = useCallback(
    async (mode: 'initial' | 'quiet' | 'refresh') => {
      const ticket = ++latest.current;
      if (mode === 'refresh') setRefreshing(true);
      try {
        const next = await activity();
        if (ticket !== latest.current) return;
        setFeed(next);
        setError(null);
        setStatus('ready');
      } catch (err) {
        if (ticket !== latest.current) return;
        setError(err);
        // Keep what is shown when only a background reload failed.
        setStatus((s) => (mode === 'initial' || s !== 'ready' ? 'error' : s));
      } finally {
        if (ticket === latest.current) setRefreshing(false);
      }
    },
    [activity],
  );

  const statusRef = useRef(status);
  statusRef.current = status;
  useEffect(() => {
    void load(statusRef.current === 'ready' ? 'quiet' : 'initial');
  }, [load, requestRevision, listingRevision, handoverRevision]);

  // Catch up with messages and decisions made elsewhere when coming back.
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

  const open = (item: ActivityItem) => {
    if (item.type === 'message' && item.conversationId) {
      router.push(`/chat/${item.conversationId}`);
    } else if (item.request) {
      router.push(`/requests/${item.request.id}`);
    } else if (item.listing && item.type !== 'listing_archived') {
      router.push(`/item/${item.listing.id}`);
    }
  };

  const note = feed ? unavailableNote(feed) : null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <SafeAreaView edges={['top']}>
          <Text style={styles.headerTitle}>Activity</Text>
          <Text style={styles.headerSub}>Your requests, messages and listings</Text>
          <View style={styles.requestLinks}>
            <TouchableOpacity
              style={styles.requestLink}
              onPress={() => router.push({ pathname: '/requests', params: { tab: 'borrowing' } })}
              accessibilityRole="button"
              accessibilityLabel="My borrow requests"
            >
              <Ionicons name="arrow-down-circle-outline" size={18} color={DARK} />
              <Text style={styles.requestLinkText}>My requests</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.requestLink}
              onPress={() => router.push({ pathname: '/requests', params: { tab: 'lending' } })}
              accessibilityRole="button"
              accessibilityLabel="Requests for my items"
            >
              <Ionicons name="arrow-up-circle-outline" size={18} color={DARK} />
              <Text style={styles.requestLinkText}>Requests for my items</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </View>

      {status === 'loading' ? (
        <View style={styles.centered} accessibilityLabel="Loading activity">
          <ActivityIndicator size="large" color={GREEN} />
        </View>
      ) : status === 'error' ? (
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>Could not load your activity</Text>
          <Text style={styles.emptyDesc}>{errorMessage(error)}</Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => void load('initial')} accessibilityRole="button" accessibilityLabel="Try again">
            <Text style={styles.primaryText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={feed?.items ?? []}
          keyExtractor={(i) => i.id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load('refresh')} tintColor={GREEN} />}
          ListHeaderComponent={note ? <Text style={styles.note}>{note}</Text> : undefined}
          ItemSeparatorComponent={() => <View style={{ height: Spacing.md }} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyEmoji}>📋</Text>
              <Text style={styles.emptyTitle}>No activity yet</Text>
              <Text style={styles.emptyDesc}>Requests you send or receive, messages and items you list will appear here.</Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={() => router.navigate('/')} accessibilityRole="button" accessibilityLabel="Browse items">
                <Text style={styles.primaryText}>Browse items</Text>
              </TouchableOpacity>
            </View>
          }
          renderItem={({ item }) => <ActivityRow item={item} onPress={() => open(item)} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  requestLinks: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md },
  requestLink: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: '#e8f5e9', borderRadius: Radii.lg, paddingVertical: Spacing.sm + 2,
    borderWidth: 1, borderColor: '#a5d6a7',
  },
  requestLinkText: { fontSize: Typography.sizes.sm, fontWeight: Typography.weights.bold, color: DARK },
  container: { flex: 1, backgroundColor: Colors.offWhite },
  header: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.xl,
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderColor: Colors.fog,
    ...Shadows.sm,
  },
  headerTitle: { fontSize: Typography.sizes.xl, fontWeight: Typography.weights.extrabold, color: DARK },
  headerSub: { fontSize: Typography.sizes.sm, color: Colors.slate, marginTop: 2 },
  list: { padding: Spacing.xl, paddingBottom: 100, flexGrow: 1 },
  note: {
    fontSize: Typography.sizes.sm, color: '#92400e', backgroundColor: '#fef3c7', borderRadius: Radii.md,
    padding: Spacing.md, marginBottom: Spacing.md,
  },
  card: {
    flexDirection: 'row', backgroundColor: Colors.white,
    borderRadius: Radii.lg, overflow: 'hidden', borderWidth: 1, borderColor: Colors.fog, ...Shadows.sm,
  },
  cardImg: { width: 72, minHeight: 72 },
  cardIcon: { alignItems: 'center', justifyContent: 'center' },
  cardBody: { flex: 1, padding: Spacing.md, gap: 3 },
  cardTitle: { fontSize: Typography.sizes.sm, fontWeight: Typography.weights.bold, color: DARK },
  cardPreview: { fontSize: Typography.sizes.sm, color: Colors.navyMid, fontStyle: 'italic' },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  cardDate: { fontSize: Typography.sizes.xs, color: Colors.slate },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl, paddingBottom: 100 },
  primaryBtn: { marginTop: Spacing.lg, backgroundColor: GREEN, borderRadius: Radii.full, paddingHorizontal: Spacing.xl, paddingVertical: Spacing.sm + 2 },
  primaryText: { color: Colors.white, fontWeight: Typography.weights.bold, fontSize: Typography.sizes.sm },
  empty: { alignItems: 'center', paddingTop: 60 },
  emptyEmoji: { fontSize: 48, marginBottom: Spacing.md },
  emptyTitle: { fontSize: Typography.sizes.lg, fontWeight: Typography.weights.bold, color: DARK, textAlign: 'center' },
  emptyDesc: { fontSize: Typography.sizes.base, color: Colors.slate, marginTop: Spacing.xs, textAlign: 'center' },
});
