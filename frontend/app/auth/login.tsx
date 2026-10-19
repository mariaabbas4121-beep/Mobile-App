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
import { useApp } from "../../context/AppContext";
import { Colors, Typography, Spacing, Radii, Shadows } from "../../utils/theme";

export default function LoginScreen() {
  const router = useRouter();
  const { login } = useApp();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);

  const handleLogin = () => {
    if (!email || !password) {
      Toast.show({
        type: "error",
        text1: "Please fill all fields",
      });
      return;
    }

    // TODO(Phase 1): sign in through the API (POST /api/auth/login). Until
    // then no account is checked and the user is not signed in.
    Toast.show({
      type: "info",
      text1: "Sign-in is not available yet",
      text2: "Account sign-in is being added in the next phase.",
    });
  };

  // Development only: open the app with the local mock data. This is not a
  // sign-in; no credentials are checked and nothing is sent to a server.
  const exploreDemo = () => {
    login();
    router.replace("/(tabs)");
  };

  return (
    <View style={styles.container}>
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
            {/* Back */}
            <TouchableOpacity onPress={() => router.back()} style={styles.back}>
              <Ionicons
                name="arrow-back"
                size={22}
                color={Colors.greenDark || Colors.slate}
              />
            </TouchableOpacity>

            {/* Header */}
            <View style={styles.header}>
              <Text style={styles.title}>Welcome back</Text>
              <Text style={styles.subtitle}>
                Sign in to your NeighborShare account
              </Text>
            </View>

            {/* Card */}
            <View style={styles.card}>

              {/* Email */}
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Email</Text>
                <View style={styles.inputRow}>
                  <Ionicons name="mail-outline" size={18} color={Colors.green} />
                  <TextInput
                    style={styles.input}
                    value={email}
                    onChangeText={setEmail}
                    placeholder="you@example.com"
                    placeholderTextColor={Colors.slate}
                    keyboardType="email-address"
                    autoCapitalize="none"
                  />
                </View>
              </View>

              {/* Password */}
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Password</Text>
                <View style={styles.inputRow}>
                  <Ionicons name="lock-closed-outline" size={18} color={Colors.green} />
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    value={password}
                    onChangeText={setPassword}
                    placeholder="Your password"
                    placeholderTextColor={Colors.slate}
                    secureTextEntry={!showPass}
                  />
                  <TouchableOpacity onPress={() => setShowPass(!showPass)}>
                    <Ionicons
                      name={showPass ? "eye-off-outline" : "eye-outline"}
                      size={18}
                      color={Colors.green}
                    />
                  </TouchableOpacity>
                </View>
              </View>

              {/* Forgot */}
              <TouchableOpacity
                onPress={() => router.push("/auth/forgot-password")}
                style={styles.forgotRow}
              >
                <Text style={styles.forgot}>Forgot password?</Text>
              </TouchableOpacity>

              {/* Button */}
              <TouchableOpacity
                onPress={handleLogin}
                style={styles.btnPrimary}
              >
                <LinearGradient
                  colors={["#2e7d32", "#1b5e20"]}
                  style={styles.btnGrad}
                >
                  <Text style={styles.btnText}>Sign In</Text>
                </LinearGradient>
              </TouchableOpacity>

            </View>

            {/* Signup */}
            <View style={styles.signupRow}>
              <Text style={styles.signupText}>Don't have an account? </Text>
              <TouchableOpacity onPress={() => router.push("/auth/signup")}>
                <Text style={styles.signupLink}>Sign up</Text>
              </TouchableOpacity>
            </View>

            {__DEV__ && (
              <TouchableOpacity onPress={exploreDemo} style={styles.demoRow}>
                <Text style={styles.demoText}>
                  Development: explore with mock data
                </Text>
              </TouchableOpacity>
            )}

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
    paddingHorizontal: 20,
    paddingBottom: 30,
  },
  back: { marginTop: 10, marginBottom: 20 },
  header: { marginBottom: 30 },
  title: {
    fontSize: 28,
    fontWeight: "bold",
    color: "#1b5e20",
  },
  subtitle: {
    fontSize: 14,
    color: "#666",
    marginTop: 5,
  },
  card: {
    backgroundColor: "#fff",
    padding: 20,
    borderRadius: 16,
    elevation: 3,
  },
  fieldGroup: { marginBottom: 15 },
  label: { marginBottom: 5, fontWeight: "600", color: "#1b5e20" },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#ddd",
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  input: { flex: 1, padding: 10 },
  forgotRow: { alignItems: "flex-end", marginVertical: 10 },
  forgot: { color: "#2e7d32", fontWeight: "600" },
  btnPrimary: { borderRadius: 10, overflow: "hidden", marginTop: 10 },
  btnGrad: { padding: 14, alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "bold" },
  signupRow: {
    flexDirection: "row",
    justifyContent: "center",
    marginTop: 20,
  },
  signupText: { color: "#666" },
  signupLink: { color: "#2e7d32", fontWeight: "bold" },
  demoRow: { alignItems: "center", marginTop: 16 },
  demoText: { color: "#666", textDecorationLine: "underline" },
});