import { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import Toast from "react-native-toast-message";
import { Colors, Typography, Spacing, Radii, Shadows } from "../../utils/theme";

export default function SignupScreen() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");

  const handleSignup = () => {
    if (!name || !email || !password) {
      Toast.show({ type: "error", text1: "Please fill required fields" });
      return;
    }

    // TODO(Phase 1): create the account through the API
    // (POST /api/auth/signup). Until then no account is created.
    Toast.show({
      type: "info",
      text1: "Account creation is not available yet",
      text2: "Account sign-up is being added in the next phase.",
    });
  };

  return (
    <View style={styles.container}>
      {/* Light White/Mint Background Gradient */}
      <LinearGradient
        colors={[Colors.white, Colors.offWhite]}
        style={StyleSheet.absoluteFill}
      />
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1 }}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
          >
            <TouchableOpacity onPress={() => router.back()} style={styles.back}>
              <Ionicons
                name="arrow-back"
                size={22}
                color={Colors.greenDark || Colors.slate}
              />
            </TouchableOpacity>

            <View style={styles.header}>
              <Text style={styles.title}>Join the neighborhood</Text>
              <Text style={styles.subtitle}>
                Create your account in seconds
              </Text>
            </View>

            <View style={styles.card}>
              {[
                {
                  label: "Full Name *",
                  icon: "person-outline",
                  value: name,
                  set: setName,
                  placeholder: "Maria Abbas",
                  keyboard: "default" as const,
                },
                {
                  label: "Email *",
                  icon: "mail-outline",
                  value: email,
                  set: setEmail,
                  placeholder: "maria@example.com",
                  keyboard: "email-address" as const,
                },
                {
                  label: "Phone (optional)",
                  icon: "call-outline",
                  value: phone,
                  set: setPhone,
                  placeholder: "+92 300 0000000",
                  keyboard: "phone-pad" as const,
                },
                {
                  label: "Password *",
                  icon: "lock-closed-outline",
                  value: password,
                  set: setPassword,
                  placeholder: "Min. 8 characters",
                  keyboard: "default" as const,
                  secure: true,
                },
              ].map((field) => (
                <View key={field.label} style={styles.fieldGroup}>
                  <Text style={styles.label}>{field.label}</Text>
                  <View style={styles.inputRow}>
                    <Ionicons
                      name={field.icon as any}
                      size={18}
                      color={Colors.green || Colors.slate}
                    />
                    <TextInput
                      style={styles.input}
                      value={field.value}
                      onChangeText={field.set}
                      placeholder={field.placeholder}
                      placeholderTextColor={Colors.slate}
                      keyboardType={field.keyboard}
                      secureTextEntry={field.secure}
                      autoCapitalize={
                        field.keyboard === "email-address" ? "none" : "words"
                      }
                    />
                  </View>
                </View>
              ))}

              <View style={styles.terms}>
                <Ionicons
                  name="shield-checkmark-outline"
                  size={14}
                  color={Colors.green || Colors.sage}
                />
                <Text style={styles.termsText}>
                  By signing up, you agree to our Terms of Service and Privacy
                  Policy
                </Text>
              </View>

              <TouchableOpacity
                style={styles.btnPrimary}
                onPress={handleSignup}
                activeOpacity={0.85}
              >
                {/* Green Gradient Button */}
                <LinearGradient
                  colors={[
                    Colors.green || "#2e7d32",
                    Colors.greenDark || "#1b5e20",
                  ]}
                  style={styles.btnGrad}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                >
                  <Text style={styles.btnText}>Create Account</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>

            <View style={styles.loginRow}>
              <Text style={styles.loginText}>Already a member? </Text>
              <TouchableOpacity onPress={() => router.push("/auth/login")}>
                <Text style={styles.loginLink}>Sign in</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1 },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing["2xl"],
  },
  back: { marginTop: Spacing.md, marginBottom: Spacing.xl, width: 40 },
  header: { marginBottom: Spacing["2xl"] },
  title: {
    fontSize: Typography.sizes["2xl"],
    fontWeight: Typography.weights.extrabold,
    color: Colors.greenDark || "#1b5e20",
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: Typography.sizes.base,
    color: Colors.slate,
    marginTop: Spacing.xs,
  },
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
    color: Colors.greenDark || "#1b5e20",
    marginBottom: Spacing.xs,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: Colors.fog,
    borderRadius: Radii.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
    backgroundColor: Colors.offWhite,
    gap: Spacing.sm,
  },
  input: {
    flex: 1,
    fontSize: Typography.sizes.base,
    color: Colors.greenDark || "#1b5e20",
  },
  terms: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing.xs,
    marginBottom: Spacing.lg,
  },
  termsText: {
    flex: 1,
    fontSize: Typography.sizes.xs,
    color: Colors.slate,
    lineHeight: 16,
  },
  btnPrimary: { borderRadius: Radii.lg, overflow: "hidden" },
  btnGrad: { paddingVertical: Spacing.base, alignItems: "center" },
  btnText: {
    fontSize: Typography.sizes.md,
    fontWeight: Typography.weights.bold,
    color: Colors.white,
  },
  loginRow: {
    flexDirection: "row",
    justifyContent: "center",
    marginTop: Spacing.xl,
  },
  loginText: { color: Colors.slate, fontSize: Typography.sizes.base },
  loginLink: {
    color: Colors.green || "#2e7d32",
    fontWeight: Typography.weights.semibold,
    fontSize: Typography.sizes.base,
  },
});
