import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Dimensions, Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { Colors, Typography, Spacing, Radii, Shadows } from '../../utils/theme';

const { width } = Dimensions.get('window');

function TrustMeter({ score }: { score: number }) {
  return (
    <View style={styles.trustMeter}>
      <View style={styles.trustTrack}>
        <LinearGradient
          colors={['#81c784', Colors.green || '#2e7d32', Colors.greenDark || '#1b5e20']}
          style={[styles.trustFill, { width: `${score}%` as any }]}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
        />
      </View>
      <View style={styles.trustLabels}>
        <Text style={styles.trustLabel}>0</Text>
        <Text style={styles.trustLabel}>50</Text>
        <Text style={styles.trustLabel}>100</Text>
      </View>
    </View>
  );
}

const MENU_ITEMS = [
  { icon: 'cube-outline', label: 'My Listed Items', color: '#2e7d32' },
  { icon: 'star-outline', label: 'Reviews & Ratings', color: '#2e7d32' },
  { icon: 'shield-checkmark-outline', label: 'Verification Status', color: '#2e7d32' },
  { icon: 'notifications-outline', label: 'Notifications', color: '#2e7d32' },
  { icon: 'help-circle-outline', label: 'Help & Support', color: '#64748b' },
  { icon: 'log-out-outline', label: 'Sign Out', color: '#ef4444' },
];

export default function ProfileScreen() {
  // Name, join date and account status come from the signed-in account;
  // the statistics below are still sample data.
  const { currentUser, transactions } = useApp();
  const { profile, user, signOut } = useAuth();
  const completedCount = transactions.filter(t => t.status === 'Completed').length;

  const profileName = profile?.displayName || user?.email || 'Your profile';
  const joined = profile?.createdAt ?? user?.createdAt;
  const memberSinceDate = joined
    ? new Date(joined).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    : '';

  const confirmSignOut = () =>
    Alert.alert('Sign out?', 'You will need to sign in again to use NeighborShare.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
    ]);

  return (
    <View style={styles.container}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {/* White and Green Header */}
        <View style={styles.header}>
          <SafeAreaView edges={['top']} style={styles.headerSafe}>
            {/* Picture circle has been removed from here */}
            <Text style={styles.userName}>{profileName}</Text>
            {memberSinceDate ? <Text style={styles.userMeta}>Member since {memberSinceDate}</Text> : null}
            {profile?.accountStatus === 'restricted' && (
              <Text style={styles.userMeta} accessibilityRole="alert">
                Your account is restricted. Some features may be unavailable.
              </Text>
            )}

            {/* Stats row */}
            <View style={styles.statsRow}>
              {[
                { label: 'Lent', value: currentUser?.lendingCount || 0 },
                { label: 'Borrowed', value: currentUser?.borrowCount || 0 },
                { label: 'Completed', value: completedCount },
              ].map(s => (
                <View key={s.label} style={styles.statItem}>
                  <Text style={styles.statValue}>{s.value}</Text>
                  <Text style={styles.statLabel}>{s.label}</Text>
                </View>
              ))}
            </View>
          </SafeAreaView>
        </View>

        {/* Trust Score Card */}
        <View style={styles.section}>
          <View style={styles.trustCard}>
            <View style={styles.trustHeader}>
              <View>
                <Text style={styles.trustTitle}>Trust Score</Text>
                <Text style={styles.trustDesc}>Based on timely returns & item care</Text>
              </View>
              <View style={styles.trustScore}>
                <Text style={styles.trustScoreNum}>{currentUser?.trustScore || 95}</Text>
                <Text style={styles.trustScoreLabel}>/100</Text>
              </View>
            </View>
            <TrustMeter score={currentUser?.trustScore || 95} />
            <View style={styles.trustTip}>
              <Ionicons name="information-circle-outline" size={14} color={Colors.green || '#2e7d32'} />
              <Text style={styles.trustTipText}>Return items on time to boost your score</Text>
            </View>
          </View>
        </View>

        {/* Karma Points */}
        <View style={styles.section}>
          <View style={styles.karmaCard}>
            <LinearGradient
              colors={[Colors.green || '#2e7d32', Colors.greenDark || '#1b5e20']}
              style={styles.karmaGrad}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            >
              <View style={styles.karmaLeft}>
                <Text style={styles.karmaEmoji}>✨</Text>
                <View>
                  <Text style={styles.karmaLabel}>Karma Points</Text>
                  <Text style={styles.karmaValue}>{currentUser?.karmaPoints || 350}</Text>
                </View>
              </View>
              <View style={styles.karmaRight}>
                <Text style={styles.karmaRightText}>Earn by{'\n'}teaching others</Text>
              </View>
            </LinearGradient>
          </View>
        </View>

        {/* Skill Badges */}
        {currentUser?.badges && currentUser.badges.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Skill Badges</Text>
            <View style={styles.badgesGrid}>
              {currentUser.badges.map(badge => (
                <View key={badge.id} style={styles.badgeCard}>
                  <View style={[styles.badgeIconWrap, { backgroundColor: (Colors.green || '#2e7d32') + '15' }]}>
                    <Text style={styles.badgeEmoji}>{badge.icon}</Text>
                  </View>
                  <Text style={styles.badgeName}>{badge.name}</Text>
                  <Text style={styles.badgeDesc}>{badge.description}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Menu */}
        <View style={styles.section}>
          <View style={styles.menuCard}>
            {MENU_ITEMS.map((item, i) => (
              <TouchableOpacity
                key={item.label}
                style={[styles.menuItem, i < MENU_ITEMS.length - 1 && styles.menuItemBorder]}
                onPress={item.label === 'Sign Out' ? confirmSignOut : undefined}
                accessibilityRole="button"
                accessibilityLabel={item.label}
                activeOpacity={0.7}
              >
                <View style={[styles.menuIcon, { backgroundColor: item.color === '#ef4444' ? '#fee2e2' : '#e8f5e9' }]}>
                  <Ionicons name={item.icon as any} size={18} color={item.color} />
                </View>
                <Text style={[styles.menuLabel, item.label === 'Sign Out' && { color: '#ef4444' }]}>
                  {item.label}
                </Text>
                <Ionicons name="chevron-forward" size={16} color={Colors.slate} />
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View style={{ height: 80 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.offWhite },
  scroll: { flexGrow: 1 },
  header: { 
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderColor: Colors.fog,
    ...Shadows.sm
  },
  headerSafe: { paddingHorizontal: Spacing.xl, paddingBottom: Spacing.xl, alignItems: 'center' },
  userName: { fontSize: Typography.sizes.xl, fontWeight: Typography.weights.extrabold, color: Colors.greenDark || '#1b5e20', marginTop: Spacing.xl },
  userMeta: { fontSize: Typography.sizes.sm, color: Colors.slate, marginTop: 2, marginBottom: Spacing.xl },
  statsRow: { flexDirection: 'row', gap: Spacing['2xl'] },
  statItem: { alignItems: 'center' },
  statValue: { fontSize: Typography.sizes.xl, fontWeight: Typography.weights.extrabold, color: Colors.greenDark || '#1b5e20' },
  statLabel: { fontSize: Typography.sizes.xs, color: Colors.slate, marginTop: 2, fontWeight: Typography.weights.medium },
  section: { paddingHorizontal: Spacing.xl, marginTop: Spacing.xl },
  sectionTitle: { fontSize: Typography.sizes.md, fontWeight: Typography.weights.bold, color: Colors.greenDark || '#1b5e20', marginBottom: Spacing.md },
  trustCard: { backgroundColor: Colors.white, borderRadius: Radii.xl, padding: Spacing.xl, borderWidth: 1, borderColor: Colors.fog, ...Shadows.sm },
  trustHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: Spacing.md },
  trustTitle: { fontSize: Typography.sizes.md, fontWeight: Typography.weights.bold, color: Colors.greenDark || '#1b5e20' },
  trustDesc: { fontSize: Typography.sizes.xs, color: Colors.slate, marginTop: 2 },
  trustScore: { flexDirection: 'row', alignItems: 'baseline', gap: 2 },
  trustScoreNum: { fontSize: 36, fontWeight: Typography.weights.extrabold, color: Colors.green || '#2e7d32' },
  trustScoreLabel: { fontSize: Typography.sizes.sm, color: Colors.slate },
  trustMeter: {},
  trustTrack: { height: 10, backgroundColor: Colors.offWhite, borderWidth: 1, borderColor: Colors.fog, borderRadius: Radii.full, overflow: 'hidden' },
  trustFill: { height: '100%', borderRadius: Radii.full },
  trustLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  trustLabel: { fontSize: 9, color: Colors.slate },
  trustTip: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: Spacing.md },
  trustTipText: { fontSize: Typography.sizes.xs, color: Colors.greenDark || '#1b5e20', fontWeight: Typography.weights.medium },
  karmaCard: { borderRadius: Radii.xl, overflow: 'hidden', ...Shadows.sm },
  karmaGrad: { padding: Spacing.xl, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  karmaLeft: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  karmaEmoji: { fontSize: 36 },
  karmaLabel: { fontSize: Typography.sizes.sm, color: 'rgba(255,255,255,0.8)' },
  karmaValue: { fontSize: 32, fontWeight: Typography.weights.extrabold, color: Colors.white },
  karmaRight: {},
  karmaRightText: { fontSize: Typography.sizes.sm, color: 'rgba(255,255,255,0.7)', textAlign: 'right', lineHeight: 18 },
  badgesGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md },
  badgeCard: {
    width: (width - Spacing.xl * 2 - Spacing.md * 2) / 3,
    backgroundColor: Colors.white, borderRadius: Radii.lg,
    padding: Spacing.md, alignItems: 'center', borderWidth: 1, borderColor: Colors.fog, ...Shadows.sm,
  },
  badgeIconWrap: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.sm },
  badgeEmoji: { fontSize: 22 },
  badgeName: { fontSize: Typography.sizes.xs, fontWeight: Typography.weights.bold, color: Colors.greenDark || '#1b5e20', textAlign: 'center', marginBottom: 2 },
  badgeDesc: { fontSize: 9, color: Colors.slate, textAlign: 'center', lineHeight: 12 },
  menuCard: { backgroundColor: Colors.white, borderRadius: Radii.xl, overflow: 'hidden', borderWidth: 1, borderColor: Colors.fog, ...Shadows.sm },
  menuItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.lg, paddingVertical: Spacing.base, gap: Spacing.md },
  menuItemBorder: { borderBottomWidth: 1, borderBottomColor: Colors.fog },
  menuIcon: { width: 36, height: 36, borderRadius: Radii.md, alignItems: 'center', justifyContent: 'center' },
  menuLabel: { flex: 1, fontSize: Typography.sizes.base, color: Colors.greenDark || '#1b5e20', fontWeight: Typography.weights.semibold },
});