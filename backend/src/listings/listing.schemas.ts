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
  city: optionalText(2, 80),
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

// Nearby search radius, in kilometres.
export const MIN_RADIUS_KM = 0.5;
export const MAX_RADIUS_KM = 50;
export const DEFAULT_RADIUS_KM = 3;

// An empty value ("lat=") is absent, not 0.
const coordinate = (min: number, max: number) =>
  z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce
      .number({ error: 'must be a number' })
      .refine(Number.isFinite, { error: 'must be a number' })
      .min(min, { error: `must be between ${min} and ${max}` })
      .max(max, { error: `must be between ${min} and ${max}` })
      .optional(),
  );

export const listingQuery = z
  .object({
  q: z.string().trim().max(100).optional().transform((v) => v || undefined),
  category: z.enum(LISTING_CATEGORIES).optional(),
  condition: z.enum(LISTING_CONDITIONS).optional(),
  availability: z.enum(LISTING_AVAILABILITY).optional(),
  // The only owner filters: the caller's own listings ('me'), or everyone
  // else's ('others', for browsing; anonymous callers have none to hide).
  owner: z.enum(['me', 'others']).optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // Nearby: lat and lng together; radiusKm defaults to 3.
  lat: coordinate(-90, 90),
  lng: coordinate(-180, 180),
  radiusKm: z.coerce
    .number({ error: 'must be a number' })
    .min(MIN_RADIUS_KM, { error: `must be between ${MIN_RADIUS_KM} and ${MAX_RADIUS_KM}` })
    .max(MAX_RADIUS_KM, { error: `must be between ${MIN_RADIUS_KM} and ${MAX_RADIUS_KM}` })
    .optional(),
  // City-wide browsing; not combined with lat/lng.
  city: z.string().trim().min(2).max(80).optional(),
  // Defaults to 'distance' for nearby searches, 'newest' otherwise.
  sort: z.enum(LISTING_SORTS).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
})
  .superRefine((q, ctx) => {
    const near = q.lat !== undefined || q.lng !== undefined;
    if (near && (q.lat === undefined || q.lng === undefined)) {
      ctx.addIssue({ code: 'custom', path: [q.lat === undefined ? 'lat' : 'lng'], message: 'lat and lng must be sent together' });
    }
    if (q.radiusKm !== undefined && !near) ctx.addIssue({ code: 'custom', path: ['radiusKm'], message: 'needs lat and lng' });
    if (q.city !== undefined && near) ctx.addIssue({ code: 'custom', path: ['city'], message: 'use either city or lat/lng, not both' });
    if (q.sort === 'distance' && !near) ctx.addIssue({ code: 'custom', path: ['sort'], message: 'distance sorting needs lat and lng' });
  })
  .transform((q) => ({
    ...q,
    near:
      q.lat !== undefined && q.lng !== undefined
        ? { latitude: q.lat, longitude: q.lng, radiusKm: q.radiusKm ?? DEFAULT_RADIUS_KM }
        : undefined,
    sort: q.sort ?? (q.lat !== undefined ? ('distance' as const) : ('newest' as const)),
  }));

export type ListingQuery = z.infer<typeof listingQuery>;

// PUT /items/:id/location. Strict: nothing else is accepted.
export const pickupLocationBody = z
  .object({
    latitude: z.number({ error: 'must be a number' }).min(-90).max(90),
    longitude: z.number({ error: 'must be a number' }).min(-180).max(180),
  })
  .strict();

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
