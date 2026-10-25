import * as ExpoCrypto from 'expo-crypto';

// React Native's JS engine has no WebCrypto. Without crypto.subtle, Supabase
// falls back to the insecure PKCE method "plain" (the code verifier itself is
// sent as the challenge). This provides exactly what it needs, backed by the
// platform's native crypto: SHA-256 digests and secure random values.
type CryptoLike = { getRandomValues?: Crypto['getRandomValues']; subtle?: Pick<SubtleCrypto, 'digest'> };

export function installCryptoPolyfill(target: { crypto?: unknown } = globalThis as { crypto?: unknown }) {
  const crypto = ((target.crypto as CryptoLike | undefined) ?? {}) as CryptoLike;

  if (typeof crypto.getRandomValues !== 'function') {
    crypto.getRandomValues = ((array: ArrayBufferView) =>
      ExpoCrypto.getRandomValues(array as Uint8Array)) as Crypto['getRandomValues'];
  }

  if (!crypto.subtle || typeof crypto.subtle.digest !== 'function') {
    crypto.subtle = {
      digest: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
        const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
        if (name.toUpperCase() !== 'SHA-256') throw new Error(`Unsupported digest algorithm: ${name}`);
        return ExpoCrypto.digest(ExpoCrypto.CryptoDigestAlgorithm.SHA256, data);
      },
    };
  }

  if (!target.crypto) target.crypto = crypto;
}
