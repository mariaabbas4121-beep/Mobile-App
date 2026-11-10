import { useState } from 'react';
import { ActivityIndicator, Alert, Image, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import { useBorrowRequests } from '../../context/BorrowRequestsContext';
import { useChat } from '../../context/ChatContext';
import type { BorrowRequest, DueDateExtension, PickupAuthorization, ReturnState } from '../../lib/api/types';
import { errorMessage } from '../../lib/auth/messages';
import { addDays, formatRange, inclusiveDays, MAX_BORROW_DAYS } from '../../lib/borrow/dates';
import { AUTH_STATUS, when } from '../../lib/handover/format';
import { Colors, Radii, Shadows, Spacing, Typography } from '../../utils/theme';

const GREEN = Colors.green || '#2e7d32';
const DARK = Colors.greenDark || '#1b5e20';

const day = (date: string) => formatRange(date, date);

const EXTENSION_STATUS: Record<DueDateExtension['status'], { label: string; color: string; bg: string }> = {
  pending: { label: 'Extension pending', color: '#92400e', bg: '#fef3c7' },
  approved: { label: 'Extension approved', color: DARK, bg: '#e8f5e9' },
  rejected: { label: 'Extension declined', color: Colors.slate, bg: Colors.fog },
};

function Chip({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <View style={[styles.chip, { backgroundColor: bg }]}>
      <Text style={[styles.chipText, { color }]}>{label}</Text>
    </View>
  );
}

// Due date, overdue state and extension requests. The server decides
// overdue (Pakistan time, approved due date), so nothing here uses the
// phone's clock to judge it.
export function DueDateCard({ request, state, onChanged }: { request: BorrowRequest; state: ReturnState; onChanged: () => void }) {
  const { requestExtension, decideExtension } = useBorrowRequests();
  const { handoverChanged } = useChat();
  const lending = request.viewerRole === 'lender';
  const other = lending ? (request.borrower.displayName ?? 'The borrower') : (request.lender.displayName ?? 'The owner');
  const pending = state.pendingExtension;
  const latestDecided = state.extensions.find((e) => e.status !== 'pending') ?? null;
  const returned = state.status === 'returned';

  // Earliest and latest dates the server would accept.
  const minDate = addDays(state.dueDate > state.today ? state.dueDate : state.today, state.dueDate >= state.today ? 1 : 0);
  const maxDate = addDays(state.startDate, MAX_BORROW_DAYS - 1);
  const canExtend = !lending && !returned && !pending && minDate <= maxDate && state.requestStatus === 'accepted';
  const [asking, setAsking] = useState(false);
  const [date, setDate] = useState(minDate);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await requestExtension(request.id, { requestedEndDate: date, reason: reason.trim() || null });
      handoverChanged();
      setAsking(false);
      setReason('');
      Toast.show({ type: 'success', text1: 'Extension requested', text2: `${other} will be asked to approve ${day(date)}.` });
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const decide = (ext: DueDateExtension, decision: 'approve' | 'reject') => {
    const run = async () => {
      setBusy(true);
      setError(null);
      try {
        await decideExtension(request.id, ext.id, decision);
        handoverChanged();
        Toast.show({ type: 'success', text1: decision === 'approve' ? `Due date moved to ${day(ext.requestedEndDate)}` : 'Extension declined' });
        onChanged();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    };
    if (decision === 'approve') return void run();
    Alert.alert('Decline the extension?', `The due date stays ${day(state.dueDate)}.`, [
      { text: 'Keep it pending', style: 'cancel' },
      { text: 'Decline', style: 'destructive', onPress: () => void run() },
    ]);
  };

  return (
    <View style={styles.card} accessibilityLabel="Due date">
      <View style={styles.rowBetween}>
        <Text style={styles.sectionTitle}>Due date</Text>
        {state.overdue ? (
          <Chip label={`Overdue · ${state.daysOverdue} ${state.daysOverdue === 1 ? 'day' : 'days'}`} color="#b91c1c" bg="#fee2e2" />
        ) : returned ? (
          <Chip label="Returned" color={DARK} bg="#e8f5e9" />
        ) : null}
      </View>
      <Text style={styles.body1}>Return by {day(state.dueDate)}</Text>
      {state.originalDueDate !== state.dueDate ? (
        <Text style={styles.meta}>Extended from {day(state.originalDueDate)}</Text>
      ) : null}
      {state.overdue ? (
        <Text style={styles.warn} accessibilityRole="alert">
          {lending
            ? `The item was due ${day(state.dueDate)} and has not been returned. Contact ${other} in chat.`
            : `This item was due ${day(state.dueDate)}. Return it as soon as you can, or ask ${other} for more time.`}
        </Text>
      ) : null}

      {pending ? (
        <View style={styles.inner} accessibilityLabel="Extension pending">
          <View style={styles.rowBetween}>
            <Text style={styles.body1}>{lending ? `${other} asked for more time` : 'You asked for more time'}</Text>
            <Chip {...EXTENSION_STATUS.pending} />
          </View>
          <Text style={styles.meta}>
            Until {day(pending.requestedEndDate)} (now {day(pending.previousEndDate)})
          </Text>
          {pending.reason ? <Text style={styles.meta}>“{pending.reason}”</Text> : null}
          {pending.requestedWhileOverdue ? <Text style={styles.small}>Asked after the due date had passed.</Text> : null}
          {lending ? (
            <View style={styles.row}>
              <TouchableOpacity
                style={[styles.smallPrimary, busy && styles.disabled]}
                disabled={busy}
                onPress={() => decide(pending, 'approve')}
                accessibilityRole="button"
                accessibilityLabel={`Approve extension until ${day(pending.requestedEndDate)}`}
              >
                <Text style={styles.primaryText}>Approve</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.smallDanger, busy && styles.disabled]}
                disabled={busy}
                onPress={() => decide(pending, 'reject')}
                accessibilityRole="button"
                accessibilityLabel="Decline extension"
              >
                <Text style={styles.dangerText}>Decline</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <Text style={styles.small}>The due date only changes if {other} approves.</Text>
          )}
        </View>
      ) : latestDecided ? (
        <View style={styles.rowBetween} accessibilityLabel={EXTENSION_STATUS[latestDecided.status].label}>
          <Text style={styles.meta}>
            {latestDecided.status === 'approved' ? 'Approved' : 'Declined'}: until {day(latestDecided.requestedEndDate)}
          </Text>
          <Chip {...EXTENSION_STATUS[latestDecided.status]} />
        </View>
      ) : null}

      {canExtend && !asking ? (
        <TouchableOpacity
          style={styles.secondaryBtn}
          onPress={() => {
            setDate(minDate);
            setAsking(true);
          }}
          accessibilityRole="button"
          accessibilityLabel="Ask for more time"
        >
          <Ionicons name="calendar-outline" size={16} color={DARK} />
          <Text style={styles.secondaryText}>Ask for more time</Text>
        </TouchableOpacity>
      ) : null}
      {asking ? (
        <View style={styles.inner}>
          <Text style={styles.label}>New due date</Text>
          <View style={styles.stepper}>
            <TouchableOpacity
              onPress={() => setDate((d) => (d > minDate ? addDays(d, -1) : d))}
              disabled={date <= minDate}
              style={[styles.stepBtn, date <= minDate && styles.disabled]}
              accessibilityRole="button"
              accessibilityLabel="One day earlier"
            >
              <Ionicons name="remove" size={18} color={DARK} />
            </TouchableOpacity>
            <Text style={styles.stepValue} accessibilityLabel={`New due date ${day(date)}`}>
              {day(date)}
            </Text>
            <TouchableOpacity
              onPress={() => setDate((d) => (d < maxDate ? addDays(d, 1) : d))}
              disabled={date >= maxDate}
              style={[styles.stepBtn, date >= maxDate && styles.disabled]}
              accessibilityRole="button"
              accessibilityLabel="One day later"
            >
              <Ionicons name="add" size={18} color={DARK} />
            </TouchableOpacity>
          </View>
          <Text style={styles.small}>
            {inclusiveDays(state.dueDate, date) - 1} more {inclusiveDays(state.dueDate, date) - 1 === 1 ? 'day' : 'days'}. At most{' '}
            {MAX_BORROW_DAYS} days in total ({day(maxDate)}).
          </Text>
          <TextInput
            style={styles.input}
            value={reason}
            onChangeText={setReason}
            placeholder="Reason (optional)"
            maxLength={300}
            accessibilityLabel="Reason for more time"
          />
          <View style={styles.row}>
            <TouchableOpacity
              style={[styles.smallPrimary, busy && styles.disabled]}
              disabled={busy}
              onPress={() => void submit()}
              accessibilityRole="button"
              accessibilityLabel="Send extension request"
            >
              {busy ? <ActivityIndicator size="small" color={Colors.white} /> : null}
              <Text style={styles.primaryText}>Send request</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.smallSecondary} onPress={() => setAsking(false)} accessibilityRole="button" accessibilityLabel="Cancel">
              <Text style={styles.secondaryText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function AuthorizationLine({ a }: { a: PickupAuthorization }) {
  const s = AUTH_STATUS[a.status];
  return (
    <View style={styles.inner} accessibilityLabel={`Return authorization for ${a.recipientName}, ${s.label}`}>
      <View style={styles.rowBetween}>
        <Text style={styles.body1}>{a.recipientName}</Text>
        <Chip label={s.label} color={s.color} bg={s.bg} />
      </View>
      {a.recipientPhone ? <Text style={styles.meta}>Phone: {a.recipientPhone}</Text> : null}
      {a.note ? <Text style={styles.meta}>Note: {a.note}</Text> : null}
      <Text style={styles.small}>
        {a.status === 'active'
          ? `Valid until ${when(a.expiresAt)}`
          : a.status === 'redeemed' && a.redeemedAt
            ? `Used ${when(a.redeemedAt)}`
            : a.status === 'revoked' && a.revokedAt
              ? `Revoked ${when(a.revokedAt)}`
              : `Expired ${when(a.expiresAt)}`}
      </Text>
    </View>
  );
}

const METHOD_TEXT = { personal: 'in person', delivery: 'by delivery', authorized: 'through someone else' } as const;

// The return: started by the borrower, confirmed only by the lender.
export function ReturnCard({ request, state, onChanged }: { request: BorrowRequest; state: ReturnState; onChanged: () => void }) {
  const router = useRouter();
  const { initiateReturn, revokeReturn } = useBorrowRequests();
  const { handoverChanged } = useChat();
  const lending = request.viewerRole === 'lender';
  const other = lending ? (request.borrower.displayName ?? 'The borrower') : (request.lender.displayName ?? 'The owner');
  const ret = state.return;
  const active = state.activeAuthorization;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [delivery, setDelivery] = useState(false);
  const [provider, setProvider] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');

  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      handoverChanged();
      Toast.show({ type: 'success', text1: done });
      setChoosing(false);
      setDelivery(false);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const returnInPerson = () =>
    Alert.alert('Return it in person?', `Bring it to ${other}. They confirm in the app when they have it.`, [
      { text: 'Not yet', style: 'cancel' },
      { text: 'Yes', onPress: () => void run(() => initiateReturn(request.id, { method: 'personal' }), 'Return started') },
    ]);
  const sendByDelivery = () =>
    void run(
      () =>
        initiateReturn(request.id, {
          method: 'delivery',
          deliveryProvider: provider.trim() || null,
          deliveryReference: reference.trim() || null,
          deliveryNote: note.trim() || null,
        }),
      'Delivery details saved',
    );
  const revoke = (a: PickupAuthorization) =>
    Alert.alert(`Revoke ${a.recipientName}’s return?`, 'Their QR stops working at once.', [
      { text: 'Keep it', style: 'cancel' },
      { text: 'Revoke', style: 'destructive', onPress: () => void run(() => revokeReturn(request.id, a.id), 'Authorization revoked') },
    ]);
  const confirm = (mode: 'scan' | 'personal' | 'delivery') =>
    router.push({ pathname: '/handover/confirm', params: { requestId: request.id, mode, kind: 'return' } });

  if (state.status === 'not_picked_up') return null;

  if (state.status === 'returned' && ret?.confirmedAt) {
    return (
      <View style={styles.card} accessibilityLabel="Return completed">
        <View style={styles.rowBetween}>
          <Text style={styles.sectionTitle}>Return</Text>
          <Chip label="Returned" color={DARK} bg="#e8f5e9" />
        </View>
        <Text style={styles.body1}>Returned {when(ret.confirmedAt)}</Text>
        <Text style={styles.meta}>
          {ret.method === 'authorized'
            ? `Brought back by ${ret.recipientName}${ret.recipientPhone ? ` (${ret.recipientPhone})` : ''}, on behalf of ${lending ? other : 'you'}`
            : ret.method === 'delivery'
              ? `Received by delivery${ret.delivery?.provider ? ` (${ret.delivery.provider}${ret.delivery.reference ? `, ref ${ret.delivery.reference}` : ''})` : ''}`
              : `Returned in person by ${lending ? other : 'you'}`}
        </Text>
        <Text style={styles.meta}>Receipt confirmed by {lending ? 'you' : (ret.confirmedBy?.displayName ?? 'the owner')}</Text>
        <Text style={styles.label}>Condition when returned</Text>
        <Text style={styles.meta}>{ret.conditionNotes ?? 'No notes.'}</Text>
        {ret.photos.length > 0 ? (
          <View style={styles.photos}>
            {ret.photos.map((p) =>
              p.url ? (
                <Image key={p.id} source={{ uri: p.url }} style={styles.photo} accessibilityLabel="Return condition photo" />
              ) : (
                <View key={p.id} style={[styles.photo, styles.photoMissing]} />
              ),
            )}
          </View>
        ) : (
          <Text style={styles.meta}>No condition photos.</Text>
        )}
      </View>
    );
  }

  const options = (
    <>
      <TouchableOpacity style={styles.option} onPress={returnInPerson} disabled={busy} accessibilityRole="button" accessibilityLabel="Return it myself">
        <Ionicons name="person-outline" size={20} color={DARK} />
        <View style={{ flex: 1 }}>
          <Text style={styles.optionTitle}>Return it myself</Text>
          <Text style={styles.small}>Bring it to {other}; they confirm when they have it.</Text>
        </View>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.option}
        onPress={() => setDelivery((v) => !v)}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Send it by delivery"
        accessibilityState={{ expanded: delivery }}
      >
        <Ionicons name="bicycle-outline" size={20} color={DARK} />
        <View style={{ flex: 1 }}>
          <Text style={styles.optionTitle}>Send it by delivery or courier</Text>
          <Text style={styles.small}>Optional details for {other}. No live tracking.</Text>
        </View>
      </TouchableOpacity>
      {delivery ? (
        <View style={styles.inner}>
          <TextInput style={styles.input} value={provider} onChangeText={setProvider} placeholder="Provider (e.g. TCS)" maxLength={80} accessibilityLabel="Delivery provider" />
          <TextInput
            style={styles.input}
            value={reference}
            onChangeText={setReference}
            placeholder="Tracking or reference number"
            maxLength={80}
            accessibilityLabel="Tracking or reference number"
          />
          <TextInput style={styles.input} value={note} onChangeText={setNote} placeholder="Note (optional)" maxLength={300} accessibilityLabel="Delivery note" />
          <TouchableOpacity
            style={[styles.smallPrimary, busy && styles.disabled]}
            disabled={busy}
            onPress={sendByDelivery}
            accessibilityRole="button"
            accessibilityLabel="Save delivery details"
          >
            <Text style={styles.primaryText}>Save delivery details</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      <TouchableOpacity
        style={styles.option}
        onPress={() => router.push({ pathname: '/handover/authorize', params: { requestId: request.id, kind: 'return' } })}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Authorize someone else to return it"
      >
        <Ionicons name="people-outline" size={20} color={DARK} />
        <View style={{ flex: 1 }}>
          <Text style={styles.optionTitle}>Authorize someone else to return it</Text>
          <Text style={styles.small}>They show a one-time QR to {other}. They do not need the app.</Text>
        </View>
      </TouchableOpacity>
    </>
  );

  const past = state.authorizations.filter((a) => a.id !== active?.id);

  return (
    <View style={styles.card} accessibilityLabel={state.status === 'ready' ? 'Ready to return' : 'Awaiting confirmation'}>
      <View style={styles.rowBetween}>
        <Text style={styles.sectionTitle}>Return</Text>
        {state.status === 'ready' ? (
          <Chip label="Ready to return" color="#1d4ed8" bg="#dbeafe" />
        ) : (
          <Chip label="Awaiting owner’s confirmation" color="#92400e" bg="#fef3c7" />
        )}
      </View>

      {ret ? (
        <>
          <Text style={styles.body1}>
            {lending ? `${other} is returning it ${METHOD_TEXT[ret.method]}` : `You are returning it ${METHOD_TEXT[ret.method]}`}
          </Text>
          {ret.delivery ? (
            <Text style={styles.meta}>
              {[ret.delivery.provider, ret.delivery.reference ? `ref ${ret.delivery.reference}` : null, ret.delivery.note].filter(Boolean).join(' · ')}
            </Text>
          ) : null}
          <Text style={styles.small}>Started {when(ret.initiatedAt)}. It counts as returned only when {lending ? 'you confirm' : `${other} confirms`} receipt.</Text>
        </>
      ) : (
        <Text style={styles.meta}>
          {lending ? `${other} has not started the return yet.` : `When you are ready to give ${request.listing.title} back, choose how.`}
        </Text>
      )}

      {active ? <AuthorizationLine a={active} /> : null}

      {lending ? (
        ret ? (
          <>
            {active || ret.method === 'authorized' ? (
              <TouchableOpacity style={styles.primaryBtn} onPress={() => confirm('scan')} accessibilityRole="button" accessibilityLabel="Scan return QR">
                <Ionicons name="qr-code-outline" size={16} color={Colors.white} />
                <Text style={styles.primaryText}>Scan Return QR</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={() => confirm('personal')}
              accessibilityRole="button"
              accessibilityLabel={`Confirm ${other} returned it in person`}
            >
              <Ionicons name="checkmark-circle-outline" size={16} color={DARK} />
              <Text style={styles.secondaryText}>Confirm receipt ({other} in person)</Text>
            </TouchableOpacity>
            {ret.method === 'delivery' ? (
              <TouchableOpacity style={styles.secondaryBtn} onPress={() => confirm('delivery')} accessibilityRole="button" accessibilityLabel="Confirm delivery received">
                <Ionicons name="cube-outline" size={16} color={DARK} />
                <Text style={styles.secondaryText}>Confirm delivery received</Text>
              </TouchableOpacity>
            ) : null}
          </>
        ) : null
      ) : (
        <>
          {active ? (
            <View style={styles.row}>
              <TouchableOpacity
                style={styles.smallPrimary}
                onPress={() => router.push({ pathname: '/handover/authorize', params: { requestId: request.id, authorizationId: active.id, kind: 'return' } })}
                accessibilityRole="button"
                accessibilityLabel="Show return QR"
              >
                <Text style={styles.primaryText}>Show or share QR</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.smallDanger}
                disabled={busy}
                onPress={() => revoke(active)}
                accessibilityRole="button"
                accessibilityLabel={`Revoke ${active.recipientName}’s return authorization`}
              >
                <Text style={styles.dangerText}>Revoke</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {!ret ? (
            options
          ) : choosing ? (
            options
          ) : (
            <TouchableOpacity style={styles.linkBtn} onPress={() => setChoosing(true)} accessibilityRole="button" accessibilityLabel="Change how you return it">
              <Text style={styles.link}>Change how you return it</Text>
            </TouchableOpacity>
          )}
        </>
      )}

      {past.length > 0 ? (
        <>
          <Text style={styles.label}>Earlier return authorizations</Text>
          {past.map((a) => (
            <AuthorizationLine key={a.id} a={a} />
          ))}
        </>
      ) : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: Colors.white, borderRadius: Radii.lg, padding: Spacing.lg, gap: Spacing.sm, borderWidth: 1, borderColor: Colors.fog, ...Shadows.sm },
  inner: { borderWidth: 1, borderColor: Colors.fog, borderRadius: Radii.md, padding: Spacing.md, gap: 4 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.sm },
  row: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.xs },
  sectionTitle: { fontSize: Typography.sizes.base, fontWeight: Typography.weights.bold, color: DARK },
  body1: { flexShrink: 1, fontSize: Typography.sizes.base, color: Colors.navy, fontWeight: Typography.weights.semibold },
  label: { fontSize: Typography.sizes.sm, fontWeight: Typography.weights.bold, color: Colors.navy, marginTop: Spacing.xs },
  meta: { fontSize: Typography.sizes.sm, color: Colors.slate },
  small: { fontSize: Typography.sizes.xs, color: Colors.slate },
  warn: { fontSize: Typography.sizes.sm, color: '#991b1b', backgroundColor: '#fee2e2', borderRadius: Radii.md, padding: Spacing.md },
  error: { fontSize: Typography.sizes.sm, color: '#b91c1c' },
  chip: { borderRadius: Radii.full, paddingHorizontal: 8, paddingVertical: 3 },
  chipText: { fontSize: 11, fontWeight: Typography.weights.bold },
  option: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, borderWidth: 1, borderColor: Colors.fog, borderRadius: Radii.md, padding: Spacing.md },
  optionTitle: { fontSize: Typography.sizes.base, fontWeight: Typography.weights.semibold, color: Colors.navy },
  input: {
    borderWidth: 1, borderColor: Colors.fog, borderRadius: Radii.md, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    fontSize: Typography.sizes.base, color: Colors.navy, backgroundColor: Colors.offWhite, marginTop: 4,
  },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.lg },
  stepBtn: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: GREEN, alignItems: 'center', justifyContent: 'center' },
  stepValue: { fontSize: Typography.sizes.lg, fontWeight: Typography.weights.bold, color: Colors.navy, minWidth: 90, textAlign: 'center' },
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
  smallPrimary: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: GREEN, borderRadius: Radii.full, paddingVertical: 7, paddingHorizontal: Spacing.lg },
  smallSecondary: { borderWidth: 1, borderColor: GREEN, borderRadius: Radii.full, paddingVertical: 7, paddingHorizontal: Spacing.lg },
  smallDanger: { borderWidth: 1, borderColor: '#fca5a5', borderRadius: Radii.full, paddingVertical: 7, paddingHorizontal: Spacing.lg },
  dangerText: { color: '#b91c1c', fontWeight: Typography.weights.bold, fontSize: Typography.sizes.sm },
  linkBtn: { alignSelf: 'flex-start', paddingVertical: 4 },
  link: { color: GREEN, fontWeight: Typography.weights.bold, fontSize: Typography.sizes.sm },
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  photo: { width: 72, height: 72, borderRadius: Radii.md },
  photoMissing: { backgroundColor: Colors.fog },
  disabled: { opacity: 0.5 },
});
