import { useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useDiscovery } from '../../context/DiscoveryContext';
import { RADIUS_OPTIONS_KM } from '../../lib/location/geo';
import { CITIES } from '../../lib/location/places';
import { Colors, Radii, Spacing, Typography } from '../../utils/theme';

const GREEN = Colors.green || '#2e7d32';
const DARK = Colors.greenDark || '#1b5e20';

// "Near you · 3 km" with a button to change the area.
export function AreaBar({ onChange }: { onChange: () => void }) {
  const { label, area, radiusKm, locationStatus } = useDiscovery();
  const nearby = area.kind === 'device' || area.kind === 'place';
  const finding = locationStatus === 'locating' || locationStatus === 'requesting' || locationStatus === 'checking';
  return (
    <TouchableOpacity
      style={styles.areaBar}
      onPress={onChange}
      accessibilityRole="button"
      accessibilityLabel={`Area: ${label}${nearby ? `, within ${radiusKm} km` : ''}. Change area`}
    >
      <Ionicons name={area.kind === 'device' ? 'navigate' : 'location'} size={15} color={GREEN} />
      <Text style={styles.areaText} numberOfLines={1}>
        {finding && area.kind === 'all' ? 'Finding your location…' : label}
        {nearby ? <Text style={styles.areaRadius}> · within {radiusKm} km</Text> : null}
      </Text>
      <Text style={styles.areaChange}>Change</Text>
    </TouchableOpacity>
  );
}

export function RadiusChips() {
  const { area, radiusKm, setRadius } = useDiscovery();
  if (area.kind !== 'device' && area.kind !== 'place') return null;
  return (
    <View style={styles.radiusRow} accessibilityRole="radiogroup" accessibilityLabel="Search radius">
      {RADIUS_OPTIONS_KM.map((km) => (
        <TouchableOpacity
          key={km}
          style={[styles.radiusChip, radiusKm === km && styles.radiusChipActive]}
          onPress={() => setRadius(km)}
          accessibilityRole="radio"
          accessibilityLabel={`Within ${km} km`}
          accessibilityState={{ selected: radiusKm === km }}
        >
          <Text style={[styles.radiusText, radiusKm === km && styles.radiusTextActive]}>{km} km</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// Explains location before asking, and what to do when it is not available.
// Shown only while no area has been chosen, so it never nags.
export function LocationCard({ onChooseArea }: { onChooseArea: () => void }) {
  const { area, locationStatus, enableLocation, openSettings, canEnableServicesInApp } = useDiscovery();
  if (area.kind !== 'all') return null;

  const content: Record<string, { title: string; text: string; primary?: { label: string; run: () => void } } | null> = {
    prompt: {
      title: 'See what is near you',
      text: 'Allow location to see items within walking distance first. It is used only while the app is open, to search; it is never shown to anyone or saved.',
      primary: { label: 'Use my location', run: () => void enableLocation() },
    },
    denied: {
      title: 'Location was not allowed',
      text: 'Tap “Use my location” and choose “While using the app” to see nearby items, or choose your area instead.',
      primary: { label: 'Use my location', run: () => void enableLocation() },
    },
    blocked: {
      title: 'Location is turned off for NeighborShare',
      text: 'Your phone will not ask again. Open Settings, tap Location (or Permissions → Location) and choose “While using the app”. Or choose your area instead.',
      primary: { label: 'Open Settings', run: openSettings },
    },
    services_off: canEnableServicesInApp
      ? {
          title: 'Your phone’s location is off',
          text: 'Turn on location (GPS) to see nearby items. Your phone will ask you to confirm.',
          primary: { label: 'Turn on location', run: () => void enableLocation() },
        }
      : {
          title: 'Location Services are off',
          text: 'Turn on Location Services in Settings → Privacy & Security, then come back. Or choose your area instead.',
          primary: { label: 'Open Settings', run: openSettings },
        },
    unavailable: {
      title: 'Could not get your location',
      text: 'Try again, or choose your area instead.',
      primary: { label: 'Try again', run: () => void enableLocation() },
    },
    timeout: {
      title: 'Finding your location took too long',
      text: 'Try again, perhaps nearer a window, or choose your area instead.',
      primary: { label: 'Try again', run: () => void enableLocation() },
    },
    requesting: null,
    locating: null,
    checking: null,
    ready: null,
  };

  if (locationStatus === 'locating' || locationStatus === 'requesting') {
    return (
      <View style={styles.card} accessibilityLabel="Finding your location">
        <ActivityIndicator size="small" color={GREEN} />
        <Text style={styles.cardText}>Finding your location…</Text>
      </View>
    );
  }
  const c = content[locationStatus];
  if (!c) return null;
  return (
    <View style={styles.card} accessibilityRole="summary">
      <View style={{ flex: 1 }}>
        <Text style={styles.cardTitle}>{c.title}</Text>
        <Text style={styles.cardText}>{c.text}</Text>
        <View style={styles.cardActions}>
          {c.primary ? (
            <TouchableOpacity style={styles.primaryBtn} onPress={c.primary.run} accessibilityRole="button" accessibilityLabel={c.primary.label}>
              <Text style={styles.primaryText}>{c.primary.label}</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={styles.secondaryBtn} onPress={onChooseArea} accessibilityRole="button" accessibilityLabel="Choose area">
            <Text style={styles.secondaryText}>Choose area</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// Choose where to discover: the device location, a neighbourhood, a whole
// city, or everywhere.
export function AreaPicker({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { area, enableLocation, choosePlace, chooseCity, showAll, locationStatus, openSettings, canEnableServicesInApp } = useDiscovery();
  // Only Settings can help: permanently denied, or services off on iOS.
  const settingsOnly = locationStatus === 'blocked' || (locationStatus === 'services_off' && !canEnableServicesInApp);
  const locationLabel =
    locationStatus === 'blocked'
      ? 'Turn on location in Settings'
      : settingsOnly
        ? 'Turn on Location Services in Settings'
        : locationStatus === 'services_off'
          ? 'Turn on location and use it'
          : 'Use my current location';
  const [open, setOpen] = useState<string | null>(area.kind === 'place' ? area.place.city : area.kind === 'city' ? area.city : null);
  const done = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>Choose your area</Text>
            <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
              <Ionicons name="close" size={22} color={Colors.slate} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ paddingBottom: Spacing.lg }}>
            <TouchableOpacity
              style={styles.option}
              onPress={settingsOnly ? openSettings : done(() => void enableLocation())}
              accessibilityRole="button"
              accessibilityLabel={locationLabel}
            >
              <Ionicons name="navigate" size={18} color={GREEN} />
              <View style={{ flex: 1 }}>
                <Text style={styles.optionText}>{locationLabel}</Text>
                <Text style={styles.optionSub}>Only used to search while the app is open</Text>
              </View>
              {area.kind === 'device' ? <Ionicons name="checkmark" size={18} color={GREEN} /> : null}
            </TouchableOpacity>

            {CITIES.map((city) => (
              <View key={city.name}>
                <TouchableOpacity
                  style={styles.option}
                  onPress={() => setOpen(open === city.name ? null : city.name)}
                  accessibilityRole="button"
                  accessibilityLabel={city.name}
                  accessibilityState={{ expanded: open === city.name }}
                >
                  <Ionicons name="business-outline" size={18} color={Colors.slate} />
                  <Text style={[styles.optionText, { flex: 1 }]}>{city.name}</Text>
                  <Ionicons name={open === city.name ? 'chevron-up' : 'chevron-down'} size={16} color={Colors.slate} />
                </TouchableOpacity>
                {open === city.name ? (
                  <View style={styles.subList}>
                    {city.places.map((p) => (
                      <TouchableOpacity
                        key={p.id}
                        style={styles.subOption}
                        onPress={done(() => choosePlace(p))}
                        accessibilityRole="button"
                        accessibilityLabel={`Near ${p.name}, ${city.name}`}
                      >
                        <Text style={styles.subText}>Near {p.name}</Text>
                        {area.kind === 'place' && area.place.id === p.id ? <Ionicons name="checkmark" size={16} color={GREEN} /> : null}
                      </TouchableOpacity>
                    ))}
                    <TouchableOpacity
                      style={styles.subOption}
                      onPress={done(() => chooseCity(city.name))}
                      accessibilityRole="button"
                      accessibilityLabel={`All of ${city.name}`}
                    >
                      <Text style={[styles.subText, { fontWeight: Typography.weights.semibold }]}>All of {city.name} (not sorted by distance)</Text>
                      {area.kind === 'city' && area.city === city.name ? <Ionicons name="checkmark" size={16} color={GREEN} /> : null}
                    </TouchableOpacity>
                  </View>
                ) : null}
              </View>
            ))}

            <TouchableOpacity style={styles.option} onPress={done(showAll)} accessibilityRole="button" accessibilityLabel="All areas">
              <Ionicons name="globe-outline" size={18} color={Colors.slate} />
              <View style={{ flex: 1 }}>
                <Text style={styles.optionText}>All areas</Text>
                <Text style={styles.optionSub}>Newest items everywhere, including far away</Text>
              </View>
              {area.kind === 'all' ? <Ionicons name="checkmark" size={18} color={GREEN} /> : null}
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  areaBar: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: Spacing.xs, marginBottom: Spacing.sm,
  },
  areaText: { flex: 1, fontSize: Typography.sizes.sm, fontWeight: Typography.weights.bold, color: DARK },
  areaRadius: { fontWeight: Typography.weights.medium, color: Colors.slate },
  areaChange: { fontSize: Typography.sizes.sm, fontWeight: Typography.weights.bold, color: GREEN },
  radiusRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.md },
  radiusChip: {
    paddingHorizontal: Spacing.md, paddingVertical: 4, borderRadius: Radii.full, borderWidth: 1, borderColor: Colors.fog, backgroundColor: Colors.offWhite,
  },
  radiusChipActive: { borderColor: GREEN, backgroundColor: GREEN + '15' },
  radiusText: { fontSize: Typography.sizes.xs, color: Colors.slate, fontWeight: Typography.weights.semibold },
  radiusTextActive: { color: DARK },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, backgroundColor: '#f1f8e9', borderWidth: 1, borderColor: '#c5e1a5',
    borderRadius: Radii.md, padding: Spacing.md, marginBottom: Spacing.md,
  },
  cardTitle: { fontSize: Typography.sizes.base, fontWeight: Typography.weights.bold, color: DARK },
  cardText: { fontSize: Typography.sizes.sm, color: Colors.navyMid, marginTop: 2 },
  cardActions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.sm },
  primaryBtn: { backgroundColor: GREEN, borderRadius: Radii.full, paddingHorizontal: Spacing.md, paddingVertical: 6 },
  primaryText: { color: Colors.white, fontWeight: Typography.weights.bold, fontSize: Typography.sizes.sm },
  secondaryBtn: { borderWidth: 1, borderColor: GREEN, borderRadius: Radii.full, paddingHorizontal: Spacing.md, paddingVertical: 6 },
  secondaryText: { color: DARK, fontWeight: Typography.weights.bold, fontSize: Typography.sizes.sm },
  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: Colors.white, borderTopLeftRadius: Radii.xl, borderTopRightRadius: Radii.xl, maxHeight: '85%', paddingHorizontal: Spacing.xl, paddingTop: Spacing.lg },
  sheetHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.md },
  sheetTitle: { fontSize: Typography.sizes.lg, fontWeight: Typography.weights.bold, color: Colors.navy },
  option: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.md, borderBottomWidth: 1, borderColor: Colors.fog },
  optionText: { fontSize: Typography.sizes.base, color: Colors.navy, fontWeight: Typography.weights.semibold },
  optionSub: { fontSize: Typography.sizes.xs, color: Colors.slate, marginTop: 1 },
  subList: { paddingLeft: Spacing.xl + Spacing.sm, borderBottomWidth: 1, borderColor: Colors.fog },
  subOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: Spacing.sm + 2 },
  subText: { fontSize: Typography.sizes.sm, color: Colors.navyMid },
});
