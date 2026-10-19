import { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Toast from 'react-native-toast-message';
import { AppProvider, useApp } from '../context/AppContext';
import { Colors } from '../utils/theme';

function RootNavigator() {
  const { isLoggedIn } = useApp();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
  if (!segments.length) return; // ⛔ wait until router is ready

  const inAuth = segments[0] === 'auth';

  const timeout = setTimeout(() => {
    if (!isLoggedIn && !inAuth) {
      router.replace('/auth/welcome');
    } else if (isLoggedIn && inAuth) {
      router.replace('/(tabs)');
    }
  }, 50);

  return () => clearTimeout(timeout);
}, [isLoggedIn, segments]);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="auth" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="item/[id]" options={{ presentation: 'card' }} />
      <Stack.Screen name="qr/[txnId]" options={{ presentation: 'modal' }} />
      <Stack.Screen name="teach/[txnId]" options={{ presentation: 'modal' }} />
      <Stack.Screen name="lend/new" options={{ presentation: 'modal' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppProvider>
          <StatusBar style="light" />
          <RootNavigator />
          <Toast />
        </AppProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
