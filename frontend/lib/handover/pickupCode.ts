// Pickup codes, as the backend issues them (backend/src/handover/pickup-code.ts):
// 32 Crockford base32 characters, in a QR as
// neighborshare://pickup?v=1&code=<CODE>. This only recognises a code before
// it is sent; the server decides whether it is valid.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE = new RegExp(`^[${ALPHABET}]{32}$`);
const PREFIX = 'neighborshare://pickup?';

export function normalizePickupCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return CODE.test(s) ? s : null;
}

// A scanned QR or a typed code; null when it is not a NeighborShare pickup code.
export function codeFromScan(input: string): string | null {
  const text = input.trim();
  if (text.toLowerCase().startsWith(PREFIX)) {
    const params = new URLSearchParams(text.slice(PREFIX.length));
    if (params.get('v') !== '1') return null;
    return normalizePickupCode(params.get('code') ?? '');
  }
  return normalizePickupCode(text);
}

export const formatPickupCode = (code: string) => code.match(/.{1,4}/g)?.join('-') ?? code;
