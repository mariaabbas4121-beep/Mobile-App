import { Router } from 'express';
import type { AuthGateway, ProfileRepository } from '../auth/auth.types.js';
import { getAuth, requireAuth } from '../middleware/auth.middleware.js';
import { requireAccountStatus } from '../middleware/account-status.middleware.js';
import { validateBody } from '../middleware/validate.middleware.js';
import type { PhoneLimiters } from '../middleware/rate-limit.middleware.js';
import {
  phoneConfirmBody,
  phoneResendBody,
  phoneStartBody,
  type PhoneConfirmBody,
  type PhoneStartBody,
} from '../verification/phone.js';
import type { PhoneVerificationService } from '../verification/phone-verification.service.js';

export interface VerificationRouteDeps {
  gateway: AuthGateway;
  profiles: ProfileRepository;
  phone: PhoneVerificationService;
  limiters: PhoneLimiters;
}

// Supabase reports only that it accepted the request; whether the SMS
// arrives is up to the carrier, so the wording never promises delivery.
const CODE_REQUESTED = 'If this number can receive text messages, a verification code is on its way.';

// Per-IP limits run first (before the token is checked with Supabase), the
// per-user limit after authentication, and the per-number limit after
// validation so it counts the normalised number.
export function verificationRoutes({ gateway, profiles, phone, limiters }: VerificationRouteDeps) {
  const router = Router();
  const authenticated = requireAuth(gateway);
  // Same rule as profile edits: suspended and deletion-pending accounts
  // cannot start or finish a verification. Reading the status is allowed.
  const inGoodStanding = requireAccountStatus(profiles, ['active', 'restricted']);
  const caller = (req: Parameters<typeof getAuth>[0]) => {
    const { user, accessToken } = getAuth(req);
    return { userId: user.id, accessToken };
  };

  router.get('/phone', authenticated, async (req, res) => {
    const verification = await phone.status(caller(req));
    res.status(200).json({ success: true, data: { verification } });
  });

  router.post(
    '/phone/start',
    limiters.startPerIp,
    authenticated,
    inGoodStanding,
    limiters.startPerAccount,
    validateBody(phoneStartBody),
    limiters.startPerPhone,
    async (req, res) => {
      const { phone: number } = req.body as PhoneStartBody;
      const { verification, sent } = await phone.start(caller(req), number);
      if (!sent) {
        res.status(200).json({ success: true, data: { verification, codeSent: false } });
        return;
      }
      res.status(202).json({ success: true, data: { verification, codeSent: true, message: CODE_REQUESTED } });
    },
  );

  router.post(
    '/phone/resend',
    limiters.resendPerIp,
    authenticated,
    inGoodStanding,
    limiters.resendPerAccount,
    validateBody(phoneResendBody),
    async (req, res) => {
      const { verification, sent } = await phone.resend(caller(req));
      if (!sent) {
        res.status(200).json({ success: true, data: { verification, codeSent: false } });
        return;
      }
      res.status(202).json({ success: true, data: { verification, codeSent: true, message: CODE_REQUESTED } });
    },
  );

  router.post(
    '/phone/confirm',
    limiters.confirmPerIp,
    authenticated,
    inGoodStanding,
    limiters.confirmPerAccount,
    validateBody(phoneConfirmBody),
    async (req, res) => {
      const { phone: number, code } = req.body as PhoneConfirmBody;
      const verification = await phone.confirm(caller(req), number, code);
      res.status(200).json({ success: true, data: { verification } });
    },
  );

  return router;
}
