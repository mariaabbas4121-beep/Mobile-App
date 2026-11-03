import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useChat } from '../../context/ChatContext';
import { isApiError } from '../../lib/api/client';
import type { ChatMessage, Conversation } from '../../lib/api/types';
import { errorMessage } from '../../lib/auth/messages';
import { formatRange } from '../../lib/borrow/dates';
import { MAX_MESSAGE_LENGTH, bubbleTime } from '../../lib/chat/format';
import { Colors, Radii, Shadows, Spacing, Typography } from '../../utils/theme';

// A message as shown: stored ('sent'), or this device's own copy while it is
// being sent or after sending failed.
type Bubble = ChatMessage & { state: 'sent' | 'sending' | 'failed'; error?: string };

const LOCAL_SENDER = 'me';
const COUNTER_FROM = MAX_MESSAGE_LENGTH - 200;

const sent = (m: ChatMessage): Bubble => ({ ...m, state: 'sent' });

// Newest first (the list is inverted). Unsent bubbles stay at the bottom of
// the screen, below everything stored.
function ordered(list: Bubble[]): Bubble[] {
  return [...list].sort((a, b) => {
    const pa = a.state === 'sent' ? 1 : 0;
    const pb = b.state === 'sent' ? 1 : 0;
    if (pa !== pb) return pa - pb;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt) || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0);
  });
}

// Adds stored messages, replacing this device's unsent copy of the same
// message (same clientId) and ignoring ones already shown.
function mergeStored(prev: Bubble[], incoming: ChatMessage[]): Bubble[] {
  let next = prev;
  for (const m of incoming) {
    if (next.some((b) => b.id === m.id)) continue;
    const local = next.findIndex((b) => b.state !== 'sent' && b.clientId === m.clientId);
    next = local >= 0 ? next.map((b, i) => (i === local ? sent(m) : b)) : [...next, sent(m)];
  }
  return next === prev ? prev : ordered(next);
}

function MessageBubble({ message, mine, onRetry }: { message: Bubble; mine: boolean; onRetry: () => void }) {
  const failed = message.state === 'failed';
  return (
    <View style={[styles.bubbleRow, mine ? styles.rowMine : styles.rowTheirs]}>
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs, failed && styles.bubbleFailed]}>
        <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]} selectable>{message.body}</Text>
        <Text style={[styles.bubbleMeta, mine && styles.bubbleMetaMine]}>
          {message.state === 'sending' ? 'Sending…' : failed ? 'Not sent' : bubbleTime(message.createdAt)}
        </Text>
      </View>
      {failed ? (
        <TouchableOpacity onPress={onRetry} style={styles.failedRow} accessibilityRole="button" accessibilityLabel="Retry sending message">
          <Ionicons name="alert-circle" size={14} color={Colors.rose} />
          <Text style={styles.failedText}>{message.error ?? 'Not sent.'} Tap to retry.</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

export default function ConversationScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  // Stable functions only: the context value changes on every revision.
  const { getConversation, loadMessages, send, markRead, subscribe, newClientId, connection } = useChat();

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Bubble[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<unknown>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(null);
  const [draft, setDraft] = useState('');
  const otherId = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setStatus('loading');
    try {
      const [c, page] = await Promise.all([getConversation(id), loadMessages(id)]);
      otherId.current = c.otherParticipant.id;
      setConversation(c);
      setMessages((prev) => mergeStored(prev.filter((b) => b.state !== 'sent'), page.items));
      setCursor(page.nextCursor);
      setStatus('ready');
      void markRead(id).catch(() => undefined);
    } catch (err) {
      setLoadError(err);
      setStatus('error');
    }
  }, [id, getConversation, loadMessages, markRead]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live messages while this screen is open.
  useEffect(() => {
    if (!id) return;
    return subscribe(id, (message) => {
      setMessages((prev) => mergeStored(prev, [message]));
      if (message.senderId === otherId.current) void markRead(id).catch(() => undefined);
    });
  }, [id, subscribe, markRead]);

  // After a reconnect, fetch the newest page to fill anything missed.
  const wasConnected = useRef(connection === 'connected');
  useEffect(() => {
    const now = connection === 'connected';
    if (now && !wasConnected.current && status === 'ready' && id) {
      loadMessages(id).then((page) => setMessages((prev) => mergeStored(prev, page.items)), () => undefined);
    }
    wasConnected.current = now;
  }, [connection, status, id, loadMessages]);

  const loadOlder = useCallback(async () => {
    if (!id || !cursor || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await loadMessages(id, cursor);
      setMessages((prev) => mergeStored(prev, page.items));
      setCursor(page.nextCursor);
    } catch (err) {
      setOlderError(err);
    } finally {
      setLoadingOlder(false);
    }
  }, [id, cursor, loadingOlder, loadMessages]);

  const deliver = useCallback(
    async (body: string, clientId: string) => {
      if (!id) return;
      const local: Bubble = {
        id: `local-${clientId}`,
        conversationId: id,
        senderId: LOCAL_SENDER,
        body,
        clientId,
        createdAt: new Date().toISOString(),
        state: 'sending',
      };
      setMessages((prev) => ordered([...prev.filter((b) => !(b.state !== 'sent' && b.clientId === clientId)), local]));
      try {
        const message = await send(id, clientId, body);
        setMessages((prev) => mergeStored(prev, [message]));
      } catch (err) {
        const error = isApiError(err) && err.code === 'NETWORK_ERROR' ? 'You are offline.' : errorMessage(err);
        setMessages((prev) => prev.map((b) => (b.state !== 'sent' && b.clientId === clientId ? { ...b, state: 'failed', error } : b)));
      }
    },
    [id, send],
  );

  const body = draft.trim();
  const tooLong = [...body].length > MAX_MESSAGE_LENGTH;
  const canSend = status === 'ready' && body.length > 0 && !tooLong;
  const onSend = () => {
    if (!canSend) return;
    setDraft('');
    void deliver(body, newClientId());
  };

  const isMine = (m: Bubble) => m.senderId === LOCAL_SENDER || (otherId.current !== null && m.senderId !== otherId.current);
  const otherName = conversation?.otherParticipant.displayName ?? (conversation?.viewerRole === 'lender' ? 'Borrower' : 'Owner');

  const header = (
    <View style={styles.header}>
      <SafeAreaView edges={['top']}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Go back">
            <Ionicons name="arrow-back" size={20} color={Colors.navy} />
          </TouchableOpacity>
          <View style={styles.headerText}>
            <Text style={styles.headerTitle} numberOfLines={1}>{conversation ? otherName : 'Chat'}</Text>
            {conversation ? (
              <Text style={styles.headerSub} numberOfLines={1}>
                {conversation.listing.title} · {formatRange(conversation.request.startDate, conversation.request.endDate)}
              </Text>
            ) : null}
          </View>
        </View>
      </SafeAreaView>
    </View>
  );

  if (status === 'loading' && !conversation) {
    return (
      <View style={styles.container}>
        {header}
        <ActivityIndicator style={styles.spinner} size="large" color={Colors.sage} accessibilityLabel="Loading conversation" />
      </View>
    );
  }

  if (status === 'error') {
    const missing = isApiError(loadError) && loadError.code === 'CONVERSATION_NOT_FOUND';
    return (
      <View style={styles.container}>
        {header}
        <View style={styles.empty}>
          <Text style={styles.emptyEmoji}>{missing ? '🔒' : '📡'}</Text>
          <Text style={styles.emptyTitle}>{missing ? 'Chat not available' : 'Could not load this chat'}</Text>
          <Text style={styles.emptyDesc}>{errorMessage(loadError)}</Text>
          {missing ? null : (
            <TouchableOpacity style={styles.retry} onPress={() => void load()} accessibilityRole="button" accessibilityLabel="Try again">
              <Text style={styles.retryText}>Try again</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {header}

      {connection !== 'connected' ? (
        <View style={styles.banner} accessibilityRole="alert">
          <Text style={styles.bannerText}>
            {connection === 'connecting'
              ? 'Reconnecting to live chat… You can still send; new replies may be delayed.'
              : 'Live chat is unavailable. You can still send; reopen this chat to see new replies.'}
          </Text>
        </View>
      ) : null}
      {conversation?.listing.archived ? (
        <View style={[styles.banner, styles.bannerInfo]}>
          <Text style={styles.bannerInfoText}>This item is no longer listed. The accepted borrow still stands, so you can keep chatting.</Text>
        </View>
      ) : null}

      <FlatList
        testID="message-list"
        inverted
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.messages}
        onEndReached={() => void loadOlder()}
        onEndReachedThreshold={0.3}
        keyboardShouldPersistTaps="handled"
        // Inverted: the footer is shown at the top, above the oldest message.
        ListFooterComponent={
          cursor ? (
            <View style={styles.older}>
              {loadingOlder ? (
                <ActivityIndicator size="small" color={Colors.sage} accessibilityLabel="Loading earlier messages" />
              ) : (
                <TouchableOpacity onPress={() => void loadOlder()} accessibilityRole="button" accessibilityLabel="Load earlier messages">
                  <Text style={styles.olderText}>
                    {olderError ? `Could not load earlier messages. ${errorMessage(olderError)} Tap to retry.` : 'Load earlier messages'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          ) : undefined
        }
        ListEmptyComponent={
          <View style={styles.emptyChat}>
            <Text style={styles.emptyChatText}>
              No messages yet. Say hello and agree on a time and place for the pickup.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <MessageBubble message={item} mine={isMine(item)} onRetry={() => void deliver(item.body, item.clientId)} />
        )}
      />

      <SafeAreaView edges={['bottom']} style={styles.composer}>
        {[...body].length > COUNTER_FROM ? (
          <Text style={[styles.counter, tooLong && styles.counterOver]}>
            {[...body].length} / {MAX_MESSAGE_LENGTH}
          </Text>
        ) : null}
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="Write a message"
            placeholderTextColor={Colors.slateLight}
            multiline
            accessibilityLabel="Message"
          />
          <TouchableOpacity
            style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
            onPress={onSend}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityState={{ disabled: !canSend }}
          >
            <Ionicons name="send" size={18} color={Colors.white} />
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.offWhite },
  header: { backgroundColor: Colors.white, paddingHorizontal: Spacing.base, paddingBottom: Spacing.sm, borderBottomWidth: 1, borderColor: Colors.fog, ...Shadows.sm },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginTop: Spacing.sm },
  backBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.fog, alignItems: 'center', justifyContent: 'center' },
  headerText: { flex: 1, minWidth: 0 },
  headerTitle: { fontSize: Typography.sizes.md, fontWeight: Typography.weights.bold, color: Colors.navy },
  headerSub: { fontSize: Typography.sizes.xs, color: Colors.slate, marginTop: 1 },
  banner: { backgroundColor: Colors.amberPale, paddingHorizontal: Spacing.base, paddingVertical: Spacing.sm },
  bannerText: { fontSize: Typography.sizes.xs, color: Colors.amberDark, fontWeight: Typography.weights.semibold },
  bannerInfo: { backgroundColor: Colors.skyPale },
  bannerInfoText: { fontSize: Typography.sizes.xs, color: '#0369a1' },
  messages: { paddingHorizontal: Spacing.base, paddingVertical: Spacing.md, flexGrow: 1 },
  bubbleRow: { marginVertical: 3, maxWidth: '82%' },
  rowMine: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  rowTheirs: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  bubble: { borderRadius: Radii.lg, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm },
  bubbleMine: { backgroundColor: Colors.sageDark, borderBottomRightRadius: 4 },
  bubbleTheirs: { backgroundColor: Colors.white, borderBottomLeftRadius: 4, borderWidth: 1, borderColor: Colors.fog },
  bubbleFailed: { opacity: 0.6 },
  bubbleText: { fontSize: Typography.sizes.base, color: Colors.navy, lineHeight: 20 },
  bubbleTextMine: { color: Colors.white },
  bubbleMeta: { fontSize: 10, color: Colors.slate, marginTop: 2, alignSelf: 'flex-end' },
  bubbleMetaMine: { color: 'rgba(255,255,255,0.8)' },
  failedRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  failedText: { fontSize: Typography.sizes.xs, color: Colors.rose, fontWeight: Typography.weights.semibold, flexShrink: 1 },
  older: { alignItems: 'center', paddingVertical: Spacing.md },
  olderText: { fontSize: Typography.sizes.sm, color: Colors.sageDark, fontWeight: Typography.weights.semibold, textAlign: 'center' },
  emptyChat: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl, transform: [{ scaleY: -1 }] },
  emptyChatText: { fontSize: Typography.sizes.sm, color: Colors.slate, textAlign: 'center' },
  composer: { backgroundColor: Colors.white, borderTopWidth: 1, borderColor: Colors.fog, paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },
  counter: { fontSize: Typography.sizes.xs, color: Colors.slate, textAlign: 'right', marginBottom: 2 },
  counterOver: { color: Colors.rose, fontWeight: Typography.weights.bold },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.sm, paddingBottom: Spacing.sm },
  input: {
    flex: 1, maxHeight: 120, minHeight: 42, backgroundColor: Colors.offWhite, borderRadius: Radii.lg, borderWidth: 1, borderColor: Colors.fog,
    paddingHorizontal: Spacing.md, paddingTop: 10, paddingBottom: 10, fontSize: Typography.sizes.base, color: Colors.navy,
  },
  sendBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: Colors.sage, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { backgroundColor: Colors.slateLight },
  spinner: { marginTop: 60 },
  empty: { alignItems: 'center', paddingTop: 60, paddingHorizontal: Spacing.xl },
  emptyEmoji: { fontSize: 44, marginBottom: Spacing.md },
  emptyTitle: { fontSize: Typography.sizes.lg, fontWeight: Typography.weights.bold, color: Colors.navy, textAlign: 'center' },
  emptyDesc: { fontSize: Typography.sizes.base, color: Colors.slate, marginTop: Spacing.xs, textAlign: 'center' },
  retry: { marginTop: Spacing.lg, backgroundColor: Colors.sage, paddingHorizontal: Spacing.xl, paddingVertical: Spacing.sm + 2, borderRadius: Radii.full },
  retryText: { color: Colors.white, fontWeight: Typography.weights.bold, fontSize: Typography.sizes.sm },
});
