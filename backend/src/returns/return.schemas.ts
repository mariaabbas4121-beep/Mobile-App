import { z } from 'zod';
import { isCalendarDate } from '../borrow/dates.js';
import { authorizationCreateBody } from '../handover/handover.schemas.js';
import { codeFromScan } from '../handover/pickup-code.js';

const uuid = z.uuid({ error: 'must be a valid id' });

export const returnParams = z.object({ id: uuid });
export const returnAuthorizationParams = z.object({ id: uuid, authorizationId: uuid });
export const extensionParams = z.object({ id: uuid, extensionId: uuid });

// Blank counts as absent.
const optional = <T extends z.ZodType<string, unknown>>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), schema.nullable().optional());
const text = (max: number) => optional(z.string().trim().max(max, { error: `must be at most ${max} characters` }));

// In person or by delivery/courier; "someone else" is a return authorization.
// Strict, and the borrower always comes from the token.
export const returnInitiateBody = z.discriminatedUnion('method', [
  z.object({ method: z.literal('personal'), confirm: z.literal(true) }).strict(),
  z
    .object({
      method: z.literal('delivery'),
      deliveryProvider: text(80),
      deliveryReference: text(80),
      deliveryNote: text(300),
      confirm: z.literal(true),
    })
    .strict(),
]);

// Same fields and rules as a pickup authorization.
export const returnAuthorizationBody = authorizationCreateBody;

// The scanned return QR text or the typed code. A pickup QR is refused here.
const returnCode = z
  .string()
  .max(200)
  .transform((v, ctx) => {
    const code = codeFromScan(v, 'return');
    if (!code) {
      ctx.addIssue({ code: 'custom', message: 'is not a NeighborShare return code' });
      return z.NEVER;
    }
    return code;
  });

export const returnVerifyBody = z.object({ code: returnCode }).strict();

// The lender's explicit confirmation of receipt.
export const returnConfirmBody = z.discriminatedUnion('method', [
  z.object({ method: z.literal('personal'), conditionNotes: text(1000), confirm: z.literal(true) }).strict(),
  z.object({ method: z.literal('delivery'), conditionNotes: text(1000), confirm: z.literal(true) }).strict(),
  z.object({ method: z.literal('authorized'), code: returnCode, conditionNotes: text(1000), confirm: z.literal(true) }).strict(),
]);

export const extensionRequestBody = z
  .object({
    requestedEndDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'must be a date in YYYY-MM-DD format' })
      .refine(isCalendarDate, { error: 'must be a real calendar date' }),
    reason: text(300),
  })
  .strict();

export type ReturnInitiateBody = z.infer<typeof returnInitiateBody>;
export type ReturnConfirmBody = z.infer<typeof returnConfirmBody>;
export type ExtensionRequestBody = z.infer<typeof extensionRequestBody>;
