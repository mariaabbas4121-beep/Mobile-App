import * as ExpoCrypto from 'expo-crypto';
import { installCryptoPolyfill } from '../lib/auth/cryptoPolyfill';

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: jest.fn(async () => new Uint8Array([1, 2, 3]).buffer),
  getRandomValues: jest.fn((a: Uint8Array) => a.fill(7)),
}));

describe('crypto polyfill for PKCE', () => {
  test('adds subtle.digest (SHA-256) and getRandomValues when missing, so PKCE uses S256', async () => {
    const target: { crypto?: any } = {};
    installCryptoPolyfill(target);

    const hash = await target.crypto.subtle.digest('SHA-256', new Uint8Array([9]));
    expect(new Uint8Array(hash)).toEqual(new Uint8Array([1, 2, 3]));
    expect(ExpoCrypto.digest).toHaveBeenCalledWith('SHA-256', new Uint8Array([9]));
    expect(target.crypto.getRandomValues(new Uint8Array(2))).toEqual(new Uint8Array([7, 7]));
  });

  test('refuses other algorithms instead of silently weakening', async () => {
    const target: { crypto?: any } = {};
    installCryptoPolyfill(target);
    await expect(target.crypto.subtle.digest('SHA-1', new Uint8Array())).rejects.toThrow('Unsupported');
  });

  test('keeps an existing native implementation', () => {
    const native = { getRandomValues: jest.fn(), subtle: { digest: jest.fn() } };
    const target: { crypto?: any } = { crypto: native };
    installCryptoPolyfill(target);
    expect(target.crypto.subtle.digest).toBe(native.subtle.digest);
    expect(target.crypto.getRandomValues).toBe(native.getRandomValues);
  });
});
