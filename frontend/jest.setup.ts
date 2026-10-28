jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

// jest-expo 58 mocks `react-native/asset-registry`, but expo-asset reads
// AssetRegistry from React Native 0.88's main export, which bypasses that
// mock, so loading an icon font fails ("Module 1 is missing from the asset
// registry"). Tests do not need real fonts: report them as loaded.
jest.mock('expo-font', () => ({
  ...jest.requireActual('expo-font'),
  isLoaded: jest.fn(() => true),
  loadAsync: jest.fn(async () => undefined),
}));

// In-memory stand-in for the device keychain/keystore.
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    deleteItemAsync: jest.fn(async (k: string) => {
      store.delete(k);
    }),
    __store: store,
  };
});
