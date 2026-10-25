import { useEffect } from 'react';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Toast from 'react-native-toast-message';
import { AppProvider } from '../context/AppContext';
import { AuthProvider, useAuth } from '../context/AuthContext';

// Keep the native splash screen up until the saved session has been checked,
// so neither the sign-in screens nor the app flash before the right one.
SplashScreen.preventAutoHideAsync().catch(() => undefined);

function RootNavigator() {
  const { phase, guards, sessionEndedNotice, acknowledgeSessionEnded } = useAuth();

  useEffect(() => {
    if (phase !== 'restoring') SplashScreen.hideAsync().catch(() => undefined);
  }, [phase]);

  useEffect(() => {
    if (!sessionEndedNotice) return;
    Toast.show({ type: 'info', text1: 'You have been signed out', text2: 'Your session ended. Please sign in again.' });
    acknowledgeSessionEnded();
  }, [sessionEndedNotice, acknowledgeSessionEnded]);

  // Exactly one group is open at a time (see lib/auth/routing.ts). When the
  // current screen's guard turns false, Expo Router moves to the first
  // screen that is allowed, so there is no redirect code to loop.
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={guards.auth}>
        <Stack.Screen name="auth" />
      </Stack.Protected>

      <Stack.Protected guard={guards.unreachable}>
        <Stack.Screen name="account/unreachable" />
      </Stack.Protected>

      <Stack.Protected guard={guards.blocked}>
        <Stack.Screen name="account/blocked" />
      </Stack.Protected>

      <Stack.Protected guard={guards.onboarding}>
        <Stack.Screen name="onboarding/profile" />
      </Stack.Protected>

      <Stack.Protected guard={guards.app}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="item/[id]" options={{ presentation: 'card' }} />
        <Stack.Screen name="qr/[txnId]" options={{ presentation: 'modal' }} />
        <Stack.Screen name="teach/[txnId]" options={{ presentation: 'modal' }} />
        <Stack.Screen name="lend/new" options={{ presentation: 'modal' }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <AppProvider>
            <StatusBar style="light" />
            <RootNavigator />
            <Toast />
          </AppProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
