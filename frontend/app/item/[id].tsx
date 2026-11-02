import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Image, Dimensions, Alert, ActivityIndicator,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import { useAuth } from '../../context/AuthContext';
import { useListings } from '../../context/ListingsContext';
import { useSubmit } from '../../components/auth/useSubmit';
import { BorrowRequestSheet } from '../../components/borrow/BorrowRequestSheet';
import { isApiError } from '../../lib/api/client';
import type { Listing } from '../../lib/api/types';
import { errorMessage } from '../../lib/auth/messages';
import { categoryLabel, conditionLabel, formatPkr } from '../../lib/listings/options';
import { Colors, Typography, Spacing, Radii, Shadows } from '../../utils/theme';

const { width, height } = Dimensions.get('window');

export default function ItemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const listings = useListings();

  const [item, setItem] = useState<Listing | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [requestOpen, setRequestOpen] = useState(false);

  // Always shows the server's copy; availability is never decided locally.
  const load = useCallback(
    async (quiet: boolean) => {
      if (!id) return;
      if (!quiet) setStatus('loading');
      try {
        setItem(await listings.get(id));
        setError(null);
        setStatus('ready');
      } catch (err) {
        setError(err);
        if (!quiet) setStatus('error');
      }
    },
    [id, listings.get],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  // Reload after an edit made on another screen.
  const seenRevision = useRef(listings.revision);
  useEffect(() => {
    if (listings.revision !== seenRevision.current) {
      seenRevision.current = listings.revision;
      void load(true);
    }
  }, [listings.revision, load]);

  const [toggleAvailability, toggling] = useSubmit(
    useCallback(async () => {
      if (!item) return;
      const next = item.availability === 'available' ? 'unavailable' : 'available';
      try {
        setItem(await listings.setAvailability(item.id, next));
        Toast.show({ type: 'success', text1: next === 'available' ? 'Marked as available' : 'Marked as unavailable' });
      } catch (err) {
        Toast.show({ type: 'error', text1: 'Could not update availability', text2: errorMessage(err) });
      }
    }, [item, listings]),
  );

  const [archive, archiving] = useSubmit(
    useCallback(async () => {
      if (!item) return;
      try {
        await listings.archive(item.id);
        Toast.show({ type: 'success', text1: 'Listing removed', text2: 'Neighbors can no longer see this item' });
        router.back();
      } catch (err) {
        Toast.show({ type: 'error', text1: 'Could not remove listing', text2: errorMessage(err) });
      }
    }, [item, listings, router]),
  );

  const confirmArchive = () =>
    Alert.alert('Remove this listing?', 'Neighbors will no longer see it. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void archive() },
    ]);

  if (status !== 'ready' || !item) {
    // A malformed id (e.g. a sample item from the map prototype) is as
    // missing as a deleted one.
    const missing = isApiError(error) && (error.code === 'LISTING_NOT_FOUND' || error.code === 'VALIDATION_ERROR');
    return (
      <View style={[styles.container, styles.centered]}>
        <SafeAreaView edges={['top']} style={styles.stateBackWrap}>
          <TouchableOpacity style={styles.stateBackBtn} onPress={() => router.back()} accessibilityLabel="Go back">
            <Ionicons name="arrow-back" size={20} color={Colors.navy} />
          </TouchableOpacity>
        </SafeAreaView>
        {status === 'loading' ? (
          <ActivityIndicator size="large" color={Colors.sage} accessibilityLabel="Loading item" />
        ) : (
          <>
            <Text style={styles.stateEmoji}>{missing ? '📦' : '📡'}</Text>
            <Text style={styles.stateTitle}>{missing ? 'Item not found' : 'Could not load this item'}</Text>
            <Text style={styles.stateDesc}>{missing ? 'This item is no longer listed.' : errorMessage(error)}</Text>
            {!missing && (
              <TouchableOpacity style={styles.stateRetry} onPress={() => void load(false)} accessibilityRole="button" accessibilityLabel="Try again">
                <Text style={styles.stateRetryText}>Try again</Text>
              </TouchableOpacity>
            )}
          </>
        )}
      </View>
    );
  }

  const isOwnItem = item.owner.id === user?.id;
  const available = item.availability === 'available' && !item.archivedAt;
  const ownerName = item.owner.displayName ?? 'Neighbor';
  const photos = item.images.filter((img) => img.url);

  // The request goes to the server; the owner sees it under Lending.
  const onRequested = () => {
    setRequestOpen(false);
    Toast.show({ type: 'success', text1: 'Request sent', text2: `${ownerName} can now accept or decline it` });
    router.push({ pathname: '/requests', params: { tab: 'borrowing' } });
  };

  return (
    <View style={styles.container}>
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Hero image */}
        <View style={styles.imageContainer}>
          {photos.length > 0 ? (
            <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false}>
              {photos.map((photo) => (
                <Image key={photo.id} source={{ uri: photo.url! }} style={styles.heroImage} resizeMode="cover" />
              ))}
            </ScrollView>
          ) : (
            <View style={[styles.heroImage, styles.heroPlaceholder]}>
              <Ionicons name="image-outline" size={56} color={Colors.slate} />
            </View>
          )}
          <LinearGradient
            colors={['transparent', Colors.navy + 'CC']}
            style={styles.imageOverlay}
            pointerEvents="none"
          />
          {/* Back button */}
          <SafeAreaView edges={['top']} style={styles.backWrap}>
            <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} accessibilityLabel="Go back">
              <Ionicons name="arrow-back" size={20} color={Colors.white} />
            </TouchableOpacity>
            {photos.length > 1 ? (
              <View style={styles.photoCount}>
                <Text style={styles.photoCountText}>{photos.length} photos</Text>
              </View>
            ) : null}
          </SafeAreaView>

          {/* Image badges */}
          <View style={styles.imageBadges} pointerEvents="none">
            <View style={[styles.availBadge, { backgroundColor: available ? Colors.sage : Colors.rose }]}>
              <View style={styles.availDot} />
              <Text style={styles.availText}>
                {item.archivedAt ? 'Removed' : available ? 'Available Now' : 'Currently Unavailable'}
              </Text>
            </View>
            {item.teachMeEnabled && (
              <View style={styles.teachBadge}>
                <Text style={styles.teachBadgeText}>🎓 Teach Me Available</Text>
              </View>
            )}
          </View>
        </View>

        {/* Content */}
        <View style={styles.content}>
          {/* Title & condition */}
          <View style={styles.titleRow}>
            <View style={styles.titleLeft}>
              <Text style={styles.category}>{categoryLabel(item.category)}</Text>
              <Text style={styles.title}>{item.title}</Text>
            </View>
            <View style={[styles.conditionChip, {
              backgroundColor: item.condition === 'excellent' ? Colors.sagePale
                : item.condition === 'good' ? Colors.amberPale : Colors.fog
            }]}>
              <Text style={[styles.conditionText, {
                color: item.condition === 'excellent' ? Colors.sageDark
                  : item.condition === 'good' ? Colors.amberDark : Colors.slate
              }]}>
                {conditionLabel(item.condition)}
              </Text>
            </View>
          </View>

          {/* Stats row */}
          <View style={styles.statsRow}>
            <View style={styles.statItem}>
              <Ionicons name="location-outline" size={16} color={Colors.amber} />
              <Text style={styles.statText} numberOfLines={1}>{item.area ?? 'Area not set'}</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Ionicons name="cash-outline" size={16} color={Colors.sky} />
              <Text style={styles.statText} numberOfLines={1}>
                {item.replacementValuePkr != null ? `Worth ${formatPkr(item.replacementValuePkr)}` : 'Value not set'}
              </Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Ionicons name="pricetag-outline" size={16} color={Colors.violet} />
              <Text style={styles.statText}>Free to borrow</Text>
            </View>
          </View>

          {/* Description */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>About this item</Text>
            <Text style={styles.description}>{item.description}</Text>
          </View>

          {item.borrowingTerms ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Borrowing terms</Text>
              <Text style={styles.description}>{item.borrowingTerms}</Text>
            </View>
          ) : null}

          {/* Tags */}
          {item.tags.length > 0 && (
            <View style={styles.tagsRow}>
              {item.tags.map(tag => (
                <View key={tag} style={styles.tag}>
                  <Text style={styles.tagText}>{tag}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Owner card */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Listed by</Text>
            <View style={styles.ownerCard}>
              <View style={[styles.ownerAvatar, styles.ownerInitialWrap]}>
                <Text style={styles.ownerInitial}>{ownerName.charAt(0).toUpperCase()}</Text>
              </View>
              <View style={styles.ownerInfo}>
                <Text style={styles.ownerName}>{isOwnItem ? `${ownerName} (you)` : ownerName}</Text>
                <View style={styles.trustRow}>
                  <Ionicons name="calendar-outline" size={13} color={Colors.sage} />
                  <Text style={styles.trustScore}>Listed {new Date(item.createdAt).toLocaleDateString()}</Text>
                </View>
              </View>
            </View>
          </View>

          {/* How it works */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>How borrowing works</Text>
            <View style={styles.howCard}>
              {[
                { icon: '📤', step: 'Send Request', desc: 'Owner reviews and accepts' },
                { icon: '📱', step: 'Scan QR at Pickup', desc: 'Verify handover securely' },
                { icon: '📱', step: 'Scan QR at Return', desc: 'Confirm item returned' },
              ].map((s, i) => (
                <View key={i} style={styles.howRow}>
                  <View style={styles.howNum}>
                    <Text style={styles.howNumText}>{i + 1}</Text>
                  </View>
                  <Text style={styles.howEmoji}>{s.icon}</Text>
                  <View style={styles.howText}>
                    <Text style={styles.howStep}>{s.step}</Text>
                    <Text style={styles.howDesc}>{s.desc}</Text>
                  </View>
                </View>
              ))}
            </View>
          </View>

          <View style={{ height: 120 }} />
        </View>
      </ScrollView>

      {/* Bottom action */}
      {isOwnItem && !item.archivedAt && (
        <View style={styles.bottomAction}>
          <View style={styles.ownerActions}>
            <TouchableOpacity
              style={styles.ownerActionBtn}
              onPress={() => router.push({ pathname: '/lend/new', params: { id: item.id } })}
              accessibilityRole="button"
              accessibilityLabel="Edit listing"
            >
              <Ionicons name="create-outline" size={18} color={Colors.navy} />
              <Text style={styles.ownerActionText}>Edit</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.ownerActionBtn, styles.ownerActionWide]}
              onPress={() => void toggleAvailability()}
              disabled={toggling}
              accessibilityRole="button"
              accessibilityLabel={item.availability === 'available' ? 'Mark unavailable' : 'Mark available'}
            >
              <Ionicons name={item.availability === 'available' ? 'pause-circle-outline' : 'play-circle-outline'} size={18} color={Colors.navy} />
              <Text style={styles.ownerActionText}>
                {toggling ? 'Saving…' : item.availability === 'available' ? 'Mark unavailable' : 'Mark available'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.ownerActionBtn, styles.ownerActionDanger]}
              onPress={confirmArchive}
              disabled={archiving}
              accessibilityRole="button"
              accessibilityLabel="Remove listing"
            >
              <Ionicons name="trash-outline" size={18} color={Colors.rose} />
            </TouchableOpacity>
          </View>
        </View>
      )}
      {!isOwnItem && (
        <View style={styles.bottomAction}>
          <View style={styles.bottomInner}>
            <View>
              <Text style={styles.freeBadge}>🆓 Free</Text>
              <Text style={styles.borrowLabel}>Community Borrow</Text>
            </View>
            <TouchableOpacity
              style={[styles.borrowBtn, !available && styles.borrowBtnDisabled]}
              onPress={() => setRequestOpen(true)}
              activeOpacity={0.85}
              disabled={!available}
              accessibilityRole="button"
              accessibilityLabel={available ? 'Request to borrow' : 'Not available'}
              accessibilityState={{ disabled: !available }}
            >
              <LinearGradient
                colors={available ? [Colors.amber, Colors.amberDark] : [Colors.slate, Colors.slate]}
                style={styles.borrowBtnGrad}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
              >
                <Text style={styles.borrowBtnText}>
                  {!available ? 'Not Available' : 'Request to Borrow'}
                </Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </View>
      )}
      {!isOwnItem && available && (
        <BorrowRequestSheet
          visible={requestOpen}
          listing={{ id: item.id, title: item.title }}
          onClose={() => setRequestOpen(false)}
          onSubmitted={onRequested}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.offWhite },
  centered: { alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  stateBackWrap: { position: 'absolute', top: 0, left: Spacing.xl },
  stateBackBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.fog, alignItems: 'center', justifyContent: 'center' },
  stateEmoji: { fontSize: 48, marginBottom: Spacing.md },
  stateTitle: { fontSize: Typography.sizes.lg, fontWeight: Typography.weights.bold, color: Colors.navy },
  stateDesc: { fontSize: Typography.sizes.base, color: Colors.slate, marginTop: Spacing.xs, textAlign: 'center' },
  stateRetry: { marginTop: Spacing.lg, backgroundColor: Colors.sage, paddingHorizontal: Spacing.xl, paddingVertical: Spacing.sm + 2, borderRadius: Radii.full },
  stateRetryText: { color: Colors.white, fontWeight: Typography.weights.bold, fontSize: Typography.sizes.sm },
  heroPlaceholder: { backgroundColor: Colors.fog, alignItems: 'center', justifyContent: 'center' },
  photoCount: { alignSelf: 'center', backgroundColor: 'rgba(15,23,42,0.5)', borderRadius: Radii.full, paddingHorizontal: Spacing.md, paddingVertical: 4 },
  photoCountText: { color: Colors.white, fontSize: Typography.sizes.xs, fontWeight: Typography.weights.semibold },
  ownerInitialWrap: { backgroundColor: Colors.sagePale, alignItems: 'center', justifyContent: 'center' },
  ownerInitial: { fontSize: Typography.sizes.lg, fontWeight: Typography.weights.bold, color: Colors.sageDark },
  ownerActions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  ownerActionBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: Radii.lg, borderWidth: 1.5, borderColor: Colors.fog,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
  },
  ownerActionWide: { flex: 1 },
  ownerActionDanger: { borderColor: Colors.rose + '55' },
  ownerActionText: { fontSize: Typography.sizes.sm, fontWeight: Typography.weights.bold, color: Colors.navy },
  imageContainer: { position: 'relative', height: height * 0.42 },
  heroImage: { width, height: height * 0.42 },
  imageOverlay: { ...StyleSheet.absoluteFill },
  backWrap: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: Spacing.xl },
  backBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center' },
  shareBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center' },
  imageBadges: { position: 'absolute', bottom: Spacing.xl, left: Spacing.xl, gap: Spacing.sm },
  availBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: Radii.full, paddingHorizontal: Spacing.md, paddingVertical: 5 },
  availDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: Colors.white, opacity: 0.8 },
  availText: { fontSize: Typography.sizes.sm, color: Colors.white, fontWeight: Typography.weights.semibold },
  teachBadge: { backgroundColor: Colors.violetPale, borderRadius: Radii.full, paddingHorizontal: Spacing.md, paddingVertical: 4, alignSelf: 'flex-start' },
  teachBadgeText: { fontSize: Typography.sizes.xs, color: Colors.violet, fontWeight: Typography.weights.bold },
  content: { backgroundColor: Colors.offWhite, borderTopLeftRadius: Radii['2xl'], borderTopRightRadius: Radii['2xl'], marginTop: -Spacing.xl, padding: Spacing.xl },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: Spacing.base },
  titleLeft: { flex: 1 },
  category: { fontSize: Typography.sizes.xs, fontWeight: Typography.weights.bold, color: Colors.amber, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 4 },
  title: { fontSize: Typography.sizes.xl, fontWeight: Typography.weights.extrabold, color: Colors.navy, letterSpacing: -0.3 },
  conditionChip: { borderRadius: Radii.full, paddingHorizontal: Spacing.md, paddingVertical: 4, marginLeft: Spacing.sm, alignSelf: 'flex-start', marginTop: 20 },
  conditionText: { fontSize: Typography.sizes.xs, fontWeight: Typography.weights.bold },
  statsRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.white, borderRadius: Radii.lg, padding: Spacing.md, marginBottom: Spacing.xl, ...Shadows.sm },
  statItem: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 5, justifyContent: 'center' },
  statText: { fontSize: Typography.sizes.xs, color: Colors.navyMid, fontWeight: Typography.weights.medium },
  statDivider: { width: 1, height: 20, backgroundColor: Colors.fog },
  section: { marginBottom: Spacing.xl },
  sectionTitle: { fontSize: Typography.sizes.base, fontWeight: Typography.weights.bold, color: Colors.navy, marginBottom: Spacing.sm },
  description: { fontSize: Typography.sizes.base, color: Colors.slate, lineHeight: 22 },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginBottom: Spacing.xl },
  tag: { backgroundColor: Colors.fog, borderRadius: Radii.full, paddingHorizontal: Spacing.md, paddingVertical: 4 },
  tagText: { fontSize: Typography.sizes.xs, color: Colors.navyLight, fontWeight: Typography.weights.medium },
  ownerCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.white, borderRadius: Radii.lg, padding: Spacing.md, gap: Spacing.md, ...Shadows.sm },
  ownerAvatar: { width: 50, height: 50, borderRadius: 25 },
  ownerInfo: { flex: 1 },
  ownerName: { fontSize: Typography.sizes.md, fontWeight: Typography.weights.semibold, color: Colors.navy },
  trustRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
  trustScore: { fontSize: Typography.sizes.sm, color: Colors.sage },
  msgBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.amberPale, alignItems: 'center', justifyContent: 'center' },
  howCard: { backgroundColor: Colors.white, borderRadius: Radii.lg, padding: Spacing.md, gap: Spacing.md, ...Shadows.sm },
  howRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  howNum: { width: 24, height: 24, borderRadius: 12, backgroundColor: Colors.navy, alignItems: 'center', justifyContent: 'center' },
  howNumText: { fontSize: Typography.sizes.xs, fontWeight: Typography.weights.bold, color: Colors.white },
  howEmoji: { fontSize: 18 },
  howText: { flex: 1 },
  howStep: { fontSize: Typography.sizes.sm, fontWeight: Typography.weights.semibold, color: Colors.navy },
  howDesc: { fontSize: Typography.sizes.xs, color: Colors.slate },
  teachToggle: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.white, borderRadius: Radii.lg, padding: Spacing.lg,
    borderWidth: 2, borderColor: Colors.fog, ...Shadows.sm,
  },
  teachToggleActive: { borderColor: Colors.violet, backgroundColor: Colors.violetPale },
  teachToggleLeft: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, flex: 1 },
  teachToggleIcon: { fontSize: 28 },
  teachToggleTitle: { fontSize: Typography.sizes.base, fontWeight: Typography.weights.bold, color: Colors.navy },
  teachToggleSub: { fontSize: Typography.sizes.xs, color: Colors.slate, marginTop: 2 },
  toggle: { width: 46, height: 26, borderRadius: 13, backgroundColor: Colors.fog, justifyContent: 'center', paddingHorizontal: 3 },
  toggleOn: { backgroundColor: Colors.violet },
  toggleThumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: Colors.white, ...Shadows.sm },
  toggleThumbOn: { alignSelf: 'flex-end' },
  bottomAction: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: Colors.white, borderTopWidth: 1, borderTopColor: Colors.fog,
    paddingBottom: 24, paddingTop: Spacing.md, paddingHorizontal: Spacing.xl,
    ...Shadows.lg,
  },
  bottomInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  freeBadge: { fontSize: Typography.sizes.lg, fontWeight: Typography.weights.extrabold, color: Colors.sage },
  borrowLabel: { fontSize: Typography.sizes.xs, color: Colors.slate },
  borrowBtn: { borderRadius: Radii.lg, overflow: 'hidden' },
  borrowBtnDisabled: { opacity: 0.6 },
  borrowBtnGrad: { paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md },
  borrowBtnText: { fontSize: Typography.sizes.base, fontWeight: Typography.weights.bold, color: Colors.navy },
});
