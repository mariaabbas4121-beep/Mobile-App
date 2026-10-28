import type { VerificationStatus } from '../auth/auth.types.js';

// What Supabase Auth itself says about a user's phone. Numbers are E.164.
export interface AuthPhoneState {
  userId: string;
  // The user's current phone in Auth, and when Auth confirmed it.
  phone: string | null;
  phoneConfirmedAt: string | null;
  // A requested change that is waiting for its OTP (Auth's `new_phone`).
  pendingPhone: string | null;
}

export interface PhoneAuthSettings {
  // Auth -> Sign In / Providers -> Phone is enabled.
  phoneEnabled: boolean;
  // Phone confirmation is off: Auth would accept a number without any OTP.
  autoconfirm: boolean;
}

// Supabase Auth operations for the phone-change flow. Implementations throw
// AppError with client-safe codes; OTPs and provider messages never escape.
export interface PhoneAuthProvider {
  getSettings(): Promise<PhoneAuthSettings>;
  // Reads the caller's Auth user with their own access token.
  getPhoneState(accessToken: string): Promise<AuthPhoneState>;
  // Asks Auth to change the caller's phone; Auth sends the OTP by SMS.
  // Throws AppError PHONE_IN_USE (never sent to clients) if another account
  // has the number.
  requestPhoneChange(accessToken: string, phone: string): Promise<AuthPhoneState>;
  // Checks the OTP with Auth. Resolves with the user Auth applied it to; the
  // session Auth issues is revoked before this returns.
  verifyPhoneChange(phone: string, code: string): Promise<{ userId: string }>;
}

export interface PhoneRecord {
  status: VerificationStatus;
  verifiedAt: string | null;
  // The verified number (null unless verified or since revoked).
  phone: string | null;
  phoneVerifiedAt: string | null;
  pendingPhone: string | null;
  otpSentAt: string | null;
}

export type PhoneFailureReason = 'invalid_or_expired_code' | 'account_mismatch' | 'auth_state_mismatch';

// Server-only persistence (secret key). Every method takes the user id from
// the validated token, never from the request.
export interface PhoneVerificationStore {
  get(userId: string): Promise<PhoneRecord>;
  // 0 = reserved, send now; otherwise seconds left in the cooldown.
  reserveSend(userId: string, cooldownSeconds: number): Promise<number>;
  releaseSend(userId: string): Promise<void>;
  markPending(userId: string, phone: string, resend: boolean): Promise<void>;
  // Throws AppError NO_PENDING_PHONE_VERIFICATION if no code was requested
  // for this number.
  complete(userId: string, phone: string, verifiedAt: string): Promise<void>;
  recordFailure(userId: string, reason: PhoneFailureReason): Promise<void>;
  revoke(userId: string): Promise<void>;
}

// What clients see. Numbers are masked.
export interface PhoneVerificationView {
  status: VerificationStatus;
  verifiedAt: string | null;
  phone: string | null;
  pendingPhone: string | null;
  // Earliest time the API will send another code (ISO), or null.
  resendAvailableAt: string | null;
  codeLength: number;
}
