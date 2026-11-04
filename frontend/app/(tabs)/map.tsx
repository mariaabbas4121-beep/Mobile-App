import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import MapView, { Circle, Marker } from 'react-native-maps';
import { useApp } from '../../context/AppContext';
import { useDiscovery } from '../../context/DiscoveryContext';
import { AreaBar, AreaPicker, LocationCard, RadiusChips } from '../../components/discovery/DiscoveryControls';
import type { Listing, ListingCategory } from '../../lib/api/types';
import { errorMessage } from '../../lib/auth/messages';
import { CATEGORY_OPTIONS, categoryLabel, conditionLabel } from '../../lib/listings/options';
import { useListingFeed } from '../../lib/listings/useListingFeed';
import { groupByPoint, spotLabel, type MapSpot } from '../../lib/listings/mapSpots';
import { formatDistance, nextRadius, regionFor } from '../../lib/location/geo';
import { cityNamed } from '../../lib/location/places';
import { Colors, Radii, Shadows, Spacing, Typography } from '../../utils/theme';

const GREEN = Colors.green || '#2e7d32';
const DARK = Colors.greenDark || '#1b5e20';
// One page of the nearest items; the list view pages further.
const MAP_PAGE_SIZE = 50;

const FILTERS: { id: 'all' | ListingCategory; label: string; icon: string }[] = [
  { id: 'all', label: 'All', icon: '🏠' },
  ...CATEGORY_OPTIONS.map((c) => ({ id: c.value, label: c.label, icon: c.icon })),
];

const categoryIcon = (c: ListingCategory) => CATEGORY_OPTIONS.find((o) => o.value === c)?.icon ?? '📦';

// A labelled pin: category icon and a short name (or "3 items" where several
// listings share a point). The selected one is larger and dark.
function SpotMarker({ spot, selected, onPress }: { spot: MapSpot; selected: boolean; onPress: () => void }) {
  const first = spot.items[0]!;
  const available = spot.items.some((i) => i.availability === 'available');
  const label =
    spot.items.length > 1
      ? `${spot.items.length} items: ${spot.items.map((i) => i.title).join(', ')}`
      : `${first.title}${first.distanceKm !== null ? `, ${formatDistance(first.distanceKm)}` : ''}`;
  return (
    <Marker
      // Re-keyed on selection: with tracksViewChanges off, Android only
      // redraws a custom marker when it is mounted again.
      key={`${spot.key}:${selected ? 'on' : 'off'}`}
      coordinate={spot.point}
      anchor={{ x: 0.5, y: 1 }}
      zIndex={selected ? 10 : 1}
      tracksViewChanges={false}
      onPress={(e) => {
        e?.stopPropagation?.();
        onPress();
      }}
      accessibilityLabel={label}
    >
      <View style={styles.pinWrap}>
        <View style={[styles.pin, !available && styles.pinMuted, selected && styles.pinSelected]}>
          <Text style={styles.pinIcon}>{spot.items.length > 1 ? '📍' : categoryIcon(first.category)}</Text>
          <Text style={[styles.pinLabel, selected && styles.pinLabelSelected]} numberOfLines={1}>
            {spotLabel(spot)}
          </Text>
        </View>
        <View style={[styles.pinTail, !available && styles.pinTailMuted, selected && styles.pinTailSelected]} />
      </View>
    </Marker>
  );
}

// Always shown while there are items: the selected one (the nearest until
// the user picks another). Tapping it opens the listing; items sharing a
// point can be stepped through.
function Preview({
  item,
  position,
  onOpen,
  onStep,
}: {
  item: Listing;
  position: { index: number; count: number } | null;
  onOpen: () => void;
  onStep: (by: 1 | -1) => void;
}) {
  const cover = item.images[0]?.url;
  const place = [item.area, item.city].filter(Boolean).join(', ');
  return (
    <View style={styles.preview} accessibilityLabel={`Preview of ${item.title}`}>
      <TouchableOpacity
        style={styles.previewMain}
        onPress={onOpen}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={`View ${item.title}`}
        accessibilityHint="Opens the listing"
      >
        {cover ? (
          <Image source={{ uri: cover }} style={styles.previewImage} />
        ) : (
          <View style={[styles.previewImage, styles.previewPlaceholder]}>
            <Text style={{ fontSize: 26 }}>{categoryIcon(item.category)}</Text>
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Text style={styles.previewTitle} numberOfLines={2}>{item.title}</Text>
          <Text style={styles.previewMeta} numberOfLines={1}>
            {categoryLabel(item.category)} · {conditionLabel(item.condition)}
            {item.availability === 'unavailable' ? ' · Unavailable' : ''}
          </Text>
          {place ? <Text style={styles.previewMeta} numberOfLines={1}>{place}</Text> : null}
          <View style={styles.previewFoot}>
            {item.distanceKm !== null ? <Text style={styles.previewDistance}>{formatDistance(item.distanceKm)}</Text> : <View />}
            <Text style={styles.previewOpen}>View item ›</Text>
          </View>
        </View>
      </TouchableOpacity>
      {position ? (
        <View style={styles.stepRow}>
          <TouchableOpacity onPress={() => onStep(-1)} accessibilityRole="button" accessibilityLabel="Previous item here" hitSlop={8}>
            <Ionicons name="chevron-back" size={18} color={DARK} />
          </TouchableOpacity>
          <Text style={styles.stepText}>
            {position.index + 1} of {position.count} at this spot
          </Text>
          <TouchableOpacity onPress={() => onStep(1)} accessibilityRole="button" accessibilityLabel="Next item here" hitSlop={8}>
            <Ionicons name="chevron-forward" size={18} color={DARK} />
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

// Items on a map, at their approximate public points (never the precise
// pickup spot). Uses the same area and radius as the list.
export default function MapScreen() {
  const router = useRouter();
  const { activeCategory, setActiveCategory } = useApp();
  const category = activeCategory === 'all' ? null : (activeCategory as ListingCategory);
  const discovery = useDiscovery();
  const [picking, setPicking] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const mapRef = useRef<MapView>(null);

  const { area, origin, radiusKm, scope } = discovery;
  const nearby = area.kind === 'device' || area.kind === 'place';
  // The map needs somewhere to look: nothing is loaded for "all areas".
  const feed = useListingFeed({
    query: '',
    category,
    scope,
    enabled: discovery.ready && scope !== null,
    pageSize: MAP_PAGE_SIZE,
  });

  const city = area.kind === 'city' ? cityNamed(area.city) : undefined;
  const spots = useMemo(() => groupByPoint(feed.items), [feed.items]);
  const located = useMemo(() => spots.flatMap((s) => s.items), [spots]);
  const unlocated = feed.items.length - located.length;
  const firstLocated = located[0]?.approximateLocation;
  const center = origin ?? city ?? firstLocated ?? null;
  const region = center ? regionFor(center, nearby ? radiusKm : 6) : null;
  // The nearest item until the user picks one, so a preview is always shown.
  const selected = located.find((i) => i.id === selectedId) ?? located[0] ?? null;
  const selectedSpot = selected ? (spots.find((s) => s.items.includes(selected)) ?? null) : null;
  const wider = nearby ? nextRadius(radiusKm) : null;

  // A second tap on a selected group moves to its next item.
  const pressSpot = (spot: MapSpot) => {
    if (selectedSpot === spot && spot.items.length > 1) step(1);
    else setSelectedId(spot.items[0]!.id);
  };
  const step = (by: 1 | -1) => {
    if (!selectedSpot || !selected) return;
    const n = selectedSpot.items.length;
    const i = selectedSpot.items.indexOf(selected);
    setSelectedId(selectedSpot.items[(i + by + n) % n]!.id);
  };

  // Follow a new area or radius.
  const regionKey = region ? `${region.latitude.toFixed(4)},${region.longitude.toFixed(4)},${region.latitudeDelta.toFixed(4)}` : '';
  useEffect(() => {
    if (region) mapRef.current?.animateToRegion(region, 400);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionKey]);

  const recenter = () => {
    const target = area.kind === 'device' ? (discovery.devicePoint ?? origin) : center;
    if (target) mapRef.current?.animateToRegion(regionFor(target, nearby ? radiusKm : 6), 400);
  };

  const header = (
    <SafeAreaView edges={['top']} style={styles.headerWrap}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>Map</Text>
          <TouchableOpacity style={styles.toggle} onPress={() => router.navigate('/')} accessibilityRole="button" accessibilityLabel="Show as list">
            <Ionicons name="list" size={15} color={GREEN} />
            <Text style={styles.toggleText}>List</Text>
          </TouchableOpacity>
        </View>
        <AreaBar onChange={() => setPicking(true)} />
        <RadiusChips />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.catContent} style={styles.catScroll}>
          {FILTERS.map((f) => (
            <TouchableOpacity
              key={f.id}
              style={[styles.catChip, activeCategory === f.id && styles.catChipActive]}
              onPress={() => setActiveCategory(f.id)}
              accessibilityRole="button"
              accessibilityLabel={f.label}
              accessibilityState={{ selected: activeCategory === f.id }}
            >
              <Text style={styles.catIcon}>{f.icon}</Text>
              <Text style={[styles.catLabel, activeCategory === f.id && styles.catLabelActive]}>{f.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    </SafeAreaView>
  );

  // No area yet (location off or not chosen): explain instead of an empty map.
  if (!region) {
    return (
      <View style={styles.container}>
        {header}
        <View style={styles.fallback}>
          {discovery.ready && area.kind === 'all' ? (
            <>
              <LocationCard onChooseArea={() => setPicking(true)} />
              <Text style={styles.fallbackTitle}>Choose an area to see items on the map</Text>
              <Text style={styles.fallbackText}>
                The map shows items near you or near an area you pick. Items appear at an approximate spot, never the owner’s address.
              </Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={() => setPicking(true)} accessibilityRole="button" accessibilityLabel="Choose an area">
                <Text style={styles.primaryText}>Choose an area</Text>
              </TouchableOpacity>
            </>
          ) : feed.status === 'ready' && area.kind === 'city' ? (
            <Text style={styles.fallbackText}>No items in {area.city} have a map spot yet. They are in the list view.</Text>
          ) : (
            <ActivityIndicator size="large" color={GREEN} accessibilityLabel="Loading map" />
          )}
        </View>
        <AreaPicker visible={picking} onClose={() => setPicking(false)} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {header}
      <View style={styles.mapWrap}>
        <MapView
          ref={mapRef}
          testID="items-map"
          style={StyleSheet.absoluteFill}
          initialRegion={region}
          showsUserLocation={discovery.locationStatus === 'ready'}
          showsMyLocationButton={false}
          toolbarEnabled={false}
        >
          {nearby && origin ? (
            <Circle
              center={origin}
              radius={radiusKm * 1000}
              strokeColor={GREEN}
              strokeWidth={1.5}
              fillColor="rgba(46,125,50,0.08)"
            />
          ) : null}
          {area.kind === 'place' ? (
            <Marker coordinate={area.place} title={area.place.name} description="Search centre" pinColor="#1d4ed8" />
          ) : null}
          {spots.map((spot) => (
            <SpotMarker key={spot.key} spot={spot} selected={spot === selectedSpot} onPress={() => pressSpot(spot)} />
          ))}
        </MapView>

        <TouchableOpacity style={styles.recenter} onPress={recenter} accessibilityRole="button" accessibilityLabel="Recenter map">
          <Ionicons name="locate" size={20} color={DARK} />
        </TouchableOpacity>

        {feed.status === 'loading' ? (
          <View style={styles.overlay} accessibilityLabel="Loading items">
            <ActivityIndicator color={GREEN} />
            <Text style={styles.overlayText}>Loading items…</Text>
          </View>
        ) : feed.status === 'error' ? (
          <View style={styles.overlay}>
            <Text style={styles.overlayText}>Could not load items. {errorMessage(feed.error)}</Text>
            <TouchableOpacity onPress={feed.retry} accessibilityRole="button" accessibilityLabel="Try again">
              <Text style={styles.overlayAction}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : feed.items.length === 0 ? (
          <View style={styles.overlay}>
            <Text style={styles.overlayText}>
              {nearby ? `No items within ${radiusKm} km.` : 'No items here yet.'}
            </Text>
            {wider ? (
              <TouchableOpacity onPress={() => discovery.setRadius(wider)} accessibilityRole="button" accessibilityLabel={`Expand to ${wider} km`}>
                <Text style={styles.overlayAction}>Expand to {wider} km</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : unlocated > 0 || feed.hasMore ? (
          <View style={[styles.overlay, styles.overlaySubtle]}>
            <Text style={styles.overlayText}>
              {feed.hasMore ? `Showing the ${MAP_PAGE_SIZE} nearest of ${feed.total}. ` : ''}
              {unlocated > 0 ? `${unlocated} without a map spot; see the list.` : ''}
            </Text>
          </View>
        ) : null}

        {selected && feed.status === 'ready' ? (
          <Preview
            item={selected}
            position={selectedSpot && selectedSpot.items.length > 1 ? { index: selectedSpot.items.indexOf(selected), count: selectedSpot.items.length } : null}
            onOpen={() => router.push(`/item/${selected.id}`)}
            onStep={step}
          />
        ) : null}
      </View>
      <AreaPicker visible={picking} onClose={() => setPicking(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.offWhite },
  headerWrap: { backgroundColor: Colors.white, borderBottomWidth: 1, borderColor: Colors.fog, ...Shadows.sm },
  header: { paddingHorizontal: Spacing.xl, paddingBottom: Spacing.sm },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: Spacing.sm, marginBottom: Spacing.xs },
  title: { fontSize: Typography.sizes.xl, fontWeight: Typography.weights.extrabold, color: DARK },
  toggle: {
    flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: Colors.fog, borderRadius: Radii.full,
    paddingHorizontal: Spacing.sm, paddingVertical: 4,
  },
  toggleText: { fontSize: Typography.sizes.xs, fontWeight: Typography.weights.bold, color: DARK },
  catScroll: { marginHorizontal: -Spacing.xl },
  catContent: { paddingHorizontal: Spacing.xl, gap: Spacing.sm },
  catChip: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, backgroundColor: Colors.offWhite, borderRadius: Radii.full,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2, borderWidth: 1, borderColor: Colors.fog,
  },
  catChipActive: { backgroundColor: GREEN + '15', borderColor: GREEN },
  catIcon: { fontSize: 14 },
  catLabel: { fontSize: Typography.sizes.sm, color: Colors.slate, fontWeight: Typography.weights.medium },
  catLabelActive: { color: DARK, fontWeight: Typography.weights.semibold },
  mapWrap: { flex: 1, marginBottom: 84 },
  recenter: {
    position: 'absolute', right: Spacing.lg, top: Spacing.lg, width: 44, height: 44, borderRadius: 22,
    backgroundColor: Colors.white, alignItems: 'center', justifyContent: 'center', ...Shadows.md,
  },
  overlay: {
    position: 'absolute', left: Spacing.lg, right: 76, top: Spacing.lg, backgroundColor: Colors.white, borderRadius: Radii.md,
    padding: Spacing.md, gap: 4, ...Shadows.sm,
  },
  overlaySubtle: { backgroundColor: 'rgba(255,255,255,0.92)' },
  overlayText: { fontSize: Typography.sizes.sm, color: Colors.navyMid },
  overlayAction: { fontSize: Typography.sizes.sm, fontWeight: Typography.weights.bold, color: GREEN },
  pinWrap: { alignItems: 'center' },
  pin: {
    flexDirection: 'row', alignItems: 'center', gap: 3, maxWidth: 130, backgroundColor: Colors.white, borderRadius: Radii.full,
    borderWidth: 1.5, borderColor: GREEN, paddingHorizontal: 7, paddingVertical: 3,
  },
  pinMuted: { borderColor: '#94a3b8' },
  pinSelected: { backgroundColor: DARK, borderColor: DARK, paddingHorizontal: 9, paddingVertical: 5 },
  pinIcon: { fontSize: 12 },
  pinLabel: { flexShrink: 1, fontSize: 11, fontWeight: Typography.weights.bold, color: DARK },
  pinLabelSelected: { color: Colors.white, fontSize: 12 },
  pinTail: {
    width: 0, height: 0, borderLeftWidth: 5, borderRightWidth: 5, borderTopWidth: 6,
    borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: GREEN,
  },
  pinTailMuted: { borderTopColor: '#94a3b8' },
  pinTailSelected: { borderTopColor: DARK },
  preview: {
    position: 'absolute', left: Spacing.lg, right: Spacing.lg, bottom: Spacing.lg,
    backgroundColor: Colors.white, borderRadius: Radii.lg, padding: Spacing.md, ...Shadows.md,
  },
  previewMain: { flexDirection: 'row', gap: Spacing.md },
  previewImage: { width: 76, height: 76, borderRadius: Radii.md },
  previewPlaceholder: { backgroundColor: Colors.fog, alignItems: 'center', justifyContent: 'center' },
  previewTitle: { fontSize: Typography.sizes.base, fontWeight: Typography.weights.bold, color: DARK },
  previewMeta: { fontSize: Typography.sizes.xs, color: Colors.slate, marginTop: 2 },
  previewFoot: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: Spacing.xs },
  previewDistance: { fontSize: Typography.sizes.xs, color: GREEN, fontWeight: Typography.weights.semibold },
  previewOpen: { fontSize: Typography.sizes.xs, color: GREEN, fontWeight: Typography.weights.bold },
  stepRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.md,
    marginTop: Spacing.sm, paddingTop: Spacing.sm, borderTopWidth: 1, borderColor: Colors.fog,
  },
  stepText: { fontSize: Typography.sizes.xs, color: Colors.navyMid, fontWeight: Typography.weights.semibold },
  fallback: { flex: 1, padding: Spacing.xl, alignItems: 'stretch', justifyContent: 'flex-start', paddingTop: Spacing.xl },
  fallbackTitle: { fontSize: Typography.sizes.lg, fontWeight: Typography.weights.bold, color: DARK, textAlign: 'center', marginTop: Spacing.md },
  fallbackText: { fontSize: Typography.sizes.sm, color: Colors.slate, textAlign: 'center', marginTop: Spacing.sm },
  primaryBtn: { alignSelf: 'center', marginTop: Spacing.lg, backgroundColor: GREEN, borderRadius: Radii.full, paddingHorizontal: Spacing.xl, paddingVertical: Spacing.sm + 2 },
  primaryText: { color: Colors.white, fontWeight: Typography.weights.bold, fontSize: Typography.sizes.sm },
});
