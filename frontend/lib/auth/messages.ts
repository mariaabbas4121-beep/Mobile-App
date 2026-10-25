import { isApiError } from '../api/client';
import { OAuthError } from './googleAuth';

// User-facing text for API and OAuth failures. Decided by error code, never
// by the server's message, and never revealing whether an account exists.
export function errorMessage(err: unknown): string {
  if (err instanceof OAuthError) return err.message;
  if (!isApiError(err)) return 'Something went wrong. Please try again.';

  switch (err.code) {
    case 'INVALID_CREDENTIALS':
      return 'Incorrect email or password.';
    case 'EMAIL_NOT_CONFIRMED':
      return 'Please confirm your email address first.';
    case 'ACCOUNT_BLOCKED':
      return 'This account cannot sign in. Contact support if you think this is a mistake.';
    case 'RATE_LIMITED': {
      const wait = err.retryAfterSeconds;
      if (wait && wait < 120) return `Too many attempts. Try again in ${wait} seconds.`;
      if (wait) return `Too many attempts. Try again in about ${Math.ceil(wait / 60)} minutes.`;
      return 'Too many attempts. Please wait a little and try again.';
    }
    case 'WEAK_PASSWORD':
      return 'That password is too easy to guess. Choose a stronger one.';
    case 'INVALID_EMAIL':
      return 'That email address cannot be used. Check it and try again.';
    case 'SIGNUP_DISABLED':
      return 'New sign-ups are paused right now. Please try again later.';
    case 'EMAIL_DELIVERY_UNAVAILABLE':
      return 'We could not send email right now. Please try again later.';
    case 'NETWORK_ERROR':
      return 'Could not reach NeighborShare. Check your connection and try again.';
    case 'TIMEOUT':
      return 'The server took too long to respond. Please try again.';
    case 'NOT_CONFIGURED':
      return 'The app is not configured with a server address.';
    case 'AUTH_UNAVAILABLE':
    case 'DATABASE_UNAVAILABLE':
    case 'SERVER_NOT_CONFIGURED':
      return 'NeighborShare is temporarily unavailable. Please try again shortly.';
    case 'ACCOUNT_SUSPENDED':
      return 'Your account is suspended.';
    case 'ACCOUNT_DELETION_PENDING':
      return 'Your account is scheduled for deletion.';
    case 'ACCOUNT_RESTRICTED':
      return 'This is not available while your account is restricted.';
    case 'INVALID_TOKEN':
    case 'INVALID_REFRESH_TOKEN':
    case 'UNAUTHENTICATED':
      return 'Your session has ended. Please sign in again.';
    case 'VALIDATION_ERROR':
      return 'Please check the highlighted fields.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

// Maps backend field names in VALIDATION_ERROR details to form fields.
export function fieldErrorsFrom<F extends string>(err: unknown, fields: readonly F[]): Partial<Record<F, string>> {
  if (!isApiError(err) || err.code !== 'VALIDATION_ERROR') return {};
  const out: Partial<Record<F, string>> = {};
  for (const issue of err.fieldIssues) {
    const field = issue.field as F | null;
    if (field && fields.includes(field) && !out[field]) {
      out[field] = issue.message.charAt(0).toUpperCase() + issue.message.slice(1) + '.';
    }
  }
  return out;
}
