// Pickup and return codes, as the backend issues them
// (backend/src/handover/pickup-code.ts): 32 Crockford base32 characters, in
// a QR as neighborshare://pickup?v=1&code=<CODE> or
// neighborshare://return?v=1&code=<CODE>. This only recognises a code before
// it is sent; the server decides whether it is valid.

export type CodeOperation = 'pickup' | 'return';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE = new RegExp(`^[${ALPHABET}]{32}$`);
const PREFIXES: Record<CodeOperation, string> = {
  pickup: 'neighborshare://pickup?',
  return: 'neighborshare://return?',
};

export function normalizePickupCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return CODE.test(s) ? s : null;
}

// A scanned QR or a typed code; null when it is not a NeighborShare code for
// this operation (a pickup QR is refused at a return, and vice versa).
export function codeFromScan(input: string, operation: CodeOperation = 'pickup'): string | null {
  const text = input.trim();
  const lower = text.toLowerCase();
  for (const [op, prefix] of Object.entries(PREFIXES)) {
    if (!lower.startsWith(prefix)) continue;
    if (op !== operation) return null;
    const params = new URLSearchParams(text.slice(prefix.length));
    if (params.get('v') !== '1') return null;
    return normalizePickupCode(params.get('code') ?? '');
  }
  return normalizePickupCode(text);
}

export const qrPayloadFor = (operation: CodeOperation, code: string) => `${PREFIXES[operation]}v=1&code=${code}`;

export const formatPickupCode = (code: string) => code.match(/.{1,4}/g)?.join('-') ?? code;
