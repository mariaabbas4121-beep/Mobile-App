// Phone number input for verification. Mirrors the backend's E.164 rule
// (backend/src/verification/phone.ts); the backend still validates.

export const E164 = /^\+[1-9][0-9]{7,14}$/;

export interface Country {
  iso: string;
  name: string;
  flag: string;
  dialCode: string; // digits, no "+"
  // National significant number length (without the trunk prefix).
  nationalLength: [min: number, max: number];
  // Domestic prefix people often type first ("0300..." in Pakistan).
  trunkPrefix?: string;
  example: string;
}

// Pakistan first: the initial market. Any other country can be entered as a
// full international number starting with "+".
export const COUNTRIES: Country[] = [
  { iso: 'PK', name: 'Pakistan', flag: '🇵🇰', dialCode: '92', nationalLength: [10, 10], trunkPrefix: '0', example: '300 1234567' },
  { iso: 'AE', name: 'United Arab Emirates', flag: '🇦🇪', dialCode: '971', nationalLength: [8, 9], trunkPrefix: '0', example: '50 123 4567' },
  { iso: 'SA', name: 'Saudi Arabia', flag: '🇸🇦', dialCode: '966', nationalLength: [9, 9], trunkPrefix: '0', example: '50 123 4567' },
  { iso: 'GB', name: 'United Kingdom', flag: '🇬🇧', dialCode: '44', nationalLength: [10, 10], trunkPrefix: '0', example: '7400 123456' },
  { iso: 'US', name: 'United States / Canada', flag: '🇺🇸', dialCode: '1', nationalLength: [10, 10], trunkPrefix: '1', example: '201 555 0123' },
  { iso: 'IN', name: 'India', flag: '🇮🇳', dialCode: '91', nationalLength: [10, 10], trunkPrefix: '0', example: '81234 56789' },
  { iso: 'BD', name: 'Bangladesh', flag: '🇧🇩', dialCode: '880', nationalLength: [10, 10], trunkPrefix: '0', example: '1812 345678' },
];

export const DEFAULT_COUNTRY = COUNTRIES[0] as Country;

export type PhoneParse = { ok: true; e164: string } | { ok: false; error: string };

// Turns what the user typed into E.164. A number starting with "+" or "00" is
// taken as already international and the selected country is ignored.
export function toE164(country: Country, raw: string): PhoneParse {
  const typed = raw.trim();
  if (!typed) return { ok: false, error: 'Enter your phone number.' };
  if (/[^\d\s\-().+]/.test(typed)) return { ok: false, error: 'Use digits only.' };

  const compact = typed.replace(/[\s\-().]/g, '');
  if (compact.startsWith('+') || compact.startsWith('00')) {
    const e164 = compact.startsWith('+') ? compact : `+${compact.slice(2)}`;
    return E164.test(e164)
      ? { ok: true, e164 }
      : { ok: false, error: 'Enter a full international number, for example +92 300 1234567.' };
  }

  let national = compact.replace(/\D/g, '');
  const [min, max] = country.nationalLength;
  if (country.trunkPrefix && national.length > max && national.startsWith(country.trunkPrefix)) {
    national = national.slice(country.trunkPrefix.length);
  }
  if (national.length < min || national.length > max) {
    return { ok: false, error: `Enter a valid ${country.name} number, for example ${country.example}.` };
  }
  const e164 = `+${country.dialCode}${national}`;
  return E164.test(e164) ? { ok: true, e164 } : { ok: false, error: `Enter a valid ${country.name} number.` };
}

// Same masking as the server, for numbers the app already holds.
export function maskPhone(e164: string): string {
  const head = e164.slice(0, 3);
  const hidden = Math.max(0, e164.length - head.length - 4);
  return `${head}${'•'.repeat(hidden)}${e164.slice(-4)}`;
}

// Keeps only digits, at most `length` of them (pasted codes often include
// spaces or the whole SMS text).
export function cleanCode(raw: string, length: number): string {
  return raw.replace(/\D/g, '').slice(0, length);
}

export function codeError(code: string, length: number): string | null {
  if (!code) return 'Enter the code from the text message.';
  if (code.length !== length) return `The code has ${length} digits.`;
  return null;
}

// Whole seconds until an ISO time, never negative.
export function secondsUntil(iso: string | null, nowMs: number = Date.now()): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - nowMs) / 1000)) : 0;
}
