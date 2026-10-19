import React from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  ImageBackground,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { SafeAreaView } from "react-native-safe-area-context";

const { width, height } = Dimensions.get("window");

const C = {
  white: "#FFFFFF",
  offWhite: "#F8FAF8",

  primary: "#22C55E",
  primaryDark: "#16A34A",
  primaryDeep: "#15803D",

  greenLight: "#DCFCE7",
  greenSoft: "#ECFDF3",

  forest: "#166534",
  forestDark: "#14532D",

  textDark: "#111827",
  textMid: "#6B7280",
  textLight: "rgba(255,255,255,0.9)",
};

const FEATURES = [
  {
    emoji: "📍",
    title: "Find It Nearby",
    desc: "Discover useful items shared by neighbors around you.",
    accent: "#22C55E",
  },
  {
    emoji: "🔐",
    title: "Safe Borrowing",
    desc: "QR-verified pickup and return verification.",
    accent: "#16A34A",
  },
  {
    emoji: "🎓",
    title: "Learn Together",
    desc: "Get guidance directly from item owners.",
    accent: "#15803D",
  },
];

const HERO_IMAGE =
  "https://images.unsplash.com/photo-1517457373958-b7bdd4587205?w=1200&q=80";

const AVATARS = [
  "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=100&q=80",
  "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=100&q=80",
  "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=100&q=80",
];

export default function WelcomeScreen() {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <ImageBackground source={{ uri: HERO_IMAGE }} style={styles.heroImageBg}>
        <LinearGradient
          colors={["rgba(0,0,0,0.45)", "rgba(0,0,0,0.15)", "#F8FAF8"]}
          style={StyleSheet.absoluteFill}
        />
      </ImageBackground>

      <SafeAreaView style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
        >
          {/* Logo */}

          <View style={styles.logoRow}>
            <View style={styles.logoBox}>
              <Text style={styles.logoEmoji}>🏘️</Text>
            </View>

            <Text style={styles.logoText}>NeighborShare</Text>
          </View>

          {/* Hero */}

          <View style={styles.heroSection}>
            <View style={styles.tag}>
              <Text style={styles.tagText}>COMMUNITY SHARING</Text>
            </View>

            <Text style={styles.heroTitle}>
              Borrow.
              {"\n"}
              Share.
              {"\n"}
              <Text style={styles.heroAccent}>Connect.</Text>
            </Text>

            <Text style={styles.heroSubtitle}>
              Save money, reduce waste, and build stronger connections with
              neighbors around you.
            </Text>
          </View>

          {/* Floating Badge */}

          <View style={styles.badge}>
            <Text style={styles.badgeText}>
              🌱 Save Money • Reduce Waste • Build Community
            </Text>
          </View>

          {/* Social Proof */}

          <View style={styles.socialRow}>
            <View style={styles.avatarStack}>
              {AVATARS.map((uri, index) => (
                <ImageBackground
                  key={index}
                  source={{ uri }}
                  style={[
                    styles.avatar,
                    {
                      marginLeft: index === 0 ? 0 : -12,
                      zIndex: 10 - index,
                    },
                  ]}
                  imageStyle={{ borderRadius: 18 }}
                />
              ))}
            </View>

            <Text style={styles.socialText}>
              <Text style={{ fontWeight: "800", color: C.textDark }}>
                1,200+
              </Text>{" "}
              trusted neighbors already sharing
            </Text>
          </View>

          {/* Stats */}

          <View style={styles.stats}>
            <View style={styles.stat}>
              <Text style={styles.statNumber}>8K+</Text>
              <Text style={styles.statLabel}>Items</Text>
            </View>

            <View style={styles.stat}>
              <Text style={styles.statNumber}>1.2K+</Text>
              <Text style={styles.statLabel}>Members</Text>
            </View>

            <View style={styles.stat}>
              <Text style={styles.statNumber}>99%</Text>
              <Text style={styles.statLabel}>Safe Returns</Text>
            </View>
          </View>

          {/* Features */}

          <View style={styles.cards}>
            {FEATURES.map((item) => (
              <View key={item.title} style={styles.card}>
                <View
                  style={[styles.accentBar, { backgroundColor: item.accent }]}
                />

                <View
                  style={[
                    styles.iconBox,
                    { backgroundColor: item.accent + "20" },
                  ]}
                >
                  <Text style={styles.cardEmoji}>{item.emoji}</Text>
                </View>

                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>{item.title}</Text>
                  <Text style={styles.cardDesc}>{item.desc}</Text>
                </View>
              </View>
            ))}
          </View>

          {/* Nearby Items */}

          <Text style={styles.sectionTitle}>Popular Near You</Text>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.itemsRow}
          >
            {[
              { emoji: "🔧", name: "Power Drill" },
              { emoji: "📽️", name: "Projector" },
              { emoji: "⛺", name: "Camping Tent" },
              { emoji: "🎸", name: "Guitar" },
            ].map((item) => (
              <View key={item.name} style={styles.itemCard}>
                <Text style={styles.itemEmoji}>{item.emoji}</Text>
                <Text style={styles.itemName}>{item.name}</Text>
                <Text style={styles.itemDistance}>Nearby</Text>
              </View>
            ))}
          </ScrollView>

          {/* CTA */}

          <TouchableOpacity
            activeOpacity={0.9}
            onPress={() => router.push("/auth/signup")}
          >
            <LinearGradient
              colors={[C.primary, C.primaryDark, C.primaryDeep]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryButtonText}>Get Started Free</Text>
            </LinearGradient>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => router.push("/auth/login")}
          >
            <Text style={styles.secondaryText}>I already have an account</Text>
          </TouchableOpacity>

          <Text style={styles.footer}>Trusted, local and community-first.</Text>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.offWhite,
  },

  heroImageBg: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: height * 0.52,
  },

  scroll: {
    paddingHorizontal: 22,
    paddingBottom: 40,
  },

  logoRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 10,
  },

  logoBox: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: C.primary,
    justifyContent: "center",
    alignItems: "center",
  },

  logoEmoji: {
    fontSize: 24,
  },

  logoText: {
    marginLeft: 12,
    fontSize: 20,
    fontWeight: "800",
    color: "#fff",
  },

  heroSection: {
    marginTop: height * 0.1,
  },

  tag: {
    alignSelf: "flex-start",
    backgroundColor: C.greenLight,
    borderRadius: 30,
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginBottom: 16,
  },

  tagText: {
    color: C.primaryDark,
    fontWeight: "800",
    fontSize: 11,
    letterSpacing: 1,
  },

  heroTitle: {
    fontSize: 52,
    fontWeight: "900",
    lineHeight: 56,
    color: "#fff",
  },

  heroAccent: {
    color: "#4ADE80",
  },

  heroSubtitle: {
    marginTop: 14,
    maxWidth: width * 0.78,
    fontSize: 16,
    lineHeight: 24,
    color: C.textLight,
  },

  badge: {
    alignSelf: "center",
    marginTop: 25,
    backgroundColor: "#fff",
    borderRadius: 50,
    paddingHorizontal: 18,
    paddingVertical: 10,
    elevation: 4,
  },

  badgeText: {
    color: C.forest,
    fontWeight: "700",
    fontSize: 12,
  },

  socialRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 24,
    marginBottom: 24,
  },

  avatarStack: {
    flexDirection: "row",
  },

  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: "#fff",
  },

  socialText: {
    marginLeft: 12,
    color: C.textMid,
    fontSize: 13,
  },

  stats: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: "#fff",
    borderRadius: 24,
    padding: 22,
    marginBottom: 22,

    shadowColor: "#22C55E",
    shadowOpacity: 0.08,
    shadowRadius: 14,
    shadowOffset: {
      width: 0,
      height: 8,
    },

    elevation: 4,
  },

  stat: {
    alignItems: "center",
  },

  statNumber: {
    fontSize: 22,
    fontWeight: "800",
    color: C.primaryDark,
  },

  statLabel: {
    marginTop: 4,
    color: C.textMid,
  },

  cards: {
    gap: 14,
    marginBottom: 26,
  },

  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 22,
    padding: 18,

    shadowColor: "#22C55E",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: {
      width: 0,
      height: 6,
    },

    elevation: 3,
  },

  accentBar: {
    position: "absolute",
    left: 0,
    top: 12,
    bottom: 12,
    width: 5,
    borderRadius: 5,
  },

  iconBox: {
    width: 52,
    height: 52,
    borderRadius: 16,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 14,
  },

  cardEmoji: {
    fontSize: 24,
  },

  cardTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: C.textDark,
    marginBottom: 4,
  },

  cardDesc: {
    color: C.textMid,
    lineHeight: 20,
  },

  sectionTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: C.textMid,
    marginBottom: 12,
    textTransform: "uppercase",
  },

  itemsRow: {
    paddingRight: 20,
    gap: 12,
    marginBottom: 30,
  },

  itemCard: {
    width: 120,
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 18,
    alignItems: "center",

    shadowColor: "#22C55E",
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: {
      width: 0,
      height: 5,
    },

    elevation: 3,
  },

  itemEmoji: {
    fontSize: 32,
    marginBottom: 8,
  },

  itemName: {
    fontWeight: "700",
    color: C.textDark,
    textAlign: "center",
  },

  itemDistance: {
    marginTop: 4,
    color: C.primary,
    fontSize: 12,
    fontWeight: "600",
  },

  primaryButton: {
    borderRadius: 22,
    paddingVertical: 18,
    alignItems: "center",
    marginBottom: 14,
  },

  primaryButtonText: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "800",
  },

  secondaryButton: {
    alignItems: "center",
  },

  secondaryText: {
    color: C.forest,
    fontSize: 15,
    fontWeight: "600",
  },

  footer: {
    marginTop: 20,
    textAlign: "center",
    color: C.textMid,
    fontSize: 12,
  },
});
