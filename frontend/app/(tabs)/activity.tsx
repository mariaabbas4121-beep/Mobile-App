import { View, Text, StyleSheet, FlatList, TouchableOpacity, Image } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApp } from '../../context/AppContext';
import { Transaction } from '../../data/mockData';
import { Colors, Typography, Spacing, Radii, Shadows } from '../../utils/theme';

const STATUS_CONFIG: Record<string, { color: string; bg: string; icon: string; label: string }> = {
  Pending:   { color: '#f59e0b',  bg: '#fef3c7',  icon: 'time-outline',             label: 'Pending Approval' },
  Accepted:  { color: '#3b82f6',  bg: '#dbeafe',  icon: 'checkmark-circle-outline', label: 'Accepted' },
  'In Use':  { color: Colors.green || '#2e7d32', bg: (Colors.green || '#2e7d32') + '15', icon: 'swap-horizontal-outline',   label: 'In Use' },
  Completed: { color: Colors.greenDark || '#1b5e20',   bg: '#e8f5e9',   icon: 'checkmark-done-outline',   label: 'Completed' },
  Cancelled: { color: '#ef4444',  bg: '#fee2e2',  icon: 'close-circle-outline',     label: 'Cancelled' },
};

function TxnCard({ txn }: { txn: Transaction }) {
  const router = useRouter();
  const cfg = STATUS_CONFIG[txn.status] || STATUS_CONFIG['Pending'];
  const isBorrower = txn.borrowerId === 'u1';

  return (
    <TouchableOpacity
      style={styles.card}
      activeOpacity={0.88}
      onPress={() => {
        if (txn.status === 'In Use' || txn.status === 'Accepted') {
          router.push(`/qr/${txn.id}`);
        }
      }}
    >
      <Image source={{ uri: txn.itemImage }} style={styles.cardImg} />
      <View style={styles.cardBody}>
        <View style={styles.cardTop}>
          <Text style={styles.cardTitle} numberOfLines={1}>{txn.itemTitle}</Text>
          <View style={[styles.statusChip, { backgroundColor: cfg.bg }]}>
            <Ionicons name={cfg.icon as any} size={12} color={cfg.color} />
            <Text style={[styles.statusText, { color: cfg.color }]}>{cfg.label}</Text>
          </View>
        </View>

        <Text style={styles.cardRole}>
          {isBorrower ? `Borrowed from ${txn.lenderName}` : `Lent to ${txn.borrowerName}`}
        </Text>
        <Text style={styles.cardDate}>{txn.requestDate}</Text>

        {txn.teachMeRequested && (
          <View style={styles.teachRow}>
            <Text style={styles.teachTag}>🎓 Teach Me session requested</Text>
          </View>
        )}

        {(txn.status === 'In Use' || txn.status === 'Accepted') && (
          <View style={styles.actionRow}>
            <TouchableOpacity
              style={styles.qrBtn}
              onPress={() => router.push(`/qr/${txn.id}`)}
            >
              <Ionicons name="qr-code" size={14} color={Colors.white} />
              <Text style={styles.qrBtnText}>View QR Code</Text>
            </TouchableOpacity>
            {txn.teachMeRequested && (
              <TouchableOpacity
                style={styles.teachBtn}
                onPress={() => router.push(`/teach/${txn.id}`)}
              >
                <Text style={styles.teachBtnText}>🎓 Start Demo</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

export default function ActivityScreen() {
  const { transactions } = useApp();

  const active = transactions.filter(t => t.status !== 'Completed' && t.status !== 'Cancelled');
  const past = transactions.filter(t => t.status === 'Completed' || t.status === 'Cancelled');

  return (
    <View style={styles.container}>
      {/* Light White Header Frame */}
      <View style={styles.header}>
        <SafeAreaView edges={['top']}>
          <Text style={styles.headerTitle}>Activity</Text>
          <Text style={styles.headerSub}>Your borrows and lends</Text>
        </SafeAreaView>
      </View>

      <FlatList
        data={[...active, ...past]}
        keyExtractor={t => t.id}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          active.length > 0 ? (
            <View style={styles.sectionHeader}>
              <View style={styles.activeDot} />
              <Text style={styles.sectionTitle}>Active ({active.length})</Text>
            </View>
          ) : undefined
        }
        ItemSeparatorComponent={() => <View style={{ height: Spacing.md }} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyEmoji}>📋</Text>
            <Text style={styles.emptyTitle}>No activity yet</Text>
            <Text style={styles.emptyDesc}>Browse items and make your first borrow request</Text>
          </View>
        }
        renderItem={({ item, index }) => {
          const showPast = active.length > 0 && index === active.length;
          return (
            <>
              {showPast && (
                <View style={[styles.sectionHeader, { marginTop: Spacing.lg }]}>
                  <Text style={styles.sectionTitle}>History</Text>
                </View>
              )}
              {index === 0 && active.length === 0 && (
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>History</Text>
                </View>
              )}
              <TxnCard txn={item} />
            </>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.offWhite },
  header: { 
    paddingHorizontal: Spacing.xl, 
    paddingBottom: Spacing.xl,
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderColor: Colors.fog,
    ...Shadows.sm,
  },
  headerTitle: { fontSize: Typography.sizes.xl, fontWeight: Typography.weights.extrabold, color: Colors.greenDark || '#1b5e20' },
  headerSub: { fontSize: Typography.sizes.sm, color: Colors.slate, marginTop: 2 },
  list: { padding: Spacing.xl, paddingBottom: 100 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.md },
  activeDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.green || '#2e7d32' },
  sectionTitle: { fontSize: Typography.sizes.base, fontWeight: Typography.weights.bold, color: Colors.greenDark || '#1b5e20' },
  card: {
    flexDirection: 'row', backgroundColor: Colors.white,
    borderRadius: Radii.lg, overflow: 'hidden', borderWidth: 1, borderColor: Colors.fog, ...Shadows.sm,
  },
  cardImg: { width: 90, height: 'auto' as any },
  cardBody: { flex: 1, padding: Spacing.md },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: Spacing.sm, marginBottom: 4 },
  cardTitle: { flex: 1, fontSize: Typography.sizes.base, fontWeight: Typography.weights.bold, color: Colors.greenDark || '#1b5e20' },
  statusChip: { flexDirection: 'row', alignItems: 'center', gap: 3, borderRadius: Radii.full, paddingHorizontal: 7, paddingVertical: 3 },
  statusText: { fontSize: 10, fontWeight: Typography.weights.bold },
  cardRole: { fontSize: Typography.sizes.sm, color: Colors.slate, fontWeight: Typography.weights.medium },
  cardDate: { fontSize: Typography.sizes.xs, color: Colors.slate, opacity: 0.8, marginTop: 2 },
  teachRow: { marginTop: Spacing.xs },
  teachTag: { fontSize: Typography.sizes.xs, color: Colors.greenDark || '#1b5e20', fontWeight: Typography.weights.semibold },
  actionRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm },
  qrBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.green || '#2e7d32', borderRadius: Radii.full,
    paddingHorizontal: Spacing.md, paddingVertical: 6,
    ...Shadows.sm,
  },
  qrBtnText: { fontSize: Typography.sizes.xs, color: Colors.white, fontWeight: Typography.weights.bold },
  teachBtn: {
    backgroundColor: Colors.offWhite, borderRadius: Radii.full,
    paddingHorizontal: Spacing.md, paddingVertical: 6,
    borderWidth: 1, borderColor: Colors.fog,
  },
  teachBtnText: { fontSize: Typography.sizes.xs, color: Colors.slate, fontWeight: Typography.weights.semibold },
  empty: { alignItems: 'center', paddingTop: 60 },
  emptyEmoji: { fontSize: 48, marginBottom: Spacing.md },
  emptyTitle: { fontSize: Typography.sizes.lg, fontWeight: Typography.weights.bold, color: Colors.greenDark || '#1b5e20' },
  emptyDesc: { fontSize: Typography.sizes.base, color: Colors.slate, marginTop: Spacing.xs, textAlign: 'center' },
});