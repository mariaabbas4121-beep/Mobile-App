import type { Request, RequestHandler } from 'express';
import type { AuthContext, AuthGateway } from '../auth/auth.types.js';
import { AppError } from '../lib/errors.js';

// JWTs are three base64url segments; anything else is rejected before a
// network call is made.
const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const MAX_HEADER_LENGTH = 8192;

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

// Authenticates the caller from the Authorization header. The user id comes
// only from the token as validated by Supabase, never from the request body.
export function requireAuth(gateway: AuthGateway): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get('authorization');
    if (!header) {
      throw AppError.unauthenticated('Authentication required', 'UNAUTHENTICATED');
    }
    const match = header.length <= MAX_HEADER_LENGTH ? BEARER.exec(header) : null;
    if (!match?.[1]) {
      throw AppError.unauthenticated('Access token is invalid or expired', 'INVALID_TOKEN');
    }
    const accessToken = match[1];
    const { user, roles } = await gateway.getUser(accessToken);
    req.auth = { user, accessToken, roles };
    next();
  };
}

// Authorization for privileged routes. Mount after requireAuth. Roles live in
// Supabase app_metadata, which users cannot edit; anything in the request
// itself is ignored.
export function requireRole(role: string): RequestHandler {
  return (req, _res, next) => {
    if (!getAuth(req).roles.includes(role)) throw AppError.forbidden();
    next();
  };
}

// For handlers mounted behind requireAuth.
export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw new Error('getAuth called on a route without requireAuth');
  return req.auth;
}
