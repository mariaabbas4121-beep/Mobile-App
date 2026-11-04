import express, { Router, type Request } from 'express';
import type { AuthGateway, ProfileRepository } from '../auth/auth.types.js';
import { AppError } from '../lib/errors.js';
import { getAuth, optionalAuth, requireAuth } from '../middleware/auth.middleware.js';
import { getAccount, requireAccountStatus } from '../middleware/account-status.middleware.js';
import { validateBody } from '../middleware/validate.middleware.js';
import type { ListingLimiters } from '../middleware/rate-limit.middleware.js';
import {
  IMAGE_CONTENT_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_LISTING,
  listingCreateBody,
  listingImageParams,
  listingParams,
  listingQuery,
  listingUpdateBody,
  parseOrThrow,
  pickupLocationBody,
  sniffImageType,
  type ListingCreateBody,
  type ListingUpdateBody,
} from '../listings/listing.schemas.js';
import type { Caller, ImageContentType, Listing, ListingRepository } from '../listings/listing.types.js';

export interface ListingRouteDeps {
  gateway: AuthGateway;
  profiles: ProfileRepository;
  listings: ListingRepository;
  limiters: ListingLimiters;
}

const notFound = () => AppError.notFound('Listing not found', 'LISTING_NOT_FOUND');

const callerOf = (req: Request): Caller | null =>
  req.auth ? { userId: req.auth.user.id, accessToken: req.auth.accessToken } : null;

// Ownership is checked here so a non-owner gets a clear 403; Row-Level
// Security enforces the same rule again in the database.
async function ownedListing(listings: ListingRepository, caller: Caller, id: string): Promise<Listing> {
  const listing = await listings.get(caller, id);
  if (!listing) throw notFound();
  if (listing.owner.id !== caller.userId) throw AppError.forbidden('You can only change your own listings');
  return listing;
}

const refuseArchived = (listing: Listing) => {
  if (listing.archivedAt) throw AppError.conflict('LISTING_ARCHIVED', 'This listing has been archived and cannot be changed');
};

export function listingRoutes({ gateway, profiles, listings, limiters }: ListingRouteDeps) {
  const router = Router();
  const authenticated = requireAuth(gateway);
  // Publishing needs an account in full standing.
  const active = requireAccountStatus(profiles, ['active']);
  // Restricted accounts may still withdraw what they offer.
  const inGoodStanding = requireAccountStatus(profiles, ['active', 'restricted']);
  const caller = (req: Request): Caller => {
    const { user, accessToken } = getAuth(req);
    return { userId: user.id, accessToken };
  };

  // Public discovery. Signed-in callers may also list their own listings.
  router.get('/', optionalAuth(gateway), async (req, res) => {
    const query = parseOrThrow(listingQuery, req.query);
    const me = callerOf(req);
    if (query.owner === 'me' && !me) throw AppError.unauthenticated();
    const { items, total } = await listings.search(me, {
      q: query.q,
      category: query.category,
      condition: query.condition,
      availability: query.availability,
      ownerId: query.owner === 'me' ? me?.userId : undefined,
      // From the verified token only; the client merely asks for "others".
      excludeOwnerId: query.owner === 'others' ? me?.userId : undefined,
      // Archived listings only ever come back for the owner's own list.
      includeArchived: query.owner === 'me' && query.includeArchived,
      near: query.near,
      city: query.city,
      sort: query.sort,
      page: query.page,
      pageSize: query.pageSize,
    });
    res.status(200).json({
      success: true,
      data: {
        items,
        pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) },
        // Which kind of discovery these results are, so clients can label it.
        scope: query.near
          ? { mode: 'nearby', radiusKm: query.near.radiusKm }
          : query.city
            ? { mode: 'city', city: query.city }
            : { mode: 'all' },
      },
    });
  });

  router.get('/:id', optionalAuth(gateway), async (req, res) => {
    const { id } = parseOrThrow(listingParams, req.params);
    const listing = await listings.get(callerOf(req), id);
    if (!listing) throw notFound();
    res.status(200).json({ success: true, data: { listing } });
  });

  router.post('/', authenticated, active, limiters.createPerUser, validateBody(listingCreateBody), async (req, res) => {
    const listing = await listings.create(caller(req), req.body as ListingCreateBody);
    res.status(201).json({ success: true, data: { listing } });
  });

  router.patch('/:id', authenticated, inGoodStanding, validateBody(listingUpdateBody), async (req, res) => {
    const { id } = parseOrThrow(listingParams, req.params);
    const changes = req.body as ListingUpdateBody;
    if (getAccount(req).accountStatus === 'restricted' && Object.keys(changes).some((k) => k !== 'availability')) {
      throw AppError.forbidden('Only availability can be changed while your account is restricted', 'ACCOUNT_RESTRICTED');
    }
    const me = caller(req);
    refuseArchived(await ownedListing(listings, me, id));
    const listing = await listings.update(me, id, changes);
    // RLS matched no row: archived or status changed since the checks above.
    if (!listing) throw AppError.forbidden();
    res.status(200).json({ success: true, data: { listing } });
  });

  // Archives rather than deletes, so later borrow history keeps its listing.
  // Repeating it is harmless.
  router.delete('/:id', authenticated, inGoodStanding, async (req, res) => {
    const { id } = parseOrThrow(listingParams, req.params);
    const me = caller(req);
    const listing = await ownedListing(listings, me, id);
    if (!listing.archivedAt && !(await listings.archive(me, id))) throw AppError.forbidden();
    const archived = await listings.get(me, id);
    res.status(200).json({ success: true, data: { listing: archived } });
  });

  // The photo is the raw request body (Content-Type image/jpeg, image/png or
  // image/webp), not multipart. The body is read only after authentication.
  router.post(
    '/:id/images',
    authenticated,
    active,
    limiters.imageUploadPerUser,
    express.raw({ type: [...IMAGE_CONTENT_TYPES], limit: MAX_IMAGE_BYTES }),
    async (req, res) => {
      const { id } = parseOrThrow(listingParams, req.params);
      const declared = req.get('content-type')?.split(';')[0]?.trim().toLowerCase() as ImageContentType | undefined;
      if (!declared || !IMAGE_CONTENT_TYPES.includes(declared) || !Buffer.isBuffer(req.body)) {
        throw new AppError(415, 'UNSUPPORTED_IMAGE_TYPE', 'Upload a JPEG, PNG or WebP image');
      }
      const data = req.body as Buffer;
      if (data.length === 0) throw AppError.badRequest('EMPTY_IMAGE', 'The image is empty');
      if (sniffImageType(data) !== declared) {
        throw new AppError(415, 'UNSUPPORTED_IMAGE_TYPE', 'The file is not a valid image of the declared type');
      }

      const me = caller(req);
      const listing = await ownedListing(listings, me, id);
      refuseArchived(listing);
      if (listing.images.length >= MAX_IMAGES_PER_LISTING) {
        throw AppError.conflict('IMAGE_LIMIT_REACHED', 'A listing can have at most 5 photos');
      }
      const image = await listings.addImage(me, id, { data, contentType: declared });
      res.status(201).json({ success: true, data: { image } });
    },
  );

  // The precise pickup point, for the owner only (to edit it). Everyone else
  // sees only listing.approximateLocation.
  router.get('/:id/location', authenticated, async (req, res) => {
    const { id } = parseOrThrow(listingParams, req.params);
    const me = caller(req);
    await ownedListing(listings, me, id);
    res.status(200).json({ success: true, data: { location: await listings.getLocation(me, id) } });
  });

  // Sets where the item can be collected. Never set automatically: moving
  // around does not move a listing.
  router.put('/:id/location', authenticated, active, limiters.locationPerUser, validateBody(pickupLocationBody), async (req, res) => {
    const { id } = parseOrThrow(listingParams, req.params);
    const me = caller(req);
    refuseArchived(await ownedListing(listings, me, id));
    const location = await listings.setLocation(me, id, req.body as { latitude: number; longitude: number });
    const listing = await listings.get(me, id);
    res.status(200).json({ success: true, data: { location, listing } });
  });

  router.delete('/:id/location', authenticated, inGoodStanding, async (req, res) => {
    const { id } = parseOrThrow(listingParams, req.params);
    const me = caller(req);
    refuseArchived(await ownedListing(listings, me, id));
    await listings.clearLocation(me, id);
    res.status(204).end();
  });

  router.delete('/:id/images/:imageId', authenticated, inGoodStanding, async (req, res) => {
    const { id, imageId } = parseOrThrow(listingImageParams, req.params);
    const me = caller(req);
    await ownedListing(listings, me, id);
    if (!(await listings.removeImage(me, id, imageId))) throw AppError.notFound('Photo not found', 'IMAGE_NOT_FOUND');
    res.status(204).end();
  });

  return router;
}
