import { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Image,
  Dimensions, ScrollView, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useApp } from '../../context/AppContext';
import { Colors, Typography, Spacing, Radii, Shadows } from '../../utils/theme';

const { width, height } = Dimensions.get('window');
const MAP_HEIGHT = height * 0.55;

// Simulated map pins with relative positions
const PIN_POSITIONS = [
  { id: 'i1', x: 0.35, y: 0.38 },
  { id: 'i2', x: 0.62, y: 0.45 },
  { id: 'i3', x: 0.25, y: 0.58 },
  { id: 'i4', x: 0.65, y: 0.42 },
  { id: 'i5', x: 0.15, y: 0.65 },
  { id: 'i6', x: 0.42, y: 0.30 },
  { id: 'i7', x: 0.28, y: 0.55 },
  { id: 'i8', x: 0.22, y: 0.62 },
];

export default function MapScreen() {
  const router = useRouter();
  const { items } = useApp();
  const [selected, setSelected] = useState<string | null>(null);

  const selectedItem = items.find(i => i.id === selected);

  return (
    <View style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.headerWrap}>
        <View style={styles.header}>
          <Text style={styles.title}>Nearby Items</Text>
          <Text style={styles.subtitle}>Tap a pin to see item details</Text>
        </View>
      </SafeAreaView>

      {/* Simulated Map */}
      <View style={styles.mapContainer}>
        {/* Light Green Map Background Grid */}
        <LinearGradient
          colors={['#edf4ee', '#f5f9f6', '#ffffff']}
          style={styles.mapBg}
        >
          {/* Street grid lines */}
          {[0.2, 0.4, 0.6, 0.8].map(y => (
            <View key={`h${y}`} style={[styles.streetH, { top: `${y * 100}%` as any }]} />
          ))}
          {[0.25, 0.5, 0.75].map(x => (
            <View key={`v${x}`} style={[styles.streetV, { left: `${x * 100}%` as any }]} />
          ))}

          {/* Block fills */}
          {[
            { top: 0, left: 0, w: '24%', h: '19%' },
            { top: 0, left: '26%', w: '23%', h: '19%' },
            { top: 0, left: '51%', w: '48%', h: '19%' },
            { top: '21%', left: 0, w: '24%', h: '18%' },
            { top: '21%', left: '26%', w: '23%', h: '18%' },
            { top: '21%', left: '51%', w: '48%', h: '18%' },
            { top: '41%', left: 0, w: '24%', h: '18%' },
            { top: '41%', left: '26%', w: '23%', h: '18%' },
            { top: '41%', left: '51%', w: '48%', h: '18%' },
            { top: '61%', left: 0, w: '24%', h: '38%' },
            { top: '61%', left: '26%', w: '23%', h: '38%' },
            { top: '61%', left: '51%', w: '48%', h: '38%' },
          ].map((b, i) => (
            <View key={i} style={[styles.block, { top: b.top as any, left: b.left as any, width: b.w as any, height: b.h as any }]} />
          ))}

          {/* You are here (Green Pin Locator) */}
          <View style={styles.youPin}>
            <View style={styles.youPinInner}>
              <View style={styles.youPulse} />
              <View style={styles.youDot} />
            </View>
          </View>

          {/* Item pins */}
          {PIN_POSITIONS.map(pos => {
            const item = items.find(i => i.id === pos.id);
            if (!item) return null;
            const isSelected = selected === pos.id;
            return (
              <TouchableOpacity
                key={pos.id}
                style={[
                  styles.pin,
                  {
                    left: `${pos.x * 100}%` as any,
                    top: `${pos.y * 100}%` as any,
                  },
                  isSelected && styles.pinSelected,
                ]}
                onPress={() => setSelected(isSelected ? null : pos.id)}
                activeOpacity={0.85}
              >
                <View style={[
                  styles.pinBubble, 
                  isSelected && styles.pinBubbleSelected, 
                  !item.available && styles.pinUnavailable
                ]}>
                  <Text style={styles.pinEmoji}>
                    {item.category === 'Tools' ? '🔧'
                      : item.category === 'Electronics' ? '📷'
                      : item.category === 'Outdoor' ? '⛺'
                      : item.category === 'Kitchen' ? '🍳'
                      : '🛋️'}
                  </Text>
                </View>
                <View style={[styles.pinTail, isSelected && styles.pinTailSelected]} />
              </TouchableOpacity>
            );
          })}
        </LinearGradient>

        {/* Radius indicator chip */}
        <View style={styles.radiusChip}>
          <Ionicons name="radio-button-on" size={12} color={Colors.green || '#2e7d32'} />
          <Text style={styles.radiusText}>2 km radius</Text>
        </View>
      </View>

      {/* Bottom context interaction module */}
      <View style={styles.bottomPanel}>
        {selectedItem ? (
          <TouchableOpacity
            style={styles.selectedCard}
            onPress={() => router.push(`/item/${selectedItem.id}`)}
            activeOpacity={0.88}
          >
            <Image source={{ uri: selectedItem.image }} style={styles.selectedImg} />
            <View style={styles.selectedInfo}>
              <Text style={styles.selectedTitle} numberOfLines={1}>{selectedItem.title}</Text>
              <Text style={styles.selectedOwner}>{selectedItem.ownerName} · {selectedItem.distance}</Text>
              <View style={styles.selectedMeta}>
                <View style={[styles.availDot, { backgroundColor: selectedItem.available ? (Colors.green || '#2e7d32') : Colors.slate }]} />
                <Text style={styles.availText}>{selectedItem.available ? 'Available' : 'In Use'}</Text>
                {selectedItem.teachMeEnabled && (
                  <View style={styles.teachChip}>
                    <Text style={styles.teachChipText}>🎓 Teach Me</Text>
                  </View>
                )}
              </View>
            </View>
            <Ionicons name="chevron-forward" size={20} color={Colors.slate} />
          </TouchableOpacity>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.nearbyList}>
            <Text style={styles.nearbyLabel}>Nearby items</Text>
            {items.filter(i => i.available).slice(0, 5).map(item => (
              <TouchableOpacity
                key={item.id}
                style={styles.nearbyChip}
                onPress={() => setSelected(item.id)}
                activeOpacity={0.8}
              >
                <Text style={styles.nearbyChipEmoji}>
                  {item.category === 'Tools' ? '🔧' : item.category === 'Electronics' ? '📷' : '🏠'}
                </Text>
                <Text style={styles.nearbyChipText} numberOfLines={1}>{item.title}</Text>
                <Text style={styles.nearbyChipDist}>{item.distance}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.offWhite },
  headerWrap: { backgroundColor: Colors.white },
  header: { 
    paddingHorizontal: Spacing.xl, 
    paddingTop: Spacing.sm, 
    paddingBottom: Spacing.lg,
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderColor: Colors.fog 
  },
  title: { fontSize: Typography.sizes.xl, fontWeight: Typography.weights.extrabold, color: Colors.greenDark || '#1b5e20' },
  subtitle: { fontSize: Typography.sizes.sm, color: Colors.slate, marginTop: 2 },
  mapContainer: { height: MAP_HEIGHT, position: 'relative' },
  mapBg: { flex: 1 },
  streetH: { position: 'absolute', left: 0, right: 0, height: 6, backgroundColor: Colors.white, opacity: 0.8 },
  streetV: { position: 'absolute', top: 0, bottom: 0, width: 6, backgroundColor: Colors.white, opacity: 0.8 },
  block: { position: 'absolute', backgroundColor: 'rgba(220,235,223,0.7)', borderRadius: 4 },
  youPin: { position: 'absolute', left: '50%', top: '50%', marginLeft: -16, marginTop: -16 },
  youPinInner: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  youPulse: {
    position: 'absolute', width: 32, height: 32, borderRadius: 16,
    backgroundColor: Colors.green || '#2e7d32', opacity: 0.2,
  },
  youDot: { width: 14, height: 14, borderRadius: 7, backgroundColor: Colors.green || '#2e7d32', borderWidth: 2, borderColor: Colors.white, ...Shadows.sm },
  pin: { position: 'absolute', alignItems: 'center', marginLeft: -18, marginTop: -46 },
  pinSelected: { zIndex: 10 },
  pinBubble: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: Colors.white, alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: Colors.green || '#2e7d32',
    ...Shadows.md,
  },
  pinBubbleSelected: { 
    width: 44, height: 44, borderRadius: 22, 
    backgroundColor: Colors.green || '#2e7d32', 
    borderColor: Colors.white 
  },
  pinUnavailable: { borderColor: Colors.slate, opacity: 0.6 },
  pinEmoji: { fontSize: 16 },
  pinTail: { 
    width: 0, height: 0, 
    borderLeftWidth: 5, borderRightWidth: 5, borderTopWidth: 8, 
    borderLeftColor: 'transparent', borderRightColor: 'transparent', 
    borderTopColor: Colors.green || '#2e7d32' 
  },
  pinTailSelected: { borderTopColor: Colors.green || '#2e7d32' },
  radiusChip: {
    position: 'absolute', bottom: 12, right: 12,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.9)', borderRadius: Radii.full,
    paddingHorizontal: Spacing.sm, paddingVertical: 4,
    borderWidth: 1, borderColor: Colors.fog,
    ...Shadows.sm,
  },
  radiusText: { fontSize: Typography.sizes.xs, color: Colors.greenDark || '#1b5e20', fontWeight: Typography.weights.semibold },
  bottomPanel: { 
    flex: 1, 
    backgroundColor: Colors.white, 
    borderTopLeftRadius: Radii.xl, 
    borderTopRightRadius: Radii.xl, 
    marginTop: -20, 
    padding: Spacing.xl, 
    borderWidth: 1,
    borderColor: Colors.fog,
    ...Shadows.lg 
  },
  selectedCard: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  selectedImg: { width: 64, height: 64, borderRadius: Radii.md },
  selectedInfo: { flex: 1 },
  selectedTitle: { fontSize: Typography.sizes.md, fontWeight: Typography.weights.bold, color: Colors.greenDark || '#1b5e20' },
  selectedOwner: { fontSize: Typography.sizes.sm, color: Colors.slate, marginTop: 2 },
  selectedMeta: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: 6 },
  availDot: { width: 8, height: 8, borderRadius: 4 },
  availText: { fontSize: Typography.sizes.xs, color: Colors.slate },
  teachChip: { backgroundColor: (Colors.green || '#2e7d32') + '15', borderRadius: Radii.full, paddingHorizontal: 6, paddingVertical: 2 },
  teachChipText: { fontSize: Typography.sizes.xs, color: Colors.greenDark || '#1b5e20', fontWeight: Typography.weights.bold },
  nearbyList: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingRight: Spacing.xl },
  nearbyLabel: { fontSize: Typography.sizes.sm, color: Colors.slate, fontWeight: Typography.weights.bold, marginRight: Spacing.xs },
  nearbyChip: {
    backgroundColor: Colors.offWhite, borderRadius: Radii.lg,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    alignItems: 'center', minWidth: 100, 
    borderWidth: 1, borderColor: Colors.fog,
    ...Shadows.sm,
  },
  nearbyChipEmoji: { fontSize: 22, marginBottom: 4 },
  nearbyChipText: { fontSize: Typography.sizes.xs, fontWeight: Typography.weights.bold, color: Colors.greenDark || '#1b5e20', textAlign: 'center' },
  nearbyChipDist: { fontSize: 10, color: Colors.slate, marginTop: 2 },
});