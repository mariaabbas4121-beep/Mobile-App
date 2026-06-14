import { Tabs } from 'expo-router';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Typography, Shadows } from '../../utils/theme';
import { BlurView } from 'expo-blur';
import { Platform } from 'react-native';

type TabIconProps = { name: any; focused: boolean; label: string; badge?: number };

function TabIcon({ name, focused, label, badge }: TabIconProps) {
  // Set theme coloring based on active focused state
  const activeColor = '#1b5e20';
  const inactiveColor = Colors.slate || '#64748b';

  return (
    <View style={styles.tabItem}>
      <View style={[styles.iconWrap, focused && styles.iconWrapActive]}>
        <Ionicons name={name} size={22} color={focused ? activeColor : inactiveColor} />
        {badge ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badge}</Text>
          </View>
        ) : null}
      </View>
      <Text style={[styles.tabLabel, focused && styles.tabLabelActive]}>{label}</Text>
    </View>
  );
}

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: false,
        tabBarStyle: styles.tabBar,
        tabBarBackground: () =>
          Platform.OS === 'ios' ? (
            <BlurView intensity={90} tint="light" style={StyleSheet.absoluteFill} />
          ) : (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: Colors.white || '#ffffff' }]} />
          ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'grid' : 'grid-outline'} focused={focused} label="Browse" />
          ),
        }}
      />
      <Tabs.Screen
        name="map"
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'map' : 'map-outline'} focused={focused} label="Map" />
          ),
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'swap-horizontal' : 'swap-horizontal-outline'} focused={focused} label="Activity" badge={1} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon name={focused ? 'person' : 'person-outline'} focused={focused} label="Profile" />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    position: 'absolute',
    borderTopWidth: 1,
    borderTopColor: Colors.fog || '#e2e8f0',
    height: 84,
    backgroundColor: Platform.OS === 'ios' ? 'transparent' : Colors.white || '#ffffff',
    ...Shadows.md,
  },
  tabItem: { alignItems: 'center', paddingTop: 8 },
  iconWrap: {
    width: 44, 
    height: 32,
    borderRadius: 16,
    alignItems: 'center', 
    justifyContent: 'center',
  },
  iconWrapActive: {
    // Light Sage Green highlight background wrapper when tab is active
    backgroundColor: '#e8f5e9', 
  },
  tabLabel: {
    fontSize: 10,
    color: Colors.slate || '#64748b',
    fontWeight: '600',
    marginTop: 4,
  },
  tabLabelActive: { 
    color:'#1b5e20',
    fontWeight: '700',
  },
  badge: {
    position: 'absolute', 
    top: 0, 
    right: 6,
    width: 8, 
    height: 8, 
    borderRadius: 4,
    backgroundColor: '#ef4444', // Kept high-contrast crimson/rose for micro-badge alerts
  },
  badgeText: { display: 'none' },
});