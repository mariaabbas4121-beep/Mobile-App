import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Image, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useChat } from '../../context/ChatContext';
import type { Conversation } from '../../lib/api/types';
import { errorMessage } from '../../lib/auth/messages';
import { formatRange } from '../../lib/borrow/dates';
import { chatTime } from '../../lib/chat/format';
import { Colors, Radii, Shadows, Spacing, Typography } from '../../utils/theme';

const CONNECTION_TEXT = { connecting: 'Connecting…', offline: 'Offline' } as const;

function ConversationRow({ conversation, onPress }: { conversation: Conversation; onPress: () => void }) {
  const other = conversation.otherParticipant.displayName ?? (conversation.viewerRole === 'lender' ? 'Borrower' : 'Owner');
  const last = conversation.lastMessage;
  const mine = last && last.senderId !== conversation.otherParticipant.id;
  const unread = conversation.unreadCount;

  return (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Chat with ${other} about ${conversation.listing.title}${unread ? `, ${unread} unread` : ''}`}
    >
      {conversation.listing.imageUrl ? (
        <Image source={{ uri: conversation.listing.imageUrl }} style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, styles.thumbEmpty]}>
          <Text style={styles.initial}>{other.charAt(0).toUpperCase()}</Text>
        </View>
      )}
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.name} numberOfLines={1}>{other}</Text>
          <Text style={styles.time}>{chatTime(conversation.lastMessageAt ?? conversation.createdAt)}</Text>
        </View>
        <Text style={styles.item} numberOfLines={1}>
          {conversation.viewerRole === 'lender' ? 'Borrowing your ' : 'Lending you '}
          {conversation.listing.title} · {formatRange(conversation.request.startDate, conversation.request.endDate)}
        </Text>
        <View style={styles.rowTop}>
          <Text style={[styles.preview, unread > 0 && styles.previewUnread]} numberOfLines={1}>
            {last ? `${mine ? 'You: ' : ''}${last.body}` : 'No messages yet. Say hello and arrange the pickup.'}
          </Text>
          {unread > 0 ? (
            <View style={styles.unread}>
              <Text style={styles.unreadText}>{unread > 99 ? '99+' : unread}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </TouchableOpacity>
  );
}

// Conversations for accepted borrow requests, most recent first.
export default function ChatListScreen() {
  const router = useRouter();
  // Stable functions only: the context value changes on every revision.
  const { listConversations, revision, connection } = useChat();
  const [items, setItems] = useState<Conversation[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<unknown>(null);
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(0);

  const load = useCallback(
    async (mode: 'initial' | 'quiet' | 'refresh') => {
      const ticket = ++latest.current;
      if (mode === 'initial') setStatus('loading');
      if (mode === 'refresh') setRefreshing(true);
      try {
        const page = await listConversations();
        if (ticket !== latest.current) return;
        setItems(page.items);
        setLoadError(null);
        setRefreshError(null);
        setStatus('ready');
      } catch (err) {
        if (ticket !== latest.current) return;
        if (mode === 'initial') {
          setLoadError(err);
          setStatus('error');
        } else {
          setRefreshError(err);
        }
      } finally {
        if (ticket === latest.current) setRefreshing(false);
      }
    },
    [listConversations],
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  // New activity reported by the server, or a message sent from this device.
  const seen = useRef(revision);
  useEffect(() => {
    if (revision !== seen.current) {
      seen.current = revision;
      void load('quiet');
    }
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

  const renderEmpty = () => {
    if (status === 'loading') {
      return <ActivityIndicator style={styles.spinner} size="large" color={Colors.sage} accessibilityLabel="Loading conversations" />;
    }
    if (status === 'error') {
      return (
        <View style={styles.empty}>
          <Text style={styles.emptyEmoji}>📡</Text>
          <Text style={styles.emptyTitle}>Could not load your chats</Text>
          <Text style={styles.emptyDesc}>{errorMessage(loadError)}</Text>
          <TouchableOpacity style={styles.retry} onPress={() => void load('initial')} accessibilityRole="button" accessibilityLabel="Try again">
            <Text style={styles.retryText}>Try again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyEmoji}>💬</Text>
        <Text style={styles.emptyTitle}>No chats yet</Text>
        <Text style={styles.emptyDesc}>
          A chat opens when a borrow request is accepted, so you and your neighbor can arrange the pickup.
        </Text>
        <TouchableOpacity
          style={styles.retry}
          onPress={() => router.push({ pathname: '/requests', params: { tab: 'borrowing' } })}
          accessibilityRole="button"
          accessibilityLabel="View borrow requests"
        >
          <Text style={styles.retryText}>View borrow requests</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <SafeAreaView edges={['top']}>
          <View style={styles.headerRow}>
            <View>
              <Text style={styles.headerTitle}>Chat</Text>
              <Text style={styles.headerSub}>Arrange pickups for accepted requests</Text>
            </View>
            {connection !== 'connected' ? (
              <View style={styles.connection} accessibilityLabel={`Live updates: ${CONNECTION_TEXT[connection]}`}>
                <View style={[styles.dot, connection === 'offline' && styles.dotOffline]} />
                <Text style={styles.connectionText}>{CONNECTION_TEXT[connection]}</Text>
              </View>
            ) : null}
          </View>
        </SafeAreaView>
      </View>

      {refreshError && status === 'ready' ? (
        <View style={styles.notice} accessibilityRole="alert">
          <Text style={styles.noticeText}>Could not refresh. {errorMessage(refreshError)}</Text>
        </View>
      ) : null}

      <FlatList
        testID="conversation-list"
        data={status === 'ready' ? items : []}
        keyExtractor={(c) => c.id}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load('refresh')} tintColor={Colors.sage} />}
        ListEmptyComponent={renderEmpty()}
        renderItem={({ item }) => <ConversationRow conversation={item} onPress={() => router.push(`/chat/${item.id}`)} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.offWhite },
  header: { backgroundColor: Colors.white, paddingHorizontal: Spacing.xl, paddingBottom: Spacing.md, borderBottomWidth: 1, borderColor: Colors.fog, ...Shadows.sm },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: Spacing.sm },
  headerTitle: { fontSize: Typography.sizes.xl, fontWeight: Typography.weights.extrabold, color: Colors.navy },
  headerSub: { fontSize: Typography.sizes.sm, color: Colors.slate, marginTop: 2 },
  connection: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: Colors.amberPale, borderRadius: Radii.full, paddingHorizontal: 10, paddingVertical: 4 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.amber },
  dotOffline: { backgroundColor: Colors.slateLight },
  connectionText: { fontSize: Typography.sizes.xs, fontWeight: Typography.weights.semibold, color: Colors.amberDark },
  notice: { backgroundColor: Colors.rosePale, paddingHorizontal: Spacing.xl, paddingVertical: Spacing.sm },
  noticeText: { fontSize: Typography.sizes.sm, color: '#9f1239' },
  list: { paddingBottom: 120, flexGrow: 1 },
  separator: { height: 1, backgroundColor: Colors.fog, marginLeft: Spacing.xl + 52 + Spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md, backgroundColor: Colors.white },
  thumb: { width: 52, height: 52, borderRadius: 26 },
  thumbEmpty: { backgroundColor: Colors.sagePale, alignItems: 'center', justifyContent: 'center' },
  initial: { fontSize: Typography.sizes.lg, fontWeight: Typography.weights.bold, color: Colors.sageDark },
  rowBody: { flex: 1, minWidth: 0 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.sm },
  name: { flex: 1, fontSize: Typography.sizes.base, fontWeight: Typography.weights.bold, color: Colors.navy },
  time: { fontSize: Typography.sizes.xs, color: Colors.slate },
  item: { fontSize: Typography.sizes.xs, color: Colors.slate, marginTop: 1 },
  preview: { flex: 1, fontSize: Typography.sizes.sm, color: Colors.slate, marginTop: 3 },
  previewUnread: { color: Colors.navy, fontWeight: Typography.weights.semibold },
  unread: { minWidth: 20, height: 20, borderRadius: 10, backgroundColor: Colors.sage, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  unreadText: { color: Colors.white, fontSize: 11, fontWeight: Typography.weights.bold },
  spinner: { marginTop: 60 },
  empty: { alignItems: 'center', paddingTop: 60, paddingHorizontal: Spacing.xl },
  emptyEmoji: { fontSize: 44, marginBottom: Spacing.md },
  emptyTitle: { fontSize: Typography.sizes.lg, fontWeight: Typography.weights.bold, color: Colors.navy, textAlign: 'center' },
  emptyDesc: { fontSize: Typography.sizes.base, color: Colors.slate, marginTop: Spacing.xs, textAlign: 'center' },
  retry: { marginTop: Spacing.lg, backgroundColor: Colors.sage, paddingHorizontal: Spacing.xl, paddingVertical: Spacing.sm + 2, borderRadius: Radii.full },
  retryText: { color: Colors.white, fontWeight: Typography.weights.bold, fontSize: Typography.sizes.sm },
});
