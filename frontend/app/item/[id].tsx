import { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Image, Dimensions, Alert,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import { useApp } from '../../context/AppContext';
import { Colors, Typography, Spacing, Radii, Shadows } from '../../utils/theme';

const { width, height } = Dimensions.get('window');

export default function ItemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { items, requestBorrow } = useApp();
  const item = items.find(i => i.id === id);

  const [teachMe, setTeachMe] = useState(false);
  const [requesting, setRequesting] = useState(false);

  if (!item) return null;

  const isOwnItem = item.ownerId === 'u1';

  const handleRequest = () => {
    if (!item.available) return;
    setRequesting(true);
    setTimeout(() => {
      requestBorrow(item.id, teachMe);
      setRequesting(false);
      Toast.show({
        type: 'success',
        text1: '✅ Request Sent!',
        text2: `${item.ownerName} will review your request shortly`,
      });
      router.replace('/(tabs)/activity');
    }, 1000);
  };

  return (
    <View style={styles.container}>
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Hero image */}
        <View style={styles.imageContainer}>
          <Image source={{ uri: item.image }} style={styles.heroImage} resizeMode="cover" />
          <LinearGradient
            colors={['transparent', Colors.navy + 'CC']}
            style={styles.imageOverlay}
          />
          {/* Back button */}
          <SafeAreaView edges={['top']} style={styles.backWrap}>
            <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
              <Ionicons name="arrow-back" size={20} color={Colors.white} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.shareBtn}>
              <Ionicons name="share-outline" size={20} color={Colors.white} />
            </TouchableOpacity>
          </SafeAreaView>

          {/* Image badges */}
          <View style={styles.imageBadges}>
            <View style={[styles.availBadge, { backgroundColor: item.available ? Colors.sage : Colors.rose }]}>
              <View style={styles.availDot} />
              <Text style={styles.availText}>{item.available ? 'Available Now' : 'Currently In Use'}</Text>
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
              <Text style={styles.category}>{item.category}</Text>
              <Text style={styles.title}>{item.title}</Text>
            </View>
            <View style={[styles.conditionChip, {
              backgroundColor: item.condition === 'Excellent' ? Colors.sagePale
                : item.condition === 'Good' ? Colors.amberPale : Colors.fog
            }]}>
              <Text style={[styles.conditionText, {
                color: item.condition === 'Excellent' ? Colors.sageDark
                  : item.condition === 'Good' ? Colors.amberDark : Colors.slate
              }]}>
                {item.condition}
              </Text>
            </View>
          </View>

          {/* Stats row */}
          <View style={styles.statsRow}>
            <View style={styles.statItem}>
              <Ionicons name="location-outline" size={16} color={Colors.amber} />
              <Text style={styles.statText}>{item.distance} away</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Ionicons name="repeat-outline" size={16} color={Colors.sky} />
              <Text style={styles.statText}>Lent {item.borrowCount}x</Text>
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

          {/* Tags */}
          <View style={styles.tagsRow}>
            {item.tags.map(tag => (
              <View key={tag} style={styles.tag}>
                <Text style={styles.tagText}>{tag}</Text>
              </View>
            ))}
          </View>

          {/* Owner card */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Listed by</Text>
            <View style={styles.ownerCard}>
              <Image source={{ uri: item.ownerAvatar }} style={styles.ownerAvatar} />
              <View style={styles.ownerInfo}>
                <Text style={styles.ownerName}>{item.ownerName}</Text>
                <View style={styles.trustRow}>
                  <Ionicons name="shield-checkmark" size={13} color={Colors.sage} />
                  <Text style={styles.trustScore}>Trust Score: {item.ownerTrustScore}/100</Text>
                </View>
              </View>
              <TouchableOpacity style={styles.msgBtn}>
                <Ionicons name="chatbubble-outline" size={18} color={Colors.navy} />
              </TouchableOpacity>
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

          {/* Teach Me option */}
          {item.teachMeEnabled && !isOwnItem && (
            <View style={styles.section}>
              <TouchableOpacity
                style={[styles.teachToggle, teachMe && styles.teachToggleActive]}
                onPress={() => setTeachMe(v => !v)}
                activeOpacity={0.8}
              >
                <View style={styles.teachToggleLeft}>
                  <Text style={styles.teachToggleIcon}>🎓</Text>
                  <View>
                    <Text style={styles.teachToggleTitle}>Add "Teach Me" Session</Text>
                    <Text style={styles.teachToggleSub}>15-min demo from the owner. Earn a skill badge!</Text>
                  </View>
                </View>
                <View style={[styles.toggle, teachMe && styles.toggleOn]}>
                  <View style={[styles.toggleThumb, teachMe && styles.toggleThumbOn]} />
                </View>
              </TouchableOpacity>
            </View>
          )}

          <View style={{ height: 120 }} />
        </View>
      </ScrollView>

      {/* Bottom action */}
      {!isOwnItem && (
        <View style={styles.bottomAction}>
          <View style={styles.bottomInner}>
            <View>
              <Text style={styles.freeBadge}>🆓 Free</Text>
              <Text style={styles.borrowLabel}>Community Borrow</Text>
            </View>
            <TouchableOpacity
              style={[styles.borrowBtn, !item.available && styles.borrowBtnDisabled]}
              onPress={handleRequest}
              activeOpacity={0.85}
              disabled={!item.available || requesting}
            >
              <LinearGradient
                colors={item.available ? [Colors.amber, Colors.amberDark] : [Colors.slate, Colors.slate]}
                style={styles.borrowBtnGrad}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
              >
                <Text style={styles.borrowBtnText}>
                  {requesting ? 'Sending…' : !item.available ? 'Not Available' : 'Request to Borrow'}
                </Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.offWhite },
  imageContainer: { position: 'relative', height: height * 0.42 },
  heroImage: { width: '100%', height: '100%' },
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
