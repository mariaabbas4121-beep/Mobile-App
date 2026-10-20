import {
  isAuthError,
  isAuthRetryableFetchError,
  isAuthSessionMissingError,
  isAuthWeakPasswordError,
} from '@supabase/supabase-js';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

export type AuthOperation = 'signup' | 'login' | 'refresh' | 'resend' | 'get_user' | 'logout';

const UNAVAILABLE = () => AppError.unavailable('Authentication service is temporarily unavailable', 'AUTH_UNAVAILABLE');

// Translates a Supabase Auth error into a client-safe AppError. Only the
// error's code and HTTP status are inspected or logged; its message can
// contain the submitted email and is never forwarded.
export function mapAuthError(err: unknown, operation: AuthOperation, logger: Logger): AppError {
  if (err instanceof AppError) return err;

  if (isAuthRetryableFetchError(err)) {
    logger.warn({ operation, status: err.status }, 'auth provider unreachable');
    return UNAVAILABLE();
  }

  if (!isAuthError(err)) {
    logger.error({ operation, err }, 'unexpected auth failure');
    return new AppError(500, 'INTERNAL_ERROR', 'Internal server error');
  }

  // auth-js reports a signed-out or deleted session (server code
  // session_not_found) as this error class, with no code.
  if (isAuthSessionMissingError(err)) {
    return operation === 'refresh'
      ? AppError.unauthenticated('Refresh token is invalid or expired', 'INVALID_REFRESH_TOKEN')
      : AppError.unauthenticated('Access token is invalid or expired', 'INVALID_TOKEN');
  }

  const { code, status } = err;

  if (isAuthWeakPasswordError(err) || code === 'weak_password') {
    const reasons = isAuthWeakPasswordError(err) ? err.reasons : [];
    return new AppError(422, 'WEAK_PASSWORD', 'Password does not meet the security requirements', { reasons });
  }

  switch (code) {
    case 'invalid_credentials':
      return AppError.unauthenticated('Invalid email or password', 'INVALID_CREDENTIALS');
    case 'email_not_confirmed':
      return AppError.forbidden('Email address has not been confirmed yet', 'EMAIL_NOT_CONFIRMED');
    case 'user_banned':
      return AppError.forbidden('This account cannot sign in', 'ACCOUNT_BLOCKED');
    case 'user_already_exists':
    case 'email_exists':
      return AppError.conflict('EMAIL_ALREADY_REGISTERED', 'An account with this email already exists');
    case 'signup_disabled':
    case 'email_provider_disabled':
      return AppError.forbidden('Sign-up is currently disabled', 'SIGNUP_DISABLED');
    case 'email_address_invalid':
    case 'validation_failed':
      return AppError.badRequest('INVALID_EMAIL', 'Email address is not accepted');
    case 'over_email_send_rate_limit':
    case 'over_request_rate_limit':
      return AppError.rateLimited();
    case 'refresh_token_not_found':
    case 'refresh_token_already_used':
    case 'session_expired':
    case 'session_not_found':
      if (operation === 'refresh') {
        return AppError.unauthenticated('Refresh token is invalid or expired', 'INVALID_REFRESH_TOKEN');
      }
      return AppError.unauthenticated('Access token is invalid or expired', 'INVALID_TOKEN');
    case 'bad_jwt':
    case 'no_authorization':
    case 'user_not_found':
      return AppError.unauthenticated('Access token is invalid or expired', 'INVALID_TOKEN');
    case 'email_address_not_authorized':
      // Supabase's built-in mailer only sends to project team members.
      logger.error({ operation, code }, 'email delivery not configured: set up custom SMTP in Supabase');
      return AppError.unavailable('Email delivery is temporarily unavailable', 'EMAIL_DELIVERY_UNAVAILABLE');
  }

  if (operation === 'get_user' && (status === 401 || status === 403)) {
    return AppError.unauthenticated('Access token is invalid or expired', 'INVALID_TOKEN');
  }

  if (status === undefined || status >= 500) {
    logger.warn({ operation, code, status }, 'auth provider error');
    return UNAVAILABLE();
  }

  logger.warn({ operation, code, status }, 'unmapped auth provider error');
  return new AppError(502, 'AUTH_PROVIDER_ERROR', 'Authentication could not be completed');
}
