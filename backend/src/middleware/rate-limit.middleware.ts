import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit, type Store } from 'express-rate-limit';
import { AppError } from '../lib/errors.js';

export interface LimitRule {
  windowMs: number;
  limit: number;
}

// Per-IP limits stop one client hammering an endpoint; per-account limits
// stop credential stuffing against one email from many IPs.
export interface RateLimitPolicy {
  signupPerIp: LimitRule;
  loginPerIp: LimitRule;
  loginFailuresPerAccount: LimitRule;
  refreshPerIp: LimitRule;
  resendPerIp: LimitRule;
  resendPerAccount: LimitRule;
  // Phone verification. "Account" is the signed-in user; "phone" is the
  // destination number, so many accounts cannot flood one person with SMS.
  phoneStartPerIp: LimitRule;
  phoneStartPerAccount: LimitRule;
  phoneStartPerPhone: LimitRule;
  phoneResendPerIp: LimitRule;
  phoneResendPerAccount: LimitRule;
  phoneConfirmPerIp: LimitRule;
  phoneConfirmPerAccount: LimitRule;
}

const MINUTE = 60_000;

export const DEFAULT_RATE_LIMITS: RateLimitPolicy = {
  signupPerIp: { windowMs: 60 * MINUTE, limit: 10 },
  loginPerIp: { windowMs: 15 * MINUTE, limit: 30 },
  loginFailuresPerAccount: { windowMs: 15 * MINUTE, limit: 5 },
  refreshPerIp: { windowMs: 15 * MINUTE, limit: 60 },
  resendPerIp: { windowMs: 60 * MINUTE, limit: 10 },
  resendPerAccount: { windowMs: 60 * MINUTE, limit: 3 },
  phoneStartPerIp: { windowMs: 60 * MINUTE, limit: 10 },
  phoneStartPerAccount: { windowMs: 60 * MINUTE, limit: 5 },
  phoneStartPerPhone: { windowMs: 60 * MINUTE, limit: 5 },
  phoneResendPerIp: { windowMs: 60 * MINUTE, limit: 10 },
  phoneResendPerAccount: { windowMs: 60 * MINUTE, limit: 5 },
  phoneConfirmPerIp: { windowMs: 15 * MINUTE, limit: 30 },
  phoneConfirmPerAccount: { windowMs: 15 * MINUTE, limit: 10 },
};

const hashKey = (prefix: string, value: string) => `${prefix}:${createHash('sha256').update(value).digest('base64url')}`;

// The limiter store keeps a hash, never the address itself.
const emailKey = (req: Request) => {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return hashKey('acct', typeof email === 'string' ? email : '');
};

// Mounted after requireAuth: the id comes from the validated token.
const userKey = (req: Request) => hashKey('user', req.auth?.user.id ?? '');

// Mounted after validation, so the number is already in E.164 form and
// "+92 300..." and "0092300..." count as the same destination.
const phoneKey = (req: Request) => {
  const phone = (req.body as { phone?: unknown } | undefined)?.phone;
  return hashKey('phone', typeof phone === 'string' ? phone : '');
};

const KEYS = { account: emailKey, user: userKey, phone: phoneKey } as const;

// IPv6 clients are grouped by /56 so one host cannot rotate addresses.
const ipKey = (req: Request) => `ip:${ipKeyGenerator(req.ip ?? 'unknown', 56)}`;

interface LimiterOptions {
  name: string;
  rule: LimitRule;
  key: 'ip' | keyof typeof KEYS;
  skipSuccessfulRequests?: boolean;
  // Separate store per limiter (each has its own window). Defaults to memory.
  store?: Store;
}

// In-memory counters are per process. Running several API instances needs a
// shared store (e.g. Redis) for these limits to hold across instances.
export function createLimiter({ name, rule, key, skipSuccessfulRequests = false, store }: LimiterOptions): RequestHandler {
  return rateLimit({
    windowMs: rule.windowMs,
    limit: rule.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests,
    identifier: name,
    // Account limits deliberately ignore the IP so they hold across many IPs.
    keyGenerator: key === 'ip' ? ipKey : KEYS[key],
    ...(store ? { store } : {}),
    handler: (_req, _res, next) => next(AppError.rateLimited()),
  });
}

export interface AuthLimiters {
  signupPerIp: RequestHandler;
  loginPerIp: RequestHandler;
  loginFailuresPerAccount: RequestHandler;
  refreshPerIp: RequestHandler;
  resendPerIp: RequestHandler;
  resendPerAccount: RequestHandler;
}

export function createAuthLimiters(policy: RateLimitPolicy = DEFAULT_RATE_LIMITS): AuthLimiters {
  return {
    signupPerIp: createLimiter({ name: 'signup-ip', rule: policy.signupPerIp, key: 'ip' }),
    loginPerIp: createLimiter({ name: 'login-ip', rule: policy.loginPerIp, key: 'ip' }),
    // Counts only failed logins, so a user who signs in successfully is never
    // locked out by their own activity.
    loginFailuresPerAccount: createLimiter({
      name: 'login-account',
      rule: policy.loginFailuresPerAccount,
      key: 'account',
      skipSuccessfulRequests: true,
    }),
    refreshPerIp: createLimiter({ name: 'refresh-ip', rule: policy.refreshPerIp, key: 'ip' }),
    resendPerIp: createLimiter({ name: 'resend-ip', rule: policy.resendPerIp, key: 'ip' }),
    resendPerAccount: createLimiter({ name: 'resend-account', rule: policy.resendPerAccount, key: 'account' }),
  };
}

export interface PhoneLimiters {
  startPerIp: RequestHandler;
  startPerAccount: RequestHandler;
  startPerPhone: RequestHandler;
  resendPerIp: RequestHandler;
  resendPerAccount: RequestHandler;
  confirmPerIp: RequestHandler;
  confirmPerAccount: RequestHandler;
}

// Separate from the email limits: phone verification never consumes a
// sign-in or signup allowance, and vice versa. These cap attempts per hour;
// the per-user resend cooldown between SMS is enforced in the database.
export function createPhoneLimiters(policy: RateLimitPolicy = DEFAULT_RATE_LIMITS): PhoneLimiters {
  return {
    startPerIp: createLimiter({ name: 'phone-start-ip', rule: policy.phoneStartPerIp, key: 'ip' }),
    startPerAccount: createLimiter({ name: 'phone-start-user', rule: policy.phoneStartPerAccount, key: 'user' }),
    startPerPhone: createLimiter({ name: 'phone-start-phone', rule: policy.phoneStartPerPhone, key: 'phone' }),
    resendPerIp: createLimiter({ name: 'phone-resend-ip', rule: policy.phoneResendPerIp, key: 'ip' }),
    resendPerAccount: createLimiter({ name: 'phone-resend-user', rule: policy.phoneResendPerAccount, key: 'user' }),
    confirmPerIp: createLimiter({ name: 'phone-confirm-ip', rule: policy.phoneConfirmPerIp, key: 'ip' }),
    confirmPerAccount: createLimiter({ name: 'phone-confirm-user', rule: policy.phoneConfirmPerAccount, key: 'user' }),
  };
}
