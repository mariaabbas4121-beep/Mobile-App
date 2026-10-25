import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type { Session } from '../api/types';

export interface TokenStorage {
  load(): Promise<Session | null>;
  save(session: Session): Promise<void>;
  clear(): Promise<void>;
}

// Separate entries keep each value well under SecureStore's size guidance.
const KEYS = {
  access: 'ns.auth.accessToken',
  refresh: 'ns.auth.refreshToken',
  meta: 'ns.auth.meta',
} as const;

// Keychain/Keystore, readable only while the device is unlocked, never
// included in backups or restored to another device.
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export function createSecureTokenStorage(): TokenStorage {
  return {
    async load() {
      const [accessToken, refreshToken, meta] = await Promise.all([
        SecureStore.getItemAsync(KEYS.access, OPTIONS),
        SecureStore.getItemAsync(KEYS.refresh, OPTIONS),
        SecureStore.getItemAsync(KEYS.meta, OPTIONS),
      ]);
      if (!accessToken || !refreshToken) return null;
      let parsed: { expiresIn?: number; expiresAt?: number | null } = {};
      try {
        parsed = meta ? JSON.parse(meta) : {};
      } catch {
        // Corrupt metadata: treat the token as expired so it is refreshed.
      }
      return {
        accessToken,
        refreshToken,
        tokenType: 'bearer',
        expiresIn: typeof parsed.expiresIn === 'number' ? parsed.expiresIn : 0,
        expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0,
      };
    },
    async save(session) {
      await Promise.all([
        SecureStore.setItemAsync(KEYS.access, session.accessToken, OPTIONS),
        SecureStore.setItemAsync(KEYS.refresh, session.refreshToken, OPTIONS),
        SecureStore.setItemAsync(KEYS.meta, JSON.stringify({ expiresIn: session.expiresIn, expiresAt: session.expiresAt }), OPTIONS),
      ]);
    },
    async clear() {
      await Promise.all(Object.values(KEYS).map((k) => SecureStore.deleteItemAsync(k, OPTIONS)));
    },
  };
}

// Expo web has no secure storage. Keep the session in memory only, so a page
// reload signs the user out instead of leaving tokens in localStorage.
export function createMemoryTokenStorage(): TokenStorage {
  let stored: Session | null = null;
  return {
    load: async () => stored,
    save: async (s) => {
      stored = s;
    },
    clear: async () => {
      stored = null;
    },
  };
}

export const createTokenStorage = (): TokenStorage =>
  Platform.OS === 'web' ? createMemoryTokenStorage() : createSecureTokenStorage();
