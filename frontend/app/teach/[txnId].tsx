import { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Dimensions } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useApp } from '../../context/AppContext';
import { Colors, Typography, Spacing, Radii, Shadows } from '../../utils/theme';

const { width } = Dimensions.get('window');
const DEMO_DURATION = 15 * 60; // 15 minutes in seconds (use small number for demo)
const DEMO_DEMO_DURATION = 30; // 30 seconds for quick demo

const STEPS = [
  { icon: '👋', title: 'Introduce yourself', desc: 'Meet the lender and confirm the session' },
  { icon: '👀', title: 'Watch the demonstration', desc: 'Observe how the item is used safely' },
  { icon: '🤲', title: 'Try it yourself', desc: 'Practice under the owner\'s guidance' },
  { icon: '❓', title: 'Ask questions', desc: 'Clarify any doubts before borrowing solo' },
  { icon: '✅', title: 'Confirm completion', desc: 'Both parties mark the session done' },
];

function CircleTimer({ progress, timeLeft }: { progress: number; timeLeft: number }) {
  const radius = 90;
  const circumference = 2 * Math.PI * radius;
  const strokeDash = circumference * (1 - progress);

  const mins = Math.floor(timeLeft / 60);
  const secs = timeLeft % 60;

  return (
    <View style={styles.timerWrap}>
      {/* SVG-like circle using View + border tricks */}
      <View style={styles.timerCircleOuter}>
        <View style={styles.timerCircleInner}>
          <Text style={styles.timerMins}>
            {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
          </Text>
          <Text style={styles.timerLabel}>remaining</Text>
        </View>
      </View>
      {/* Progress arc rendered as colored border segment */}
      <View style={[styles.timerArc, {
        borderColor: progress > 0.5 ? Colors.sage : progress > 0.25 ? Colors.amber : Colors.rose,
      }]} />
    </View>
  );
}

export default function TeachMeScreen() {
  const { txnId } = useLocalSearchParams<{ txnId: string }>();
  const router = useRouter();
  const { transactions } = useApp();
  const txn = transactions.find(t => t.id === txnId);

  const [started, setStarted] = useState(false);
  const [timeLeft, setTimeLeft] = useState(DEMO_DEMO_DURATION);
  const [activeStep, setActiveStep] = useState(0);
  const [completed, setCompleted] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.08, duration: 1000, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
      ])
    ).start();
  }, []);

  useEffect(() => {
    if (started && !completed) {
      timerRef.current = setInterval(() => {
        setTimeLeft(prev => {
          if (prev <= 1) {
            clearInterval(timerRef.current!);
            setCompleted(true);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(timerRef.current!);
  }, [started]);

  if (!txn) return null;

  const progress = timeLeft / DEMO_DEMO_DURATION;

  if (completed) {
    return (
      <View style={styles.container}>
        <LinearGradient colors={['#4c1d95', Colors.violet]} style={StyleSheet.absoluteFill} />
        <SafeAreaView style={styles.completedSafe}>
          <View style={styles.completedCard}>
            <Text style={styles.completedEmoji}>🎓</Text>
            <Text style={styles.completedTitle}>Session Complete!</Text>
            <Text style={styles.completedDesc}>
              You've completed the Teach Me session for{'\n'}
              <Text style={{ fontWeight: '700' }}>{txn.itemTitle}</Text>
            </Text>

            <View style={styles.rewardRow}>
              <View style={styles.rewardItem}>
                <View style={[styles.rewardIcon, { backgroundColor: Colors.amberPale }]}>
                  <Text style={styles.rewardEmoji}>⚡</Text>
                </View>
                <Text style={styles.rewardLabel}>Skill Badge Earned</Text>
                <Text style={styles.rewardValue}>Quick Learner</Text>
              </View>
              <View style={styles.rewardDivider} />
              <View style={styles.rewardItem}>
                <View style={[styles.rewardIcon, { backgroundColor: Colors.violetPale }]}>
                  <Text style={styles.rewardEmoji}>✨</Text>
                </View>
                <Text style={styles.rewardLabel}>Lender Earned</Text>
                <Text style={styles.rewardValue}>+50 Karma</Text>
              </View>
            </View>

            <TouchableOpacity
              style={styles.doneBtn}
              onPress={() => router.replace('/(tabs)/activity')}
            >
              <LinearGradient colors={[Colors.amber, Colors.amberDark]} style={styles.doneBtnGrad}>
                <Text style={styles.doneBtnText}>View My Badges</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </View>
    );
  }

  if (!started) {
    return (
      <View style={styles.container}>
        <LinearGradient colors={[Colors.navy, '#1a1040']} style={StyleSheet.absoluteFill} />
        <SafeAreaView style={styles.safe}>
          <TouchableOpacity style={styles.closeBtn} onPress={() => router.back()}>
            <Ionicons name="close" size={22} color={Colors.white} />
          </TouchableOpacity>

          <View style={styles.introContent}>
            <Animated.View style={[styles.bigIcon, { transform: [{ scale: pulseAnim }] }]}>
              <Text style={styles.bigIconText}>🎓</Text>
            </Animated.View>

            <Text style={styles.introTitle}>Teach Me Mode</Text>
            <Text style={styles.introSub}>
              You've requested a 15-minute hands-on demonstration from <Text style={{ color: Colors.amber, fontWeight: '700' }}>{txn.lenderName}</Text>.
            </Text>

            <View style={styles.introSteps}>
              {STEPS.slice(0, 3).map((step, i) => (
                <View key={i} style={styles.introStep}>
                  <Text style={styles.introStepIcon}>{step.icon}</Text>
                  <Text style={styles.introStepText}>{step.title}</Text>
                </View>
              ))}
            </View>

            <View style={styles.rewardsPreview}>
              <Ionicons name="star" size={14} color={Colors.amber} />
              <Text style={styles.rewardsPreviewText}>
                Earn a <Text style={{ color: Colors.amber, fontWeight: '700' }}>Skill Badge</Text> on completion. Lender earns 50 Karma Points.
              </Text>
            </View>

            <TouchableOpacity
              style={styles.startBtn}
              onPress={() => setStarted(true)}
              activeOpacity={0.85}
            >
              <LinearGradient colors={[Colors.violet, '#6d28d9']} style={styles.startBtnGrad}>
                <Text style={styles.startBtnText}>Begin Demo Session</Text>
                <Ionicons name="arrow-forward" size={18} color={Colors.white} />
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <LinearGradient colors={[Colors.navy, '#1a1040']} style={StyleSheet.absoluteFill} />
      <SafeAreaView style={styles.safe}>
        <View style={styles.sessionHeader}>
          <TouchableOpacity style={styles.closeBtn} onPress={() => router.back()}>
            <Ionicons name="close" size={20} color={Colors.slateLight} />
          </TouchableOpacity>
          <Text style={styles.sessionTitle}>Live Demo Session</Text>
          <View style={styles.livePill}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>LIVE</Text>
          </View>
        </View>

        {/* Timer */}
        <View style={styles.timerSection}>
          <CircleTimer progress={progress} timeLeft={timeLeft} />
        </View>

        {/* Steps checklist */}
        <View style={styles.stepsCard}>
          <Text style={styles.stepsTitle}>Session Checklist</Text>
          {STEPS.map((step, i) => (
            <TouchableOpacity
              key={i}
              style={styles.stepRow}
              onPress={() => setActiveStep(i)}
              activeOpacity={0.7}
            >
              <View style={[
                styles.stepCheck,
                i < activeStep && styles.stepCheckDone,
                i === activeStep && styles.stepCheckActive,
              ]}>
                {i < activeStep
                  ? <Ionicons name="checkmark" size={13} color={Colors.white} />
                  : <Text style={styles.stepCheckNum}>{i + 1}</Text>
                }
              </View>
              <View style={styles.stepText}>
                <Text style={[styles.stepTitle, i === activeStep && styles.stepTitleActive]}>
                  {step.icon} {step.title}
                </Text>
                {i === activeStep && (
                  <Text style={styles.stepDesc}>{step.desc}</Text>
                )}
              </View>
            </TouchableOpacity>
          ))}
        </View>

        {/* Complete button */}
        <TouchableOpacity
          style={styles.completeBtn}
          onPress={() => setCompleted(true)}
          activeOpacity={0.85}
        >
          <LinearGradient colors={[Colors.sage, Colors.sageDark]} style={styles.completeBtnGrad}>
            <Ionicons name="checkmark-circle-outline" size={20} color={Colors.white} />
            <Text style={styles.completeBtnText}>Mark Session Complete</Text>
          </LinearGradient>
        </TouchableOpacity>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1, paddingHorizontal: Spacing.xl },
  completedSafe: { flex: 1, justifyContent: 'center', padding: Spacing.xl },
  closeBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.navyLight, alignItems: 'center', justifyContent: 'center', marginTop: Spacing.md, marginBottom: Spacing.xl },
  introContent: { flex: 1, alignItems: 'center', paddingTop: Spacing.lg },
  bigIcon: { width: 100, height: 100, borderRadius: 50, backgroundColor: Colors.violetPale, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.xl },
  bigIconText: { fontSize: 48 },
  introTitle: { fontSize: Typography.sizes['2xl'], fontWeight: Typography.weights.extrabold, color: Colors.white, textAlign: 'center', marginBottom: Spacing.md },
  introSub: { fontSize: Typography.sizes.base, color: Colors.slateLight, textAlign: 'center', lineHeight: 22, marginBottom: Spacing.xl },
  introSteps: { flexDirection: 'row', gap: Spacing.xl, marginBottom: Spacing.xl },
  introStep: { alignItems: 'center', gap: Spacing.xs },
  introStepIcon: { fontSize: 28 },
  introStepText: { fontSize: Typography.sizes.xs, color: Colors.slateLight, textAlign: 'center' },
  rewardsPreview: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm, backgroundColor: Colors.navyLight, borderRadius: Radii.lg, padding: Spacing.md, marginBottom: Spacing.xl },
  rewardsPreviewText: { flex: 1, fontSize: Typography.sizes.sm, color: Colors.slateLight, lineHeight: 18 },
  startBtn: { width: '100%', borderRadius: Radii.lg, overflow: 'hidden' },
  startBtnGrad: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, paddingVertical: Spacing.base },
  startBtnText: { fontSize: Typography.sizes.md, fontWeight: Typography.weights.bold, color: Colors.white },
  sessionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: Spacing.md, marginBottom: Spacing.xl },
  sessionTitle: { fontSize: Typography.sizes.base, fontWeight: Typography.weights.bold, color: Colors.white },
  livePill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Colors.rosePale, borderRadius: Radii.full, paddingHorizontal: Spacing.sm, paddingVertical: 3 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Colors.rose },
  liveText: { fontSize: 10, fontWeight: Typography.weights.bold, color: Colors.rose, letterSpacing: 1 },
  timerSection: { alignItems: 'center', marginBottom: Spacing.xl },
  timerWrap: { position: 'relative', width: 200, height: 200, alignItems: 'center', justifyContent: 'center' },
  timerCircleOuter: {
    width: 180, height: 180, borderRadius: 90,
    borderWidth: 8, borderColor: Colors.navyLight,
    alignItems: 'center', justifyContent: 'center',
  },
  timerCircleInner: { alignItems: 'center' },
  timerMins: { fontSize: 40, fontWeight: Typography.weights.extrabold, color: Colors.white, letterSpacing: -1 },
  timerLabel: { fontSize: Typography.sizes.xs, color: Colors.slateLight },
  timerArc: {
    position: 'absolute', width: 180, height: 180, borderRadius: 90,
    borderWidth: 8, borderLeftColor: 'transparent', borderBottomColor: 'transparent',
    borderRightColor: Colors.sage, borderTopColor: Colors.sage,
  },
  stepsCard: { backgroundColor: Colors.navyLight, borderRadius: Radii.xl, padding: Spacing.lg, marginBottom: Spacing.xl, gap: Spacing.md },
  stepsTitle: { fontSize: Typography.sizes.base, fontWeight: Typography.weights.bold, color: Colors.white, marginBottom: Spacing.sm },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.md },
  stepCheck: {
    width: 26, height: 26, borderRadius: 13,
    borderWidth: 2, borderColor: Colors.slate,
    alignItems: 'center', justifyContent: 'center',
  },
  stepCheckActive: { borderColor: Colors.violet, backgroundColor: 'rgba(139,92,246,0.2)' },
  stepCheckDone: { backgroundColor: Colors.sage, borderColor: Colors.sage },
  stepCheckNum: { fontSize: Typography.sizes.xs, fontWeight: Typography.weights.bold, color: Colors.slate },
  stepText: { flex: 1 },
  stepTitle: { fontSize: Typography.sizes.sm, fontWeight: Typography.weights.medium, color: Colors.slateLight },
  stepTitleActive: { color: Colors.white, fontWeight: Typography.weights.semibold },
  stepDesc: { fontSize: Typography.sizes.xs, color: Colors.slate, marginTop: 2, lineHeight: 16 },
  completeBtn: { borderRadius: Radii.lg, overflow: 'hidden' },
  completeBtnGrad: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, paddingVertical: Spacing.base },
  completeBtnText: { fontSize: Typography.sizes.md, fontWeight: Typography.weights.bold, color: Colors.white },
  completedCard: { backgroundColor: Colors.white, borderRadius: Radii.xl, padding: Spacing['2xl'], alignItems: 'center', ...Shadows.lg },
  completedEmoji: { fontSize: 72, marginBottom: Spacing.xl },
  completedTitle: { fontSize: Typography.sizes['2xl'], fontWeight: Typography.weights.extrabold, color: Colors.navy, textAlign: 'center', marginBottom: Spacing.md },
  completedDesc: { fontSize: Typography.sizes.base, color: Colors.slate, textAlign: 'center', lineHeight: 22, marginBottom: Spacing.xl },
  rewardRow: { flexDirection: 'row', width: '100%', backgroundColor: Colors.offWhite, borderRadius: Radii.lg, padding: Spacing.lg, marginBottom: Spacing.xl },
  rewardItem: { flex: 1, alignItems: 'center', gap: Spacing.sm },
  rewardIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  rewardEmoji: { fontSize: 22 },
  rewardLabel: { fontSize: Typography.sizes.xs, color: Colors.slate },
  rewardValue: { fontSize: Typography.sizes.sm, fontWeight: Typography.weights.bold, color: Colors.navy },
  rewardDivider: { width: 1, backgroundColor: Colors.fog, marginHorizontal: Spacing.md },
  doneBtn: { width: '100%', borderRadius: Radii.lg, overflow: 'hidden' },
  doneBtnGrad: { paddingVertical: Spacing.base, alignItems: 'center' },
  doneBtnText: { fontSize: Typography.sizes.md, fontWeight: Typography.weights.bold, color: Colors.navy },
});
