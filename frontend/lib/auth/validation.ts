// Client-side checks that mirror backend/src/auth/auth.schemas.ts exactly, so
// users see problems before a request is made. The backend still validates.

export const normaliseEmail = (email: string) => email.trim().toLowerCase();

// A deliberately looser check than the backend's (one @, no spaces, a dot in
// the domain). Anything the backend still rejects comes back as a
// VALIDATION_ERROR field issue and is shown on the email field.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function emailError(raw: string): string | null {
  const email = normaliseEmail(raw);
  if (!email) return 'Enter your email address.';
  if (email.length > 254) return 'Email address is too long.';
  if (!EMAIL.test(email)) return 'Enter a valid email address.';
  return null;
}

// UTF-8 byte length without relying on Buffer or TextEncoder.
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

// Signup policy: 8+ characters, a letter and a digit, at most 72 bytes
// (bcrypt's limit; longer passwords would be silently cut).
export function newPasswordErrors(password: string): string[] {
  const errors: string[] = [];
  if (password.length < 8) errors.push('Use at least 8 characters.');
  if (!/\p{L}/u.test(password) || !/\p{Nd}/u.test(password)) errors.push('Include at least one letter and one number.');
  if (utf8ByteLength(password) > 72) errors.push('Password is too long.');
  return errors;
}

export function displayNameError(raw: string, required: boolean): string | null {
  const name = raw.trim();
  if (!name) return required ? 'Enter your name.' : null;
  if (name.length < 2) return 'Name must be at least 2 characters.';
  if (name.length > 50) return 'Name must be at most 50 characters.';
  return null;
}

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

// Profile text fields (PATCH /profile/me): trimmed length range, no control characters.
export function profileTextError(raw: string, label: string, min: number, max: number, required: boolean): string | null {
  const value = raw.trim();
  if (!value) return required ? `Enter your ${label}.` : null;
  if (value.length < min) return `${capitalise(label)} must be at least ${min} characters.`;
  if (value.length > max) return `${capitalise(label)} must be at most ${max} characters.`;
  if (CONTROL.test(value)) return `${capitalise(label)} contains invalid characters.`;
  return null;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface SignupForm {
  displayName: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export type SignupErrors = Partial<Record<keyof SignupForm, string>>;

export function validateSignup(form: SignupForm): SignupErrors {
  const errors: SignupErrors = {};
  const name = displayNameError(form.displayName, true);
  if (name) errors.displayName = name;
  const email = emailError(form.email);
  if (email) errors.email = email;
  const password = newPasswordErrors(form.password);
  if (password.length) errors.password = password.join(' ');
  if (!form.confirmPassword) errors.confirmPassword = 'Confirm your password.';
  else if (form.confirmPassword !== form.password) errors.confirmPassword = 'Passwords do not match.';
  return errors;
}

export function validateLogin(form: { email: string; password: string }) {
  const errors: { email?: string; password?: string } = {};
  const email = emailError(form.email);
  if (email) errors.email = email;
  if (!form.password) errors.password = 'Enter your password.';
  else if (form.password.length > 1024) errors.password = 'Password is too long.';
  return errors;
}
