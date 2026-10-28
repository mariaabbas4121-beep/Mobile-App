import { z } from 'zod';

// E.164: "+", a country code that does not start with 0, 8 to 15 digits in
// total. The same rule as the profiles.phone_e164 check constraint.
export const E164 = /^\+[1-9][0-9]{7,14}$/;

// Accepts common human formatting ("+92 300-123 4567", "(0092) 300...") and
// returns the bare E.164 form. Anything that is not a string is left for the
// schema to reject.
export function normalisePhone(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  let v = value.trim().replace(/[\s\-().]/g, '');
  if (v.startsWith('00')) v = `+${v.slice(2)}`;
  return v;
}

export const phoneSchema = z.preprocess(
  normalisePhone,
  z
    .string({ error: 'is required' })
    .max(16, { error: 'must be an international number such as +923001234567' })
    .regex(E164, { error: 'must be an international number such as +923001234567' }),
);

// Supabase SMS OTPs are 6 to 10 digits depending on the project setting.
export const otpSchema = z
  .string({ error: 'is required' })
  .trim()
  .regex(/^[0-9]{6,10}$/, { error: 'must be the 6 to 10 digit code from the SMS' });

// Strict: anything else (status, verified, userId, ...) is rejected with 400,
// so a client cannot try to set verification state.
export const phoneStartBody = z.strictObject({ phone: phoneSchema });
export const phoneResendBody = z.strictObject({});
export const phoneConfirmBody = z.strictObject({ phone: phoneSchema, code: otpSchema });

export type PhoneStartBody = z.infer<typeof phoneStartBody>;
export type PhoneConfirmBody = z.infer<typeof phoneConfirmBody>;

// Supabase Auth stores and returns phone numbers without the "+".
export function fromAuthPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const e164 = phone.startsWith('+') ? phone : `+${phone}`;
  return E164.test(e164) ? e164 : null;
}

// "+92•••••••4567": enough for the owner to recognise, little for anyone
// looking over their shoulder.
export function maskPhone(e164: string | null): string | null {
  if (!e164) return null;
  const visibleTail = 4;
  const head = e164.slice(0, 3);
  const hidden = Math.max(0, e164.length - head.length - visibleTail);
  return `${head}${'•'.repeat(hidden)}${e164.slice(-visibleTail)}`;
}

// Country calling codes are prefix-free, so a prefix match is exact.
export function hasAllowedCountryCode(e164: string, allowed: string[]): boolean {
  return allowed.length === 0 || allowed.some((code) => e164.startsWith(`+${code}`));
}
