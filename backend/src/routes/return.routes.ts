import express, { Router, type Request, type Response } from 'express';
import type { AuthGateway } from '../auth/auth.types.js';
import { AppError } from '../lib/errors.js';
import { getAuth, requireAuth } from '../middleware/auth.middleware.js';
import { validateBody } from '../middleware/validate.middleware.js';
import type { ReturnLimiters } from '../middleware/rate-limit.middleware.js';
import { IMAGE_CONTENT_TYPES, MAX_IMAGE_BYTES, parseOrThrow, sniffImageType } from '../listings/listing.schemas.js';
import type { Caller, ImageContentType } from '../listings/listing.types.js';
import type { AuthorizationCreateBody } from '../handover/handover.schemas.js';
import {
  extensionParams,
  extensionRequestBody,
  returnAuthorizationBody,
  returnAuthorizationParams,
  returnConfirmBody,
  returnInitiateBody,
  returnParams,
  returnVerifyBody,
  type ExtensionRequestBody,
  type ReturnConfirmBody,
  type ReturnInitiateBody,
} from '../returns/return.schemas.js';
import type { ReturnService } from '../returns/return.service.js';

export interface ReturnRouteDeps {
  gateway: AuthGateway;
  returns: ReturnService;
  limiters: ReturnLimiters;
}

// Returns and due-date extensions, mounted under /borrow-requests. Only the
// two participants see anything (others get 404); the borrower initiates,
// authorizes and asks for more time; the lender verifies, confirms receipt
// and decides extensions. Codes travel only in request bodies.
export function returnRoutes({ gateway, returns, limiters }: ReturnRouteDeps) {
  const router = Router();
  const authenticated = requireAuth(gateway);
  const caller = (req: Request): Caller => {
    const { user, accessToken } = getAuth(req);
    return { userId: user.id, accessToken };
  };

  router.get('/:id/return', authenticated, async (req, res) => {
    const { id } = parseOrThrow(returnParams, req.params);
    res.status(200).json({ success: true, data: { return: await returns.state(caller(req), id) } });
  });

  // In person or by delivery. Repeating it updates the method.
  router.post('/:id/return', authenticated, validateBody(returnInitiateBody), async (req, res) => {
    const { id } = parseOrThrow(returnParams, req.params);
    res.status(200).json({ success: true, data: { return: await returns.initiate(caller(req), id, req.body as ReturnInitiateBody) } });
  });

  router.post(
    '/:id/return-authorizations',
    authenticated,
    limiters.authorizePerUser,
    validateBody(returnAuthorizationBody),
    async (req, res) => {
      const { id } = parseOrThrow(returnParams, req.params);
      res.status(201).json({ success: true, data: await returns.authorize(caller(req), id, req.body as AuthorizationCreateBody) });
    },
  );

  router.post('/:id/return-authorizations/:authorizationId/revoke', authenticated, async (req, res) => {
    const { id, authorizationId } = parseOrThrow(returnAuthorizationParams, req.params);
    res.status(200).json({ success: true, data: { authorization: await returns.revoke(caller(req), id, authorizationId) } });
  });

  // Scanning only shows who brings the item; nothing changes.
  router.post('/:id/return/verify', authenticated, limiters.verifyPerUser, validateBody(returnVerifyBody), async (req, res) => {
    const { id } = parseOrThrow(returnParams, req.params);
    const { code } = req.body as { code: string };
    res.status(200).json({ success: true, data: { authorization: await returns.verify(caller(req), id, code) } });
  });

  // The lender's explicit confirmation of receipt, recorded once.
  router.post('/:id/return/confirm', authenticated, limiters.verifyPerUser, validateBody(returnConfirmBody), async (req, res) => {
    const { id } = parseOrThrow(returnParams, req.params);
    const ret = await returns.confirm(caller(req), id, req.body as ReturnConfirmBody);
    res.status(201).json({ success: true, data: { return: ret } });
  });

  router.post(
    '/:id/return/photos',
    authenticated,
    limiters.photoUploadPerUser,
    express.raw({ type: [...IMAGE_CONTENT_TYPES], limit: MAX_IMAGE_BYTES }),
    async (req, res) => {
      const { id } = parseOrThrow(returnParams, req.params);
      const declared = req.get('content-type')?.split(';')[0]?.trim().toLowerCase() as ImageContentType | undefined;
      if (!declared || !IMAGE_CONTENT_TYPES.includes(declared) || !Buffer.isBuffer(req.body)) {
        throw new AppError(415, 'UNSUPPORTED_IMAGE_TYPE', 'Upload a JPEG, PNG or WebP image');
      }
      const data = req.body as Buffer;
      if (data.length === 0) throw AppError.badRequest('EMPTY_IMAGE', 'The image is empty');
      if (sniffImageType(data) !== declared) {
        throw new AppError(415, 'UNSUPPORTED_IMAGE_TYPE', 'The file is not a valid image of the declared type');
      }
      res.status(201).json({ success: true, data: { photo: await returns.addPhoto(caller(req), id, { data, contentType: declared }) } });
    },
  );

  router.post('/:id/extensions', authenticated, limiters.extensionPerUser, validateBody(extensionRequestBody), async (req, res) => {
    const { id } = parseOrThrow(returnParams, req.params);
    const extension = await returns.requestExtension(caller(req), id, req.body as ExtensionRequestBody);
    res.status(201).json({ success: true, data: { extension } });
  });

  const decide = (decision: 'approved' | 'rejected') => async (req: Request, res: Response) => {
    const { id, extensionId } = parseOrThrow(extensionParams, req.params);
    res.status(200).json({ success: true, data: { extension: await returns.decideExtension(caller(req), id, extensionId, decision) } });
  };
  router.post('/:id/extensions/:extensionId/approve', authenticated, decide('approved'));
  router.post('/:id/extensions/:extensionId/reject', authenticated, decide('rejected'));

  return router;
}
