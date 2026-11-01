import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { formatIssues } from '../middleware/validate.middleware.js';
import {
  LISTING_AVAILABILITY,
  LISTING_CATEGORIES,
  LISTING_CONDITIONS,
  LISTING_SORTS,
  type ImageContentType,
} from './listing.types.js';

// Limits match the column checks in 20261028120000_listings.sql.
const text = (min: number, max: number) =>
  z.string().trim().min(min, { error: `must be at least ${min} characters` }).max(max, { error: `must be at most ${max} characters` });

// Optional text fields: blank clears them.
const optionalText = (min: number, max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), text(min, max).nullable().optional());

const tags = z
  .array(z.string().trim().min(1).max(24, { error: 'must be at most 24 characters' }))
  .max(5, { error: 'at most 5 tags' })
  // Duplicates differing only in case add nothing.
  .transform((list) => [...new Map(list.map((t) => [t.toLowerCase(), t])).values()]);

const fields = {
  title: text(3, 80),
  description: text(10, 2000),
  category: z.enum(LISTING_CATEGORIES),
  condition: z.enum(LISTING_CONDITIONS),
  replacementValuePkr: z.number().int().min(0).max(10_000_000).nullable().optional(),
  borrowingTerms: optionalText(1, 1000),
  area: optionalText(2, 80),
  availability: z.enum(LISTING_AVAILABILITY),
  teachMeEnabled: z.boolean(),
  tags,
};

// Strict: unknown keys (an ownerId, archivedAt, ...) are rejected, not
// silently ignored. The owner always comes from the access token.
export const listingCreateBody = z
  .object({
    ...fields,
    availability: fields.availability.default('available'),
    teachMeEnabled: fields.teachMeEnabled.default(false),
    tags: fields.tags.default([]),
  })
  .strict();

export const listingUpdateBody = z
  .object(fields)
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, { error: 'provide at least one field to change' });

export type ListingCreateBody = z.infer<typeof listingCreateBody>;
export type ListingUpdateBody = z.infer<typeof listingUpdateBody>;

export const listingQuery = z.object({
  q: z.string().trim().max(100).optional().transform((v) => v || undefined),
  category: z.enum(LISTING_CATEGORIES).optional(),
  condition: z.enum(LISTING_CONDITIONS).optional(),
  availability: z.enum(LISTING_AVAILABILITY).optional(),
  // The only owner filter: the caller's own listings.
  owner: z.literal('me').optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  sort: z.enum(LISTING_SORTS).default('newest'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export type ListingQuery = z.infer<typeof listingQuery>;

const uuid = z.uuid({ error: 'must be a valid id' });

export const listingParams = z.object({ id: uuid });
export const listingImageParams = z.object({ id: uuid, imageId: uuid });

// For query strings and route params, which validateBody does not cover.
export function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw AppError.badRequest('VALIDATION_ERROR', 'Request validation failed', formatIssues(result.error));
  return result.data;
}

// --- Images ----------------------------------------------------------------

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_LISTING = 5;
export const IMAGE_CONTENT_TYPES: readonly ImageContentType[] = ['image/jpeg', 'image/png', 'image/webp'];

export const IMAGE_EXTENSIONS: Record<ImageContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// Identifies the format from the file's first bytes. The declared
// Content-Type must agree, so a renamed or mislabelled file is refused.
export function sniffImageType(data: Buffer): ImageContentType | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}
