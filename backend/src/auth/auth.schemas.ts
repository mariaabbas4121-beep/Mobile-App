import { z } from 'zod';

const normaliseEmail = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v);

export const emailSchema = z.preprocess(
  normaliseEmail,
  z.email({ error: 'must be a valid email address' }).max(254, { error: 'must be at most 254 characters' }),
);

// Mirrors the Supabase project policy (minimum 8, letters and digits). The
// 72-byte cap is bcrypt's input limit; longer input would be silently cut.
export const newPasswordSchema = z
  .string({ error: 'is required' })
  .min(8, { error: 'must be at least 8 characters' })
  .refine((v) => Buffer.byteLength(v, 'utf8') <= 72, { error: 'must be at most 72 bytes' })
  .refine((v) => /\p{L}/u.test(v) && /\p{Nd}/u.test(v), { error: 'must contain at least one letter and one digit' });

// Login checks only presence and size: policy changes must not lock out
// accounts created under an older policy.
const existingPasswordSchema = z
  .string({ error: 'is required' })
  .min(1, { error: 'is required' })
  .max(1024, { error: 'is too long' });

export const signupBody = z.object({
  email: emailSchema,
  password: newPasswordSchema,
  displayName: z
    .string()
    .trim()
    .min(2, { error: 'must be at least 2 characters' })
    .max(50, { error: 'must be at most 50 characters' })
    .optional(),
});

export const loginBody = z.object({
  email: emailSchema,
  password: existingPasswordSchema,
});

export const refreshBody = z.object({
  refreshToken: z.string({ error: 'is required' }).min(1, { error: 'is required' }).max(2048),
});

export const resendConfirmationBody = z.object({
  email: emailSchema,
});

export const logoutBody = z.object({
  // local: this session; global: every session of the user; others: all but this one.
  scope: z.enum(['local', 'global', 'others']).default('local'),
});

export type SignupBody = z.infer<typeof signupBody>;
export type LoginBody = z.infer<typeof loginBody>;
export type RefreshBody = z.infer<typeof refreshBody>;
export type ResendConfirmationBody = z.infer<typeof resendConfirmationBody>;
export type LogoutBody = z.infer<typeof logoutBody>;
