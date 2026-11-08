// The borrower's copy of a pickup code, so the QR can be shown or shared
// again until it is used. The server returns the code only once and keeps
// only its hash; this copy stays in the device's secure storage (Keychain /
// Keystore) and is deleted when the authorization ends. It is never logged.

export interface PickupCodeStore {
  save(authorizationId: string, code: string): Promise<void>;
  load(authorizationId: string): Promise<string | null>;
  remove(authorizationId: string): Promise<void>;
}

const key = (authorizationId: string) => `pickup-code.${authorizationId}`;

export function secureStorePickupCodes(): PickupCodeStore {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const SecureStore = require('expo-secure-store') as typeof import('expo-secure-store');
  return {
    save: (id, code) => SecureStore.setItemAsync(key(id), code),
    load: (id) => SecureStore.getItemAsync(key(id)).catch(() => null),
    remove: (id) => SecureStore.deleteItemAsync(key(id)).catch(() => undefined),
  };
}

export function memoryPickupCodes(): PickupCodeStore {
  const codes = new Map<string, string>();
  return {
    save: async (id, code) => void codes.set(id, code),
    load: async (id) => codes.get(id) ?? null,
    remove: async (id) => void codes.delete(id),
  };
}
