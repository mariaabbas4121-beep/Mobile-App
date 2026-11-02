import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Modal, Platform, ScrollView,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useBorrowRequests } from '../../context/BorrowRequestsContext';
import { useSubmit } from '../auth/useSubmit';
import { isApiError } from '../../lib/api/client';
import type { BorrowRequest, DateRange } from '../../lib/api/types';
import { errorMessage } from '../../lib/auth/messages';
import { addDays, dateParts, formatRange, inclusiveDays, isBooked, rangeProblem, todayInPakistan } from '../../lib/borrow/dates';
import { Colors, Radii, Shadows, Spacing, Typography } from '../../utils/theme';

// Days shown in the picker, starting today.
const DAYS_SHOWN = 60;

interface Props {
  visible: boolean;
  listing: { id: string; title: string };
  onClose: () => void;
  onSubmitted: (request: BorrowRequest) => void;
  // For tests; defaults to today in Pakistan.
  today?: string;
}

// Request form: pick an inclusive date range (tap the first day, then the
// last; one tap twice = a single day), add an optional note, send. Booked
// days come from the server and cannot be picked; the server re-checks.
export function BorrowRequestSheet({ visible, listing, onClose, onSubmitted, today: todayProp }: Props) {
  // Stable functions only: the context value changes on every revision,
  // which must not reset the form.
  const { bookedDates, create } = useBorrowRequests();
  const today = todayProp ?? todayInPakistan();
  const days = useMemo(() => Array.from({ length: DAYS_SHOWN }, (_, i) => addDays(today, i)), [today]);

  const [booked, setBooked] = useState<DateRange[]>([]);
  const [bookedState, setBookedState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [start, setStart] = useState<string | null>(null);
  const [end, setEnd] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const loadBooked = useCallback(async () => {
    setBookedState('loading');
    try {
      setBooked(await bookedDates(listing.id));
      setBookedState('ready');
    } catch {
      // The server checks dates on submit anyway.
      setBookedState('failed');
    }
  }, [bookedDates, listing.id]);

  useEffect(() => {
    if (!visible) return;
    setStart(null);
    setEnd(null);
    setMessage('');
    setSubmitError(null);
    void loadBooked();
  }, [visible, loadBooked]);

  const pick = (date: string) => {
    setSubmitError(null);
    if (!start || end) {
      setStart(date);
      setEnd(null);
    } else if (date < start) {
      setStart(date);
    } else {
      setEnd(date);
    }
  };

  // A start without an end is a one-day request until the end is picked.
  const range: DateRange | null = start ? { startDate: start, endDate: end ?? start } : null;
  const problem = rangeProblem(range, booked, today);

  const [submit, submitting] = useSubmit(
    useCallback(async () => {
      if (!range || problem) return;
      setSubmitError(null);
      try {
        const request = await create({
          listingId: listing.id,
          startDate: range.startDate,
          endDate: range.endDate,
          message: message.trim() || null,
        });
        onSubmitted(request);
      } catch (err) {
        setSubmitError(errorMessage(err));
        // Someone else's request was accepted for these days meanwhile.
        if (isApiError(err) && err.code === 'DATES_UNAVAILABLE') void loadBooked();
      }
    }, [range, problem, create, listing.id, message, onSubmitted, loadBooked]),
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.headerRow}>
            <View style={styles.headerText}>
              <Text style={styles.title}>Request to borrow</Text>
              <Text style={styles.subtitle} numberOfLines={1}>{listing.title}</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityRole="button" accessibilityLabel="Close request form">
              <Ionicons name="close" size={20} color={Colors.navy} />
            </TouchableOpacity>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <Text style={styles.label}>Dates</Text>
            <Text style={styles.hint}>Tap the first day, then the last day. Both days are included.</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.days}>
              {days.map((d) => {
                const taken = isBooked(d, booked);
                const selected = range !== null && d >= range.startDate && d <= range.endDate;
                const { weekday, day, month } = dateParts(d);
                return (
                  <TouchableOpacity
                    key={d}
                    style={[styles.day, selected && styles.daySelected, taken && styles.dayTaken]}
                    onPress={() => pick(d)}
                    disabled={taken || submitting}
                    accessibilityRole="button"
                    accessibilityLabel={`${day} ${month}${taken ? ', booked' : ''}`}
                    accessibilityState={{ selected, disabled: taken }}
                  >
                    <Text style={[styles.dayWeek, selected && styles.dayTextSelected]}>{weekday}</Text>
                    <Text style={[styles.dayNum, selected && styles.dayTextSelected, taken && styles.dayNumTaken]}>{day}</Text>
                    <Text style={[styles.dayMonth, selected && styles.dayTextSelected]}>{month}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            {bookedState === 'loading' ? (
              <Text style={styles.hint}>Checking booked dates…</Text>
            ) : bookedState === 'failed' ? (
              <Text style={styles.hint}>Could not load booked dates; we will check when you send.</Text>
            ) : booked.length > 0 ? (
              <Text style={styles.hint}>Greyed-out days are already booked.</Text>
            ) : null}

            <View style={styles.summary}>
              <Ionicons name="calendar-outline" size={16} color={Colors.sage} />
              <Text style={styles.summaryText}>
                {range ? `${formatRange(range.startDate, range.endDate)} · ${inclusiveDays(range.startDate, range.endDate)} day(s)` : 'No dates chosen'}
              </Text>
            </View>
            {range && problem ? <Text style={styles.error}>{problem}</Text> : null}

            <Text style={styles.label}>Message to the owner (optional)</Text>
            <TextInput
              style={styles.input}
              value={message}
              onChangeText={setMessage}
              placeholder="e.g. Need it for a weekend trip, will return clean"
              placeholderTextColor={Colors.slate}
              multiline
              maxLength={500}
              textAlignVertical="top"
              accessibilityLabel="Message to the owner"
            />
            <Text style={styles.counter}>{message.length}/500</Text>
            <Text style={styles.note}>
              You can chat with the owner after they accept. Until then, keep personal details out of the message.
            </Text>

            {submitError ? <Text style={styles.error} accessibilityRole="alert">{submitError}</Text> : null}

            <TouchableOpacity
              style={[styles.submit, (Boolean(problem) || submitting) && styles.submitDisabled]}
              onPress={() => void submit()}
              disabled={Boolean(problem) || submitting}
              accessibilityRole="button"
              accessibilityLabel="Send request"
              accessibilityState={{ disabled: Boolean(problem) || submitting, busy: submitting }}
            >
              <LinearGradient
                colors={[Colors.amber, Colors.amberDark]}
                style={styles.submitGrad}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
              >
                {submitting ? <ActivityIndicator color={Colors.navy} /> : null}
                <Text style={styles.submitText}>{submitting ? 'Sending…' : 'Send request'}</Text>
              </LinearGradient>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.45)' },
  sheet: {
    backgroundColor: Colors.offWhite, borderTopLeftRadius: Radii['2xl'], borderTopRightRadius: Radii['2xl'],
    padding: Spacing.xl, paddingBottom: Spacing['2xl'], maxHeight: '88%', ...Shadows.lg,
  },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: Spacing.md },
  headerText: { flex: 1 },
  title: { fontSize: Typography.sizes.lg, fontWeight: Typography.weights.extrabold, color: Colors.navy },
  subtitle: { fontSize: Typography.sizes.sm, color: Colors.slate, marginTop: 2 },
  closeBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.fog, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: Typography.sizes.sm, fontWeight: Typography.weights.bold, color: Colors.navy, marginTop: Spacing.md, marginBottom: 4 },
  hint: { fontSize: Typography.sizes.xs, color: Colors.slate, marginBottom: Spacing.sm },
  days: { gap: Spacing.sm, paddingVertical: Spacing.sm },
  day: {
    width: 52, paddingVertical: Spacing.sm, borderRadius: Radii.md, alignItems: 'center',
    backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.fog,
  },
  daySelected: { backgroundColor: Colors.amber, borderColor: Colors.amberDark },
  dayTaken: { backgroundColor: Colors.fog, opacity: 0.5 },
  dayWeek: { fontSize: 10, color: Colors.slate, fontWeight: Typography.weights.semibold },
  dayNum: { fontSize: Typography.sizes.md, fontWeight: Typography.weights.bold, color: Colors.navy },
  dayNumTaken: { textDecorationLine: 'line-through' },
  dayMonth: { fontSize: 10, color: Colors.slate },
  dayTextSelected: { color: Colors.navy },
  summary: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, backgroundColor: Colors.white,
    borderRadius: Radii.md, padding: Spacing.md, marginTop: Spacing.sm, ...Shadows.sm,
  },
  summaryText: { fontSize: Typography.sizes.sm, fontWeight: Typography.weights.semibold, color: Colors.navy },
  input: {
    backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.fog, borderRadius: Radii.md,
    padding: Spacing.md, minHeight: 80, fontSize: Typography.sizes.base, color: Colors.navy,
  },
  counter: { alignSelf: 'flex-end', fontSize: 10, color: Colors.slate, marginTop: 2 },
  note: { fontSize: Typography.sizes.xs, color: Colors.slate, marginTop: Spacing.sm },
  error: { color: '#b91c1c', fontSize: Typography.sizes.sm, fontWeight: Typography.weights.semibold, marginTop: Spacing.sm },
  submit: { borderRadius: Radii.lg, overflow: 'hidden', marginTop: Spacing.lg },
  submitDisabled: { opacity: 0.5 },
  submitGrad: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, paddingVertical: Spacing.md },
  submitText: { fontSize: Typography.sizes.base, fontWeight: Typography.weights.bold, color: Colors.navy },
});
