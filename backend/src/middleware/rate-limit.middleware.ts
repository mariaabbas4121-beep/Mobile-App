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
}

const MINUTE = 60_000;

export const DEFAULT_RATE_LIMITS: RateLimitPolicy = {
  signupPerIp: { windowMs: 60 * MINUTE, limit: 10 },
  loginPerIp: { windowMs: 15 * MINUTE, limit: 30 },
  loginFailuresPerAccount: { windowMs: 15 * MINUTE, limit: 5 },
  refreshPerIp: { windowMs: 15 * MINUTE, limit: 60 },
  resendPerIp: { windowMs: 60 * MINUTE, limit: 10 },
  resendPerAccount: { windowMs: 60 * MINUTE, limit: 3 },
};

// The limiter store keeps a hash, never the address itself.
const emailKey = (req: Request) => {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  const normalised = typeof email === 'string' ? email : '';
  return `acct:${createHash('sha256').update(normalised).digest('base64url')}`;
};

// IPv6 clients are grouped by /56 so one host cannot rotate addresses.
const ipKey = (req: Request) => `ip:${ipKeyGenerator(req.ip ?? 'unknown', 56)}`;

interface LimiterOptions {
  name: string;
  rule: LimitRule;
  key: 'ip' | 'account';
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
    keyGenerator: key === 'ip' ? ipKey : emailKey,
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
