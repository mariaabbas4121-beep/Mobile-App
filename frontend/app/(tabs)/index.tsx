import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  TextInput, ScrollView, Image, Dimensions, ActivityIndicator, RefreshControl,
} from 'react-native';
import { useCallback, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApp } from '../../context/AppContext';
import { useListings } from '../../context/ListingsContext';
import { useDiscovery } from '../../context/DiscoveryContext';
import { AreaBar, AreaPicker, LocationCard, RadiusChips } from '../../components/discovery/DiscoveryControls';
import { formatDistance, nextRadius } from '../../lib/location/geo';
import type { Listing, ListingCategory } from '../../lib/api/types';
import { errorMessage } from '../../lib/auth/messages';
import { CATEGORY_OPTIONS, conditionLabel } from '../../lib/listings/options';
import { useListingFeed } from '../../lib/listings/useListingFeed';
import { Colors, Typography, Spacing, Radii, Shadows } from '../../utils/theme';

const { width } = Dimensions.get('window');
const CARD_WIDTH = (width - Spacing.xl * 2 - Spacing.md) / 2;

const FILTERS: { id: 'all' | ListingCategory; label: string; icon: string }[] = [
  { id: 'all', label: 'All', icon: '🏠' },
  ...CATEGORY_OPTIONS.map((c) => ({ id: c.value, label: c.label, icon: c.icon })),
];

function ItemCard({ item, onPress }: { item: Listing; onPress: () => void }) {
  const cover = item.images[0]?.url;
  const ownerName = item.owner.displayName ?? 'Neighbor';
  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.88} accessibilityRole="button" accessibilityLabel={item.title}>
      <View style={styles.imageWrap}>
        {cover ? (
          <Image source={{ uri: cover }} style={styles.cardImage} resizeMode="cover" />
        ) : (
          <View style={[styles.cardImage, styles.imagePlaceholder]}>
            <Ionicons name="image-outline" size={28} color={Colors.slate} />
          </View>
        )}
        {item.availability === 'unavailable' && (
          <View style={styles.unavailableOverlay}>
            <Text style={styles.unavailableText}>Unavailable</Text>
          </View>
        )}
        {item.teachMeEnabled && (
          <View style={styles.teachBadge}>
            <Text style={styles.teachBadgeText}>🎓</Text>
          </View>
        )}
        {item.area ? (
          <View style={styles.distanceBadge}>
            <Ionicons name="location" size={10} color={Colors.green || "#2e7d32"} />
            <Text style={styles.distanceText} numberOfLines={1}>{item.area}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle} numberOfLines={1}>{item.title}</Text>
        <View style={styles.cardMeta}>
          <View style={[styles.conditionDot, {
            backgroundColor: item.condition === 'excellent' ? (Colors.green || '#2e7d32')
              : item.condition === 'good' ? '#4caf50' : Colors.slate
          }]} />
          <Text style={styles.cardCondition}>{conditionLabel(item.condition)}</Text>
        </View>
        {item.distanceKm !== null ? (
          <Text style={styles.cardDistance} numberOfLines={1}>{formatDistance(item.distanceKm)}</Text>
        ) : item.city && !item.approximateLocation ? (
          <Text style={styles.cardDistance} numberOfLines={1}>In {item.city} · no map spot</Text>
        ) : null}
        <View style={styles.ownerRow}>
          <View style={[styles.ownerAvatar, styles.ownerInitialWrap]}>
            <Text style={styles.ownerInitial}>{ownerName.charAt(0).toUpperCase()}</Text>
          </View>
          <Text style={styles.ownerName} numberOfLines={1}>{ownerName}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

export default function BrowseScreen() {
  const router = useRouter();
  const { searchQuery, setSearchQuery, activeCategory, setActiveCategory } = useApp();
  const category = activeCategory === 'all' ? null : (activeCategory as ListingCategory);
  const discovery = useDiscovery();
  const feed = useListingFeed({ query: searchQuery, category, scope: discovery.scope, enabled: discovery.ready });
  const { lastCreatedId } = useListings();
  const [picking, setPicking] = useState(false);
  const nearby = discovery.area.kind === 'device' || discovery.area.kind === 'place';
  const wider = nearby ? nextRadius(discovery.radiusKm) : null;

  // Coming back to this tab (e.g. after listing an item) reloads only if
  // the list is behind a change or its last background reload failed.
  const { refreshIfStale } = feed;
  useFocusEffect(useCallback(() => refreshIfStale(), [refreshIfStale]));

  // Browse lists other people's items only, so a just-listed item is never
  // here. Say where it is instead, until dismissed.
  const [dismissedCreated, setDismissedCreated] = useState<string | null>(null);
  const showCreatedNote = lastCreatedId !== null && dismissedCreated !== lastCreatedId;

  const renderHeader = () => (
    <>
      {feed.refreshError && feed.status === 'ready' ? (
        <View style={styles.notice} accessibilityRole="alert">
          <Text style={styles.noticeText}>Could not refresh the list. {errorMessage(feed.refreshError)}</Text>
          <TouchableOpacity onPress={feed.refresh} accessibilityRole="button" accessibilityLabel="Refresh list">
            <Text style={styles.noticeAction}>Refresh</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {showCreatedNote ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>
            Your item is listed. Browse shows other people’s items; yours are in Profile → My Listings.
          </Text>
          <TouchableOpacity onPress={() => router.push('/listings/mine')} accessibilityRole="button" accessibilityLabel="Open My Listings">
            <Text style={styles.noticeAction}>My Listings</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setDismissedCreated(lastCreatedId)} accessibilityRole="button" accessibilityLabel="Dismiss">
            <Text style={styles.noticeAction}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      <LocationCard onChooseArea={() => setPicking(true)} />
      {feed.status === 'ready' && feed.total > 0 ? (
        <Text style={styles.resultCount}>
          {feed.total} {feed.total === 1 ? 'item' : 'items'}{' '}
          {nearby
            ? `within ${discovery.radiusKm} km, nearest first`
            : discovery.area.kind === 'city'
              ? `in ${discovery.area.city}, newest first`
              : 'in all areas, newest first'}
        </Text>
      ) : null}
      {feed.status === 'ready' && nearby && feed.total > 0 && feed.total < 3 && wider && !feed.filtered ? (
        <TouchableOpacity
          style={styles.expandInline}
          onPress={() => discovery.setRadius(wider)}
          accessibilityRole="button"
          accessibilityLabel={`Expand to ${wider} km`}
        >
          <Text style={styles.noticeAction}>Only a few nearby. Expand to {wider} km</Text>
        </TouchableOpacity>
      ) : null}
    </>
  );

  const renderEmpty = () => {
    if (feed.status === 'loading') {
      return (
        <View style={styles.emptyState} accessibilityLabel="Loading items">
          <ActivityIndicator size="large" color={Colors.green || '#2e7d32'} />
        </View>
      );
    }
    if (feed.status === 'error') {
      return (
        <View style={styles.emptyState}>
          <Text style={styles.emptyEmoji}>📡</Text>
          <Text style={styles.emptyTitle}>Could not load items</Text>
          <Text style={styles.emptyDesc}>{errorMessage(feed.error)}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={feed.retry} accessibilityRole="button" accessibilityLabel="Try again">
            <Text style={styles.retryText}>Try again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    const filtered = feed.filtered;
    if (nearby) {
      return (
        <View style={styles.emptyState}>
          <Text style={styles.emptyEmoji}>📍</Text>
          <Text style={styles.emptyTitle}>{filtered ? 'Nothing nearby matches' : 'No items nearby'}</Text>
          <Text style={styles.emptyDesc}>
            Nothing {filtered ? 'matching your search ' : ''}within {discovery.radiusKm} km of{' '}
            {discovery.area.kind === 'device' ? 'you' : discovery.label.replace(/^Near /, '')}.
          </Text>
          {wider ? (
            <TouchableOpacity
              style={styles.retryBtn}
              onPress={() => discovery.setRadius(wider)}
              accessibilityRole="button"
              accessibilityLabel={`Expand to ${wider} km`}
            >
              <Text style={styles.retryText}>Expand to {wider} km</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={styles.linkBtn} onPress={() => setPicking(true)} accessibilityRole="button" accessibilityLabel="Choose another area">
            <Text style={styles.noticeAction}>Choose another area</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyEmoji}>{filtered ? '🔍' : '📦'}</Text>
        <Text style={styles.emptyTitle}>{filtered ? 'Nothing found' : 'No items yet'}</Text>
        <Text style={styles.emptyDesc}>
          {filtered ? 'Try a different search or category' : 'Be the first to lend something to your neighbors'}
        </Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* Header Container */}
      <View style={styles.header}>
        <SafeAreaView edges={['top']}>
          <View style={styles.headerContent}>
            <View>
              <Text style={styles.greeting}>Good morning 👋</Text>
              <Text style={styles.headline}>What do you need today?</Text>
            </View>
            <TouchableOpacity
              style={styles.lendBtn}
              onPress={() => router.push('/lend/new')}
              activeOpacity={0.85}
            >
              <Ionicons name="add" size={20} color={Colors.white} />
              <Text style={styles.lendBtnText}>Lend</Text>
            </TouchableOpacity>
          </View>

          {/* Search Bar */}
          <View style={styles.searchRow}>
            <Ionicons name="search" size={18} color={Colors.slate} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search items, tools, gadgets…"
              placeholderTextColor={Colors.slate}
              value={searchQuery}
              onChangeText={setSearchQuery}
              returnKeyType="search"
              maxLength={100}
              accessibilityLabel="Search items"
            />
            {searchQuery ? (
              <TouchableOpacity onPress={() => setSearchQuery('')} accessibilityLabel="Clear search">
                <Ionicons name="close-circle" size={18} color={Colors.slate} />
              </TouchableOpacity>
            ) : null}
          </View>

          <View style={styles.areaRow}>
            <View style={{ flex: 1 }}>
              <AreaBar onChange={() => setPicking(true)} />
            </View>
            <TouchableOpacity
              style={styles.mapToggle}
              onPress={() => router.navigate('/map')}
              accessibilityRole="button"
              accessibilityLabel="Show on map"
            >
              <Ionicons name="map-outline" size={15} color={Colors.green || '#2e7d32'} />
              <Text style={styles.mapToggleText}>Map</Text>
            </TouchableOpacity>
          </View>
          <RadiusChips />

          {/* Categories Horizontal Scroller */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.catScroll} contentContainerStyle={styles.catContent}>
            {FILTERS.map(cat => (
              <TouchableOpacity
                key={cat.id}
                style={[styles.catChip, activeCategory === cat.id && styles.catChipActive]}
                onPress={() => setActiveCategory(cat.id)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={cat.label}
                accessibilityState={{ selected: activeCategory === cat.id }}
              >
                <Text style={styles.catIcon}>{cat.icon}</Text>
                <Text style={[styles.catLabel, activeCategory === cat.id && styles.catLabelActive]}>
                  {cat.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </SafeAreaView>
      </View>

      {/* Grid Results */}
      <FlatList
        testID="listing-feed"
        data={feed.status === 'ready' ? feed.items : []}
        numColumns={2}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.grid}
        columnWrapperStyle={styles.row}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={feed.refreshing} onRefresh={feed.refresh} tintColor={Colors.green || '#2e7d32'} />
        }
        onEndReached={feed.loadMore}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={renderHeader()}
        ListEmptyComponent={renderEmpty()}
        ListFooterComponent={
          feed.loadingMore ? <ActivityIndicator style={styles.footerSpinner} color={Colors.green || '#2e7d32'} /> : undefined
        }
        renderItem={({ item }) => (
          <ItemCard
            item={item}
            onPress={() => router.push(`/item/${item.id}`)}
          />
        )}
      />
      <AreaPicker visible={picking} onClose={() => setPicking(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.offWhite },
  header: { 
    paddingHorizontal: Spacing.xl, 
    paddingBottom: Spacing.lg,
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderColor: Colors.fog,
    ...Shadows.sm,
  },
  headerContent: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginTop: Spacing.sm, marginBottom: Spacing.lg },
  greeting: { fontSize: Typography.sizes.sm, color: Colors.slate },
  headline: { fontSize: Typography.sizes.xl, fontWeight: Typography.weights.extrabold, color: Colors.greenDark || '#1b5e20', marginTop: 2 },
  lendBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.green || '#2e7d32', paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm, borderRadius: Radii.full,
  },
  lendBtnText: { fontSize: Typography.sizes.sm, fontWeight: Typography.weights.bold, color: Colors.white },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.offWhite, borderRadius: Radii.lg,
    paddingHorizontal: Spacing.base, paddingVertical: Spacing.sm + 2,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.fog,
  },
  searchInput: { flex: 1, fontSize: Typography.sizes.base, color: Colors.greenDark || '#1b5e20' },
  catScroll: { marginHorizontal: -Spacing.xl },
  catContent: { paddingHorizontal: Spacing.xl, gap: Spacing.sm },
  catChip: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs,
    backgroundColor: Colors.offWhite, borderRadius: Radii.full,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2,
    borderWidth: 1, borderColor: Colors.fog,
  },
  catChipActive: { 
    backgroundColor: (Colors.green || '#2e7d32') + '15', 
    borderColor: Colors.green || '#2e7d32' 
  },
  catIcon: { fontSize: 14 },
  catLabel: { fontSize: Typography.sizes.sm, color: Colors.slate, fontWeight: Typography.weights.medium },
  catLabelActive: { color: Colors.greenDark || '#1b5e20', fontWeight: Typography.weights.semibold },
  grid: { padding: Spacing.xl, paddingBottom: 100 },
  row: { justifyContent: 'space-between' },
  notice: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: '#fff8e1', borderWidth: 1, borderColor: '#ffe082',
    borderRadius: Radii.md, padding: Spacing.md, marginBottom: Spacing.md,
  },
  noticeText: { flex: 1, fontSize: Typography.sizes.sm, color: Colors.greenDark || '#1b5e20' },
  noticeAction: { fontSize: Typography.sizes.sm, fontWeight: Typography.weights.bold, color: Colors.green || '#2e7d32' },
  areaRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  mapToggle: {
    flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: Spacing.sm,
    borderWidth: 1, borderColor: Colors.fog, borderRadius: Radii.full, paddingHorizontal: Spacing.sm, paddingVertical: 4,
  },
  mapToggleText: { fontSize: Typography.sizes.xs, fontWeight: Typography.weights.bold, color: Colors.greenDark || '#1b5e20' },
  expandInline: { marginTop: -Spacing.sm, marginBottom: Spacing.md },
  linkBtn: { marginTop: Spacing.md },
  cardDistance: { fontSize: Typography.sizes.xs, color: Colors.green || '#2e7d32', fontWeight: Typography.weights.semibold, marginBottom: 6 },
  resultCount: { fontSize: Typography.sizes.sm, color: Colors.slate, marginBottom: Spacing.md, fontWeight: Typography.weights.medium },
  card: {
    width: CARD_WIDTH, backgroundColor: Colors.white,
    borderRadius: Radii.lg, marginBottom: Spacing.md,
    overflow: 'hidden', ...Shadows.sm,
    borderWidth: 1,
    borderColor: Colors.fog,
  },
  imageWrap: { position: 'relative' },
  cardImage: { width: '100%', height: 130 },
  imagePlaceholder: { backgroundColor: Colors.fog, alignItems: 'center', justifyContent: 'center' },
  unavailableOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(27,94,32,0.6)', // Green translucent overlay for unavailable
    alignItems: 'center', justifyContent: 'center',
  },
  unavailableText: { color: Colors.white, fontWeight: Typography.weights.bold, fontSize: Typography.sizes.sm },
  teachBadge: {
    position: 'absolute', top: 8, left: 8,
    backgroundColor: Colors.white,
    borderRadius: Radii.full, width: 26, height: 26,
    alignItems: 'center', justifyContent: 'center',
    ...Shadows.sm,
  },
  teachBadgeText: { fontSize: 13 },
  distanceBadge: {
    position: 'absolute', top: 8, right: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    borderRadius: Radii.full, flexDirection: 'row',
    alignItems: 'center', paddingHorizontal: 6, paddingVertical: 3, gap: 2,
    ...Shadows.sm,
  },
  distanceText: { maxWidth: CARD_WIDTH - 60, fontSize: 10, color: Colors.greenDark || '#1b5e20', fontWeight: Typography.weights.bold },
  cardBody: { padding: Spacing.md },
  cardTitle: { fontSize: Typography.sizes.base, fontWeight: Typography.weights.semibold, color: Colors.greenDark || '#1b5e20', marginBottom: 4 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 8 },
  conditionDot: { width: 7, height: 7, borderRadius: 4 },
  cardCondition: { fontSize: Typography.sizes.xs, color: Colors.slate },
  ownerRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  ownerAvatar: { width: 18, height: 18, borderRadius: 9 },
  ownerInitialWrap: { backgroundColor: (Colors.green || '#2e7d32') + '25', alignItems: 'center', justifyContent: 'center' },
  ownerInitial: { fontSize: 10, fontWeight: Typography.weights.bold, color: Colors.greenDark || '#1b5e20' },
  ownerName: { flex: 1, fontSize: Typography.sizes.xs, color: Colors.slate },
  trustChip: {
    backgroundColor: (Colors.green || '#2e7d32') + '15', borderRadius: Radii.full,
    paddingHorizontal: 5, paddingVertical: 2,
  },
  trustText: { fontSize: 9, fontWeight: Typography.weights.bold, color: Colors.greenDark || '#1b5e20' },
  emptyState: { alignItems: 'center', paddingTop: 60 },
  emptyEmoji: { fontSize: 48, marginBottom: Spacing.md },
  emptyTitle: { fontSize: Typography.sizes.lg, fontWeight: Typography.weights.bold, color: Colors.greenDark || '#1b5e20' },
  emptyDesc: { fontSize: Typography.sizes.base, color: Colors.slate, marginTop: Spacing.xs, textAlign: 'center', paddingHorizontal: Spacing.xl },
  retryBtn: {
    marginTop: Spacing.lg, backgroundColor: Colors.green || '#2e7d32',
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.sm + 2, borderRadius: Radii.full,
  },
  retryText: { color: Colors.white, fontWeight: Typography.weights.bold, fontSize: Typography.sizes.sm },
  footerSpinner: { marginVertical: Spacing.lg },
});