import { useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  TextInput, ScrollView, Image, Dimensions, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useApp } from '../../context/AppContext';
import { CATEGORIES, Item } from '../../data/mockData';
import { Colors, Typography, Spacing, Radii, Shadows } from '../../utils/theme';

const { width } = Dimensions.get('window');
const CARD_WIDTH = (width - Spacing.xl * 2 - Spacing.md) / 2;

function ItemCard({ item, onPress }: { item: Item; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.88}>
      <View style={styles.imageWrap}>
        <Image source={{ uri: item.image }} style={styles.cardImage} resizeMode="cover" />
        {!item.available && (
          <View style={styles.unavailableOverlay}>
            <Text style={styles.unavailableText}>In Use</Text>
          </View>
        )}
        {item.teachMeEnabled && (
          <View style={styles.teachBadge}>
            <Text style={styles.teachBadgeText}>🎓</Text>
          </View>
        )}
        <View style={styles.distanceBadge}>
          <Ionicons name="location" size={10} color={Colors.green || "#2e7d32"} />
          <Text style={styles.distanceText}>{item.distance}</Text>
        </View>
      </View>
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle} numberOfLines={1}>{item.title}</Text>
        <View style={styles.cardMeta}>
          <View style={[styles.conditionDot, {
            backgroundColor: item.condition === 'Excellent' ? (Colors.green || '#2e7d32')
              : item.condition === 'Good' ? '#4caf50' : Colors.slate
          }]} />
          <Text style={styles.cardCondition}>{item.condition}</Text>
        </View>
        <View style={styles.ownerRow}>
          <Image source={{ uri: item.ownerAvatar }} style={styles.ownerAvatar} />
          <Text style={styles.ownerName} numberOfLines={1}>{item.ownerName}</Text>
          <View style={styles.trustChip}>
            <Text style={styles.trustText}>{item.ownerTrustScore}</Text>
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

export default function BrowseScreen() {
  const router = useRouter();
  const { items, searchQuery, setSearchQuery, activeCategory, setActiveCategory } = useApp();

  const filtered = useMemo(() => {
    return items.filter(item => {
      const matchCat = activeCategory === 'all' || item.category.toLowerCase() === activeCategory;
      const matchSearch = !searchQuery || item.title.toLowerCase().includes(searchQuery.toLowerCase())
        || item.tags.some(t => t.toLowerCase().includes(searchQuery.toLowerCase()));
      return matchCat && matchSearch;
    });
  }, [items, searchQuery, activeCategory]);

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
            />
            {searchQuery ? (
              <TouchableOpacity onPress={() => setSearchQuery('')}>
                <Ionicons name="close-circle" size={18} color={Colors.slate} />
              </TouchableOpacity>
            ) : null}
          </View>

          {/* Categories Horizontal Scroller */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.catScroll} contentContainerStyle={styles.catContent}>
            {CATEGORIES.map(cat => (
              <TouchableOpacity
                key={cat.id}
                style={[styles.catChip, activeCategory === cat.id && styles.catChipActive]}
                onPress={() => setActiveCategory(cat.id)}
                activeOpacity={0.8}
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
        data={filtered}
        numColumns={2}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.grid}
        columnWrapperStyle={styles.row}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <Text style={styles.resultCount}>{filtered.length} items nearby</Text>
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyEmoji}>🔍</Text>
            <Text style={styles.emptyTitle}>Nothing found</Text>
            <Text style={styles.emptyDesc}>Try a different search or category</Text>
          </View>
        }
        renderItem={({ item }) => (
          <ItemCard
            item={item}
            onPress={() => router.push(`/item/${item.id}`)}
          />
        )}
      />
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
  unavailableOverlay: {
    ...StyleSheet.absoluteFillObject,
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
  distanceText: { fontSize: 10, color: Colors.greenDark || '#1b5e20', fontWeight: Typography.weights.bold },
  cardBody: { padding: Spacing.md },
  cardTitle: { fontSize: Typography.sizes.base, fontWeight: Typography.weights.semibold, color: Colors.greenDark || '#1b5e20', marginBottom: 4 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 8 },
  conditionDot: { width: 7, height: 7, borderRadius: 4 },
  cardCondition: { fontSize: Typography.sizes.xs, color: Colors.slate },
  ownerRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  ownerAvatar: { width: 18, height: 18, borderRadius: 9 },
  ownerName: { flex: 1, fontSize: Typography.sizes.xs, color: Colors.slate },
  trustChip: {
    backgroundColor: (Colors.green || '#2e7d32') + '15', borderRadius: Radii.full,
    paddingHorizontal: 5, paddingVertical: 2,
  },
  trustText: { fontSize: 9, fontWeight: Typography.weights.bold, color: Colors.greenDark || '#1b5e20' },
  emptyState: { alignItems: 'center', paddingTop: 60 },
  emptyEmoji: { fontSize: 48, marginBottom: Spacing.md },
  emptyTitle: { fontSize: Typography.sizes.lg, fontWeight: Typography.weights.bold, color: Colors.greenDark || '#1b5e20' },
  emptyDesc: { fontSize: Typography.sizes.base, color: Colors.slate, marginTop: Spacing.xs },
});