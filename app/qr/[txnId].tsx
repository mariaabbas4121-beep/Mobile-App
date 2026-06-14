import { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Dimensions, Alert,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import QRCode from 'react-native-qrcode-svg';
import Toast from 'react-native-toast-message';
import { useApp } from '../../context/AppContext';
import { Colors, Typography, Spacing, Radii, Shadows } from '../../utils/theme';

const { width } = Dimensions.get('window');
const QR_SIZE = width * 0.62;

export default function QRScreen() {
  const { txnId } = useLocalSearchParams<{ txnId: string }>();
  const router = useRouter();
  const { transactions, completeTransaction } = useApp();
  const txn = transactions.find(t => t.id === txnId);

  const [scanning, setScanning] = useState(false);
  const [completed, setCompleted] = useState(false);

  if (!txn) return null;

  const isBorrower = txn.borrowerId === 'u1';
  const isPickup = txn.status === 'Accepted' || txn.status === 'Pending';
  const isReturn = txn.status === 'In Use';

  const handleSimulateScan = () => {
    setScanning(true);
    setTimeout(() => {
      setScanning(false);
      setCompleted(true);
      completeTransaction(txn.id);
      Toast.show({
        type: 'success',
        text1: '✅ Return Verified!',
        text2: 'Transaction completed. Thank you!',
      });
    }, 2000);
  };

  if (completed) {
    return (
      <View style={styles.container}>
        <LinearGradient colors={[Colors.navy, Colors.navyMid]} style={StyleSheet.absoluteFill} />
        <SafeAreaView style={styles.successWrap}>
          <View style={styles.successCard}>
            <View style={styles.successIcon}>
              <Ionicons name="checkmark-circle" size={72} color={Colors.sage} />
            </View>
            <Text style={styles.successTitle}>Transaction Complete!</Text>
            <Text style={styles.successDesc}>
              The item has been successfully returned. Your trust score has been updated.
            </Text>
            {txn.teachMeRequested && (
              <View style={styles.badgeEarned}>
                <Text style={styles.badgeEarnedEmoji}>🎓</Text>
                <Text style={styles.badgeEarnedText}>You earned a Skill Badge!</Text>
              </View>
            )}
            <TouchableOpacity
              style={styles.doneBtn}
              onPress={() => router.replace('/(tabs)/activity')}
            >
              <LinearGradient colors={[Colors.amber, Colors.amberDark]} style={styles.doneBtnGrad}>
                <Text style={styles.doneBtnText}>View Activity</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <LinearGradient colors={[Colors.navy, '#0d1f3c']} style={StyleSheet.absoluteFill} />

      <SafeAreaView style={styles.safe}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.closeBtn}>
            <Ionicons name="close" size={22} color={Colors.white} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>
            {isPickup ? 'Pickup QR Code' : 'Return QR Code'}
          </Text>
          <View style={{ width: 40 }} />
        </View>

        {/* Status banner */}
        <View style={styles.statusBanner}>
          <View style={[styles.statusDot, { backgroundColor: isReturn ? Colors.violet : Colors.amber }]} />
          <Text style={styles.statusText}>
            {isReturn
              ? `"${txn.itemTitle}" is currently In Use`
              : `Awaiting pickup of "${txn.itemTitle}"`}
          </Text>
        </View>

        {/* QR Card */}
        <View style={styles.qrCard}>
          <Text style={styles.qrLabel}>
            {isBorrower
              ? isPickup ? 'Show this to the lender to confirm pickup' : 'Show this to confirm you\'re returning'
              : 'Scan borrower\'s QR to confirm return'}
          </Text>

          <View style={styles.qrWrapper}>
            <QRCode
              value={txn.qrCode}
              size={QR_SIZE}
              color={Colors.navy}
              backgroundColor={Colors.white}
            />
          </View>

          <View style={styles.txnInfo}>
            <View style={styles.txnRow}>
              <Text style={styles.txnKey}>Transaction</Text>
              <Text style={styles.txnVal}>{txn.qrCode}</Text>
            </View>
            <View style={styles.txnRow}>
              <Text style={styles.txnKey}>Item</Text>
              <Text style={styles.txnVal}>{txn.itemTitle}</Text>
            </View>
            <View style={styles.txnRow}>
              <Text style={styles.txnKey}>
                {isBorrower ? 'Lender' : 'Borrower'}
              </Text>
              <Text style={styles.txnVal}>
                {isBorrower ? txn.lenderName : txn.borrowerName}
              </Text>
            </View>
          </View>
        </View>

        {/* Instructions */}
        <View style={styles.instructions}>
          <Ionicons name="information-circle-outline" size={16} color={Colors.sky} />
          <Text style={styles.instructionText}>
            {isPickup
              ? 'At pickup: Lender scans this QR to mark item as "In Use"'
              : 'At return: Lender scans borrower\'s QR to complete the transaction'}
          </Text>
        </View>

        {/* Simulate scan (demo) */}
        {isReturn && (
          <TouchableOpacity
            style={styles.scanBtn}
            onPress={handleSimulateScan}
            activeOpacity={0.85}
            disabled={scanning}
          >
            <LinearGradient
              colors={[Colors.sage, Colors.sageDark]}
              style={styles.scanBtnGrad}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
            >
              <Ionicons name="qr-code-outline" size={20} color={Colors.white} />
              <Text style={styles.scanBtnText}>
                {scanning ? 'Verifying…' : '📱 Simulate Return Scan (Demo)'}
              </Text>
            </LinearGradient>
          </TouchableOpacity>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1, paddingHorizontal: Spacing.xl },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: Spacing.md, marginBottom: Spacing.xl },
  closeBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.navyLight, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: Typography.sizes.md, fontWeight: Typography.weights.bold, color: Colors.white },
  statusBanner: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.navyLight, borderRadius: Radii.lg,
    padding: Spacing.md, marginBottom: Spacing.xl,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { flex: 1, fontSize: Typography.sizes.sm, color: Colors.slateLight },
  qrCard: {
    backgroundColor: Colors.white, borderRadius: Radii.xl,
    padding: Spacing.xl, alignItems: 'center', ...Shadows.lg,
    marginBottom: Spacing.xl,
  },
  qrLabel: { fontSize: Typography.sizes.sm, color: Colors.slate, textAlign: 'center', marginBottom: Spacing.xl, lineHeight: 18 },
  qrWrapper: {
    padding: Spacing.lg, backgroundColor: Colors.white,
    borderRadius: Radii.lg, borderWidth: 2, borderColor: Colors.fog,
    marginBottom: Spacing.xl,
  },
  txnInfo: { width: '100%', gap: Spacing.sm },
  txnRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: Spacing.xs, borderBottomWidth: 1, borderBottomColor: Colors.fog },
  txnKey: { fontSize: Typography.sizes.sm, color: Colors.slate },
  txnVal: { fontSize: Typography.sizes.sm, color: Colors.navy, fontWeight: Typography.weights.semibold, flex: 1, textAlign: 'right' },
  instructions: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm, marginBottom: Spacing.xl, backgroundColor: Colors.navyLight, borderRadius: Radii.md, padding: Spacing.md },
  instructionText: { flex: 1, fontSize: Typography.sizes.sm, color: Colors.slateLight, lineHeight: 18 },
  scanBtn: { borderRadius: Radii.lg, overflow: 'hidden' },
  scanBtnGrad: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, paddingVertical: Spacing.base },
  scanBtnText: { fontSize: Typography.sizes.base, fontWeight: Typography.weights.bold, color: Colors.white },
  successWrap: { flex: 1, justifyContent: 'center', padding: Spacing.xl },
  successCard: { backgroundColor: Colors.white, borderRadius: Radii.xl, padding: Spacing['2xl'], alignItems: 'center', ...Shadows.lg },
  successIcon: { marginBottom: Spacing.xl },
  successTitle: { fontSize: Typography.sizes.xl, fontWeight: Typography.weights.extrabold, color: Colors.navy, textAlign: 'center', marginBottom: Spacing.md },
  successDesc: { fontSize: Typography.sizes.base, color: Colors.slate, textAlign: 'center', lineHeight: 22, marginBottom: Spacing.xl },
  badgeEarned: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, backgroundColor: Colors.violetPale, borderRadius: Radii.lg, padding: Spacing.md, marginBottom: Spacing.xl },
  badgeEarnedEmoji: { fontSize: 24 },
  badgeEarnedText: { fontSize: Typography.sizes.base, color: Colors.violet, fontWeight: Typography.weights.bold },
  doneBtn: { width: '100%', borderRadius: Radii.lg, overflow: 'hidden' },
  doneBtnGrad: { paddingVertical: Spacing.base, alignItems: 'center' },
  doneBtnText: { fontSize: Typography.sizes.md, fontWeight: Typography.weights.bold, color: Colors.navy },
});
