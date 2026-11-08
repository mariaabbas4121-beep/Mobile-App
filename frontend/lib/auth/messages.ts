import { isApiError } from '../api/client';
import { OAuthError } from './googleAuth';
import { SessionStorageError } from './sessionManager';

// User-facing text for API and OAuth failures. Decided by error code, never
// by the server's message, and never revealing whether an account exists.
export function errorMessage(err: unknown): string {
  if (err instanceof OAuthError) return err.message;
  if (err instanceof SessionStorageError) return 'Could not save your sign-in on this device. Please try again.';
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
    case 'INVALID_PHONE':
      return 'That phone number cannot be used. Check it and try again.';
    case 'PHONE_COUNTRY_NOT_SUPPORTED':
      return 'We cannot verify numbers from this country yet.';
    case 'PHONE_ALREADY_ON_ACCOUNT':
      return 'This number is already on your account but was not verified in NeighborShare. Use a different number or contact support.';
    case 'NO_PENDING_PHONE_VERIFICATION':
      return 'This code request is no longer active. Request a new code.';
    case 'OTP_INVALID_OR_EXPIRED':
      return 'That code is incorrect or has expired. Check it, or request a new code.';
    case 'PHONE_VERIFICATION_UNAVAILABLE':
      return 'Phone verification is not available right now. Please try again later.';
    case 'PHONE_VERIFICATION_NOT_CONFIGURED':
      // Retrying will not help until the server is set up; the app still works.
      return 'Phone verification is not set up yet. You can keep using NeighborShare and verify your phone later.';
    case 'SMS_DELIVERY_UNAVAILABLE':
      return 'We could not send a text message right now. Check the number, or try again later.';
    case 'LISTING_NOT_FOUND':
      return 'This item is no longer listed.';
    case 'LISTING_ARCHIVED':
      return 'This listing has been removed and can no longer be changed.';
    case 'INVALID_LISTING':
      return 'Some listing details were not accepted. Check them and try again.';
    case 'FORBIDDEN':
      return 'You do not have permission to do that.';
    case 'IMAGE_LIMIT_REACHED':
      return 'A listing can have at most 5 photos.';
    case 'UNSUPPORTED_IMAGE_TYPE':
    case 'EMPTY_IMAGE':
      return 'That photo could not be used. Choose a JPEG, PNG or WebP image.';
    case 'PAYLOAD_TOO_LARGE':
      return 'That photo is too large. Choose one under 5 MB.';
    case 'CANNOT_BORROW_OWN_LISTING':
      return 'You cannot borrow your own item.';
    case 'LISTING_NOT_BORROWABLE':
      return 'This item cannot be borrowed right now.';
    case 'DATES_UNAVAILABLE':
      return 'Those dates are already booked. Choose different dates.';
    case 'DUPLICATE_PENDING_REQUEST':
      return 'You already have a pending request for this item. Cancel it first to ask for different dates.';
    case 'INVALID_STATUS_TRANSITION':
      return 'This request has already been answered or cancelled.';
    case 'INVALID_DATES':
      return 'Those dates cannot be requested. Choose dates from today onwards.';
    case 'BORROW_REQUEST_NOT_FOUND':
      return 'This request no longer exists.';
    case 'INVALID_LOCATION':
      return 'That location could not be used. Choose it again.';
    case 'REQUEST_NOT_ACCEPTED':
      return 'Pickup is only possible once the owner accepts the request.';
    case 'ALREADY_HANDED_OVER':
      return 'This item has already been handed over.';
    case 'ACTIVE_AUTHORIZATION_EXISTS':
      return 'Someone is already authorized to collect this item. Revoke that first.';
    case 'AUTHORIZATION_NOT_ACTIVE':
      return 'This authorization is no longer active.';
    case 'INVALID_PICKUP_CODE':
      return 'This is not a valid pickup code for this item.';
    case 'AUTHORIZATION_REVOKED':
      return 'The borrower revoked this pickup authorization. Do not hand over the item.';
    case 'AUTHORIZATION_ALREADY_USED':
      return 'This pickup code has already been used.';
    case 'AUTHORIZATION_EXPIRED':
      return 'This pickup code has expired. Ask the borrower for a new one.';
    case 'HANDOVER_NOT_CONFIRMED':
      return 'Confirm the handover before adding photos.';
    case 'EVIDENCE_LIMIT_REACHED':
      return 'At most 5 condition photos can be added.';
    case 'EVIDENCE_WINDOW_CLOSED':
      return 'Condition photos can only be added within 24 hours of the handover.';
    case 'CONVERSATION_NOT_FOUND':
      return 'This conversation is not available.';
    case 'CHAT_NOT_AVAILABLE':
      return 'Chat opens once the owner accepts the borrow request.';
    case 'INVALID_MESSAGE':
      return 'Messages must be between 1 and 2000 characters.';
    case 'CLIENT_ID_REUSED':
      return 'This message could not be sent. Please type it again.';
    case 'STORAGE_NOT_CONFIGURED':
    case 'STORAGE_UNAVAILABLE':
      return 'Photo uploads are not available right now. Please try again later.';
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
