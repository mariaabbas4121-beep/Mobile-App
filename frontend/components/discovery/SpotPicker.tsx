import { useState } from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import MapView from 'react-native-maps';
import type { GeoPoint } from '../../lib/api/types';
import { regionFor } from '../../lib/location/geo';
import { Colors, Radii, Spacing, Typography } from '../../utils/theme';

const GREEN = Colors.green || '#2e7d32';

// Move the map so the pin sits where the item can be collected. A spot
// near home (a gate, a shop, a campus building) is enough; neighbours only
// ever see an approximate point about 0.5 km away.
export function SpotPicker({
  visible,
  start,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  start: GeoPoint;
  onCancel: () => void;
  onConfirm: (point: GeoPoint) => void;
}) {
  const [center, setCenter] = useState<GeoPoint>(start);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel} onShow={() => setCenter(start)}>
      <SafeAreaView style={styles.container}>
        <View style={styles.head}>
          <TouchableOpacity onPress={onCancel} accessibilityRole="button" accessibilityLabel="Cancel">
            <Text style={styles.cancel}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Pickup spot</Text>
          <TouchableOpacity onPress={() => onConfirm(center)} accessibilityRole="button" accessibilityLabel="Use this spot">
            <Text style={styles.confirm}>Use this spot</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.mapWrap}>
          <MapView
            testID="spot-map"
            style={StyleSheet.absoluteFill}
            initialRegion={regionFor(start, 0.6)}
            onRegionChangeComplete={(r) => setCenter({ latitude: r.latitude, longitude: r.longitude })}
          />
          {/* The pin stays in the middle; the map moves under it. */}
          <View pointerEvents="none" style={styles.pinWrap}>
            <Ionicons name="location" size={40} color={GREEN} />
          </View>
        </View>
        <Text style={styles.note}>
          Move the map to put the pin where you would hand the item over. You do not need your exact address. Neighbours only
          see an approximate spot about 0.5 km away.
        </Text>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.white },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md },
  title: { fontSize: Typography.sizes.md, fontWeight: Typography.weights.bold, color: Colors.navy },
  cancel: { fontSize: Typography.sizes.base, color: Colors.slate },
  confirm: { fontSize: Typography.sizes.base, fontWeight: Typography.weights.bold, color: GREEN },
  mapWrap: { flex: 1, borderTopWidth: 1, borderBottomWidth: 1, borderColor: Colors.fog },
  pinWrap: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', paddingBottom: 40 },
  note: { fontSize: Typography.sizes.sm, color: Colors.slate, padding: Spacing.lg, borderRadius: Radii.md },
});
