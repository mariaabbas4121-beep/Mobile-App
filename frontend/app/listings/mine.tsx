import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Image, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useListings } from '../../context/ListingsContext';
import type { Listing } from '../../lib/api/types';
import { errorMessage } from '../../lib/auth/messages';
import { categoryLabel } from '../../lib/listings/options';
import { Colors, Radii, Shadows, Spacing, Typography } from '../../utils/theme';

const GREEN = Colors.green || '#2e7d32';
const DARK = Colors.greenDark || '#1b5e20';

const statusOf = (l: Listing) =>
  l.archivedAt
    ? { label: 'Removed', color: Colors.slate, bg: Colors.fog }
    : l.availability === 'available'
      ? { label: 'Available', color: GREEN, bg: '#e8f5e9' }
      : { label: 'Unavailable', color: '#b45309', bg: '#fef3c7' };

// Profile → My Listings: the signed-in user's own listings, including removed
// ones. Browse shows only other people's items, so this is where owners
// find theirs; the item page has the edit, availability and remove actions.
export default function MyListingsScreen() {
  const router = useRouter();
  const { list, revision } = useListings();
  const [items, setItems] = useState<Listing[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(0);

  const load = useCallback(
    async (refresh = false) => {
      const ticket = ++latest.current;
      if (refresh) setRefreshing(true);
      try {
        const page = await list({ owner: 'me', includeArchived: true, pageSize: 50 });
        if (ticket !== latest.current) return;
        setItems(page.items);
        setStatus('ready');
      } catch (err) {
        if (ticket !== latest.current) return;
        setError(err);
        setStatus((s) => (s === 'ready' ? s : 'error'));
      } finally {
        if (ticket === latest.current) setRefreshing(false);
      }
    },
    [list],
  );

  // Reloads after any listing change (create, edit, remove).
  useEffect(() => {
    void load();
  }, [load, revision]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <SafeAreaView edges={['top']}>
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Go back">
              <Ionicons name="arrow-back" size={20} color={Colors.navy} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>My Listings</Text>
            <TouchableOpacity onPress={() => router.push('/lend/new')} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="List an item">
              <Ionicons name="add" size={22} color={DARK} />
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </View>

      {status === 'loading' ? (
        <View style={styles.centered} accessibilityLabel="Loading your listings">
          <ActivityIndicator size="large" color={GREEN} />
        </View>
      ) : status === 'error' ? (
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>Could not load your listings</Text>
          <Text style={styles.emptyDesc}>{errorMessage(error)}</Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => void load()} accessibilityRole="button" accessibilityLabel="Try again">
            <Text style={styles.primaryText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={GREEN} />}
          ItemSeparatorComponent={() => <View style={{ height: Spacing.md }} />}
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={styles.emptyTitle}>You have not listed anything yet</Text>
              <Text style={styles.emptyDesc}>Items you lend appear here, not in Browse.</Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={() => router.push('/lend/new')} accessibilityRole="button" accessibilityLabel="List your first item">
                <Text style={styles.primaryText}>List an item</Text>
              </TouchableOpacity>
            </View>
          }
          renderItem={({ item }) => {
            const s = statusOf(item);
            const cover = item.images[0]?.url;
            return (
              <TouchableOpacity
                style={[styles.card, item.archivedAt ? { opacity: 0.7 } : null]}
                onPress={() => router.push(`/item/${item.id}`)}
                accessibilityRole="button"
                accessibilityLabel={`${item.title}, ${s.label}`}
              >
                {cover ? (
                  <Image source={{ uri: cover }} style={styles.thumb} />
                ) : (
                  <View style={[styles.thumb, styles.thumbEmpty]}>
                    <Ionicons name="image-outline" size={20} color={Colors.slate} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
                  <Text style={styles.meta} numberOfLines={1}>
                    {categoryLabel(item.category)}
                    {item.area || item.city ? ` · ${[item.area, item.city].filter(Boolean).join(', ')}` : ''}
                  </Text>
                  <View style={[styles.chip, { backgroundColor: s.bg }]}>
                    <Text style={[styles.chipText, { color: s.color }]}>{s.label}</Text>
                  </View>
                </View>
                <Ionicons name="chevron-forward" size={16} color={Colors.slate} />
              </TouchableOpacity>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.offWhite },
  header: { backgroundColor: Colors.white, paddingHorizontal: Spacing.xl, paddingBottom: Spacing.md, borderBottomWidth: 1, borderColor: Colors.fog, ...Shadows.sm },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: Spacing.sm },
  backBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.fog, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: Typography.sizes.md, fontWeight: Typography.weights.bold, color: Colors.navy },
  list: { padding: Spacing.xl, paddingBottom: 60, flexGrow: 1 },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md, backgroundColor: Colors.white, borderRadius: Radii.lg,
    padding: Spacing.md, borderWidth: 1, borderColor: Colors.fog, ...Shadows.sm,
  },
  thumb: { width: 56, height: 56, borderRadius: Radii.md },
  thumbEmpty: { backgroundColor: Colors.fog, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: Typography.sizes.base, fontWeight: Typography.weights.bold, color: DARK },
  meta: { fontSize: Typography.sizes.xs, color: Colors.slate, marginTop: 2 },
  chip: { alignSelf: 'flex-start', borderRadius: Radii.full, paddingHorizontal: 8, paddingVertical: 2, marginTop: 4 },
  chipText: { fontSize: 10, fontWeight: Typography.weights.bold },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  emptyTitle: { fontSize: Typography.sizes.lg, fontWeight: Typography.weights.bold, color: DARK, textAlign: 'center' },
  emptyDesc: { fontSize: Typography.sizes.base, color: Colors.slate, marginTop: Spacing.xs, textAlign: 'center' },
  primaryBtn: { marginTop: Spacing.lg, backgroundColor: GREEN, borderRadius: Radii.full, paddingHorizontal: Spacing.xl, paddingVertical: Spacing.sm + 2 },
  primaryText: { color: Colors.white, fontWeight: Typography.weights.bold, fontSize: Typography.sizes.sm },
});
