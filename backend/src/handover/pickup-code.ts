import { createHash, randomBytes } from 'node:crypto';

// Pickup authorization codes.
//
// 20 bytes from the operating system's CSPRNG (160 bits), written as 32
// Crockford base32 characters, so the same code works in a QR and, as a
// fallback, typed by hand ("ABCD-EFGH-..."). Guessing one is infeasible; the
// verify endpoints are rate-limited as well.
//
// Only the SHA-256 of the normalized code is stored. A plain hash is enough
// for a random 160-bit secret (there is nothing to brute-force), and it lets
// the database find the authorization by an indexed lookup.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PICKUP_CODE_LENGTH = 32;
const CODE = new RegExp(`^[${ALPHABET}]{${PICKUP_CODE_LENGTH}}$`);

// The QR content: an app route, a format version and the code. No names,
// ids, tokens or locations.
export const PICKUP_QR_PREFIX = 'neighborshare://pickup';
export const PICKUP_QR_VERSION = 1;

export function generatePickupCode(): string {
  const bytes = randomBytes(20);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

// Accepts what a person may type or a scanner may read: lower case, dashes,
// spaces, and the look-alike letters Crockford base32 maps (I/L -> 1, O -> 0).
// Returns null for anything that cannot be a code.
export function normalizePickupCode(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  return CODE.test(s) ? s : null;
}

// Also takes the full QR text.
export function codeFromScan(input: string): string | null {
  const text = input.trim();
  if (text.toLowerCase().startsWith(`${PICKUP_QR_PREFIX}?`)) {
    const params = new URLSearchParams(text.slice(PICKUP_QR_PREFIX.length + 1));
    if (params.get('v') !== String(PICKUP_QR_VERSION)) return null;
    return normalizePickupCode(params.get('code') ?? '');
  }
  return normalizePickupCode(text);
}

export const hashPickupCode = (code: string) => createHash('sha256').update(code, 'utf8').digest('hex');

export const pickupQrPayload = (code: string) => `${PICKUP_QR_PREFIX}?v=${PICKUP_QR_VERSION}&code=${code}`;

// "ABCD-EFGH-..." for reading aloud or typing.
export const formatPickupCode = (code: string) => code.match(/.{1,4}/g)!.join('-');
