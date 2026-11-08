import express, { Router, type Request } from 'express';
import type { AuthGateway } from '../auth/auth.types.js';
import { AppError } from '../lib/errors.js';
import { getAuth, requireAuth } from '../middleware/auth.middleware.js';
import { validateBody } from '../middleware/validate.middleware.js';
import type { HandoverLimiters } from '../middleware/rate-limit.middleware.js';
import { IMAGE_CONTENT_TYPES, MAX_IMAGE_BYTES, parseOrThrow, sniffImageType } from '../listings/listing.schemas.js';
import type { Caller, ImageContentType } from '../listings/listing.types.js';
import {
  authorizationCreateBody,
  authorizationParams,
  handoverConfirmBody,
  handoverParams,
  verifyCodeBody,
  type AuthorizationCreateBody,
  type HandoverConfirmBody,
} from '../handover/handover.schemas.js';
import type { HandoverService } from '../handover/handover.service.js';

export interface HandoverRouteDeps {
  gateway: AuthGateway;
  handovers: HandoverService;
  limiters: HandoverLimiters;
}

// Pickup of an accepted borrow request, mounted under /borrow-requests.
// Only the two participants can see anything (others get 404); the borrower
// authorizes, the lender verifies and confirms. Codes travel only in request
// bodies, never in URLs, so they do not reach access logs.
export function handoverRoutes({ gateway, handovers, limiters }: HandoverRouteDeps) {
  const router = Router();
  const authenticated = requireAuth(gateway);
  const caller = (req: Request): Caller => {
    const { user, accessToken } = getAuth(req);
    return { userId: user.id, accessToken };
  };

  router.get('/:id/handover', authenticated, async (req, res) => {
    const { id } = parseOrThrow(handoverParams, req.params);
    res.status(200).json({ success: true, data: { handover: await handovers.state(caller(req), id) } });
  });

  // The code is in this response only.
  router.post(
    '/:id/pickup-authorizations',
    authenticated,
    limiters.authorizePerUser,
    validateBody(authorizationCreateBody),
    async (req, res) => {
      const { id } = parseOrThrow(handoverParams, req.params);
      const created = await handovers.authorize(caller(req), id, req.body as AuthorizationCreateBody);
      res.status(201).json({ success: true, data: created });
    },
  );

  router.post('/:id/pickup-authorizations/:authorizationId/revoke', authenticated, async (req, res) => {
    const { id, authorizationId } = parseOrThrow(authorizationParams, req.params);
    res.status(200).json({ success: true, data: { authorization: await handovers.revoke(caller(req), id, authorizationId) } });
  });

  // Scanning only shows what the code authorizes; nothing changes.
  router.post('/:id/handover/verify', authenticated, limiters.verifyPerUser, validateBody(verifyCodeBody), async (req, res) => {
    const { id } = parseOrThrow(handoverParams, req.params);
    const { code } = req.body as { code: string };
    res.status(200).json({ success: true, data: { authorization: await handovers.verify(caller(req), id, code) } });
  });

  // The lender's explicit confirmation, recorded once.
  router.post('/:id/handover', authenticated, limiters.verifyPerUser, validateBody(handoverConfirmBody), async (req, res) => {
    const { id } = parseOrThrow(handoverParams, req.params);
    const handover = await handovers.confirm(caller(req), id, req.body as HandoverConfirmBody);
    res.status(201).json({ success: true, data: { handover } });
  });

  // Raw image body, like listing photos. Read only after authentication.
  router.post(
    '/:id/handover/photos',
    authenticated,
    limiters.photoUploadPerUser,
    express.raw({ type: [...IMAGE_CONTENT_TYPES], limit: MAX_IMAGE_BYTES }),
    async (req, res) => {
      const { id } = parseOrThrow(handoverParams, req.params);
      const declared = req.get('content-type')?.split(';')[0]?.trim().toLowerCase() as ImageContentType | undefined;
      if (!declared || !IMAGE_CONTENT_TYPES.includes(declared) || !Buffer.isBuffer(req.body)) {
        throw new AppError(415, 'UNSUPPORTED_IMAGE_TYPE', 'Upload a JPEG, PNG or WebP image');
      }
      const data = req.body as Buffer;
      if (data.length === 0) throw AppError.badRequest('EMPTY_IMAGE', 'The image is empty');
      if (sniffImageType(data) !== declared) {
        throw new AppError(415, 'UNSUPPORTED_IMAGE_TYPE', 'The file is not a valid image of the declared type');
      }
      const photo = await handovers.addPhoto(caller(req), id, { data, contentType: declared });
      res.status(201).json({ success: true, data: { photo } });
    },
  );

  return router;
}
