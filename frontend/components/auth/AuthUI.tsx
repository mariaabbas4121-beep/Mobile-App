import React, { forwardRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type TextInputProps,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Radii, Shadows, Spacing, Typography } from '../../utils/theme';

// Shared building blocks for the authentication screens, in the visual
// language of the existing login and signup screens (white card, green
// gradient actions, Ionicons).

export function AuthScreen({ children, onBack }: { children: ReactNode; onBack?: () => void }) {
  return (
    <View style={styles.container}>
      <LinearGradient colors={[Colors.white, Colors.offWhite]} style={StyleSheet.absoluteFill} />
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.safe}>
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
            {onBack && (
              <TouchableOpacity
                onPress={onBack}
                style={styles.back}
                accessibilityRole="button"
                accessibilityLabel="Go back"
                hitSlop={12}
              >
                <Ionicons name="arrow-back" size={22} color={Colors.greenDark} />
              </TouchableOpacity>
            )}
            {children}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

export function AuthHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.header}>
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

export const Card = ({ children }: { children: ReactNode }) => <View style={styles.card}>{children}</View>;

interface FieldProps extends TextInputProps {
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  error?: string | undefined;
  hint?: string;
  password?: boolean;
}

export const Field = forwardRef<TextInput, FieldProps>(function Field(
  { label, icon, error, hint, password, ...input },
  ref,
) {
  const [visible, setVisible] = useState(false);
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.label} nativeID={`${label}-label`}>
        {label}
      </Text>
      <View style={[styles.inputRow, error ? styles.inputRowError : null]}>
        <Ionicons name={icon} size={18} color={Colors.green} />
        <TextInput
          ref={ref}
          style={styles.input}
          placeholderTextColor={Colors.slate}
          accessibilityLabel={label}
          accessibilityHint={hint}
          secureTextEntry={password && !visible}
          autoCorrect={false}
          {...input}
        />
        {password && (
          <TouchableOpacity
            onPress={() => setVisible((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={visible ? 'Hide password' : 'Show password'}
            hitSlop={10}
          >
            <Ionicons name={visible ? 'eye-off-outline' : 'eye-outline'} size={18} color={Colors.green} />
          </TouchableOpacity>
        )}
      </View>
      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite" accessibilityRole="alert">
          {error}
        </Text>
      ) : hint ? (
        <Text style={styles.hint}>{hint}</Text>
      ) : null}
    </View>
  );
});

export function PrimaryButton({ title, onPress, loading, disabled }: { title: string; onPress: () => void; loading?: boolean; disabled?: boolean }) {
  const inactive = loading || disabled;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={inactive}
      style={[styles.btnPrimary, inactive ? styles.btnInactive : null]}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
    >
      <LinearGradient colors={[Colors.green, Colors.greenDark]} style={styles.btnGrad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
        {loading ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.btnText}>{title}</Text>}
      </LinearGradient>
    </TouchableOpacity>
  );
}

export function SecondaryButton({ title, onPress, disabled, icon }: { title: string; onPress: () => void; disabled?: boolean; icon?: React.ComponentProps<typeof Ionicons>['name'] }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[styles.btnSecondary, disabled ? styles.btnInactive : null]}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!disabled }}
    >
      {icon ? <Ionicons name={icon} size={18} color={Colors.greenDark} /> : null}
      <Text style={styles.btnSecondaryText}>{title}</Text>
    </TouchableOpacity>
  );
}

export function GoogleButton({ onPress, loading, disabled }: { onPress: () => void; loading?: boolean; disabled?: boolean }) {
  const inactive = loading || disabled;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={inactive}
      style={[styles.btnGoogle, inactive ? styles.btnInactive : null]}
      accessibilityRole="button"
      accessibilityLabel="Continue with Google"
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
    >
      {loading ? (
        <ActivityIndicator color={Colors.greenDark} />
      ) : (
        <>
          <Ionicons name="logo-google" size={18} color="#DB4437" />
          <Text style={styles.btnGoogleText}>Continue with Google</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

export const Divider = ({ label }: { label: string }) => (
  <View style={styles.divider} accessible={false}>
    <View style={styles.dividerLine} />
    <Text style={styles.dividerText}>{label}</Text>
    <View style={styles.dividerLine} />
  </View>
);

export function Notice({ tone, children }: { tone: 'error' | 'info' | 'success'; children: ReactNode }) {
  const palette = {
    error: { bg: Colors.rosePale, fg: '#9F1239', icon: 'alert-circle-outline' as const },
    info: { bg: Colors.skyPale, fg: '#075985', icon: 'information-circle-outline' as const },
    success: { bg: '#e8f5e9', fg: Colors.greenDark, icon: 'checkmark-circle-outline' as const },
  }[tone];
  return (
    <View style={[styles.notice, { backgroundColor: palette.bg }]} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <Ionicons name={palette.icon} size={18} color={palette.fg} />
      <Text style={[styles.noticeText, { color: palette.fg }]}>{children}</Text>
    </View>
  );
}

export function LinkRow({ text, link, onPress }: { text: string; link: string; onPress: () => void }) {
  return (
    <View style={styles.linkRow}>
      <Text style={styles.linkText}>{text} </Text>
      <TouchableOpacity onPress={onPress} accessibilityRole="link" accessibilityLabel={link} hitSlop={8}>
        <Text style={styles.link}>{link}</Text>
      </TouchableOpacity>
    </View>
  );
}

export const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1 },
  scroll: { flexGrow: 1, paddingHorizontal: Spacing.xl, paddingBottom: Spacing['2xl'] },
  back: { marginTop: Spacing.md, marginBottom: Spacing.xl, width: 40 },
  header: { marginBottom: Spacing['2xl'], marginTop: Spacing.md },
  title: {
    fontSize: Typography.sizes['2xl'],
    fontWeight: Typography.weights.extrabold,
    color: Colors.greenDark,
    letterSpacing: -0.5,
  },
  subtitle: { fontSize: Typography.sizes.base, color: Colors.slate, marginTop: Spacing.xs, lineHeight: 22 },
  card: {
    backgroundColor: Colors.white,
    borderRadius: Radii.xl,
    padding: Spacing.xl,
    ...Shadows.lg,
    borderWidth: 1,
    borderColor: Colors.fog,
  },
  fieldGroup: { marginBottom: Spacing.base },
  label: {
    fontSize: Typography.sizes.sm,
    fontWeight: Typography.weights.semibold,
    color: Colors.greenDark,
    marginBottom: Spacing.xs,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: Colors.fog,
    borderRadius: Radii.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Platform.OS === 'ios' ? Spacing.md : Spacing.xs,
    backgroundColor: Colors.offWhite,
    gap: Spacing.sm,
  },
  inputRowError: { borderColor: Colors.rose },
  input: { flex: 1, fontSize: Typography.sizes.base, color: Colors.greenDark, minHeight: 24 },
  error: { color: '#BE123C', fontSize: Typography.sizes.sm, marginTop: Spacing.xs },
  hint: { color: Colors.slate, fontSize: Typography.sizes.xs, marginTop: Spacing.xs },
  btnPrimary: { borderRadius: Radii.lg, overflow: 'hidden', marginTop: Spacing.sm },
  btnInactive: { opacity: 0.6 },
  btnGrad: { paddingVertical: Spacing.base, alignItems: 'center', minHeight: 52, justifyContent: 'center' },
  btnText: { fontSize: Typography.sizes.md, fontWeight: Typography.weights.bold, color: Colors.white },
  btnSecondary: {
    flexDirection: 'row',
    gap: Spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: Colors.green,
    borderRadius: Radii.lg,
    paddingVertical: Spacing.md,
    marginTop: Spacing.md,
    minHeight: 48,
  },
  btnSecondaryText: { color: Colors.greenDark, fontWeight: Typography.weights.semibold, fontSize: Typography.sizes.base },
  btnGoogle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.white,
    borderWidth: 1.5,
    borderColor: Colors.fog,
    borderRadius: Radii.lg,
    minHeight: 52,
    ...Shadows.sm,
  },
  btnGoogleText: { color: Colors.navy, fontWeight: Typography.weights.semibold, fontSize: Typography.sizes.base },
  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: Spacing.lg, gap: Spacing.md },
  dividerLine: { flex: 1, height: 1, backgroundColor: Colors.fog },
  dividerText: { color: Colors.slate, fontSize: Typography.sizes.sm },
  notice: {
    flexDirection: 'row',
    gap: Spacing.sm,
    padding: Spacing.md,
    borderRadius: Radii.md,
    marginBottom: Spacing.base,
    alignItems: 'flex-start',
  },
  noticeText: { flex: 1, fontSize: Typography.sizes.sm, lineHeight: 20 },
  linkRow: { flexDirection: 'row', justifyContent: 'center', marginTop: Spacing.xl, flexWrap: 'wrap' },
  linkText: { color: Colors.slate, fontSize: Typography.sizes.base },
  link: { color: Colors.green, fontWeight: Typography.weights.semibold, fontSize: Typography.sizes.base },
});
