import { z } from 'zod';
import { codeFromScan } from './pickup-code.js';

const uuid = z.uuid({ error: 'must be a valid id' });

export const handoverParams = z.object({ id: uuid });
export const authorizationParams = z.object({ id: uuid, authorizationId: uuid });

// Blank counts as absent.
const optional = <T extends z.ZodType<string, unknown>>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), schema.nullable().optional());

// Strict: the borrower, request and code are never taken from the body.
// `confirm: true` records that the borrower reviewed the details first.
export const authorizationCreateBody = z
  .object({
    recipientName: z.string().trim().min(2, { error: 'must be at least 2 characters' }).max(80, { error: 'must be at most 80 characters' }),
    // Spaces, dashes and brackets are dropped; 7-15 digits, optional "+".
    recipientPhone: optional(
      z
        .string()
        .transform((v) => v.replace(/[\s()-]/g, ''))
        .pipe(z.string().regex(/^\+?[0-9]{7,15}$/, { error: 'must be a phone number' })),
    ),
    note: optional(z.string().trim().max(200, { error: 'must be at most 200 characters' })),
    confirm: z.literal(true, { error: 'confirm the authorization first' }),
  })
  .strict();

// The scanned QR text or the typed code.
const pickupCode = z
  .string()
  .max(200)
  .transform((v, ctx) => {
    const code = codeFromScan(v);
    if (!code) {
      ctx.addIssue({ code: 'custom', message: 'is not a NeighborShare pickup code' });
      return z.NEVER;
    }
    return code;
  });

export const verifyCodeBody = z.object({ code: pickupCode }).strict();

// `confirm: true`: the lender explicitly confirmed after checking the item
// (and, for an authorized pickup, the person). Scanning alone never does it.
export const handoverConfirmBody = z
  .discriminatedUnion('method', [
    z.object({ method: z.literal('personal'), conditionNotes: optional(z.string().trim().max(1000)), confirm: z.literal(true) }).strict(),
    z
      .object({
        method: z.literal('authorized'),
        code: pickupCode,
        conditionNotes: optional(z.string().trim().max(1000)),
        confirm: z.literal(true),
      })
      .strict(),
  ]);

export type AuthorizationCreateBody = z.infer<typeof authorizationCreateBody>;
export type HandoverConfirmBody = z.infer<typeof handoverConfirmBody>;

export const MAX_HANDOVER_PHOTOS = 5;
