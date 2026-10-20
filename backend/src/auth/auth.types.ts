// Shapes returned by the API. They are built field by field from Supabase
// objects so provider internals (identities payloads, app_metadata, provider
// tokens) never reach a client.

export interface AuthUser {
  id: string;
  email: string | null;
  emailConfirmedAt: string | null;
  createdAt: string;
  lastSignInAt: string | null;
  providers: string[];
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  tokenType: 'bearer';
  expiresIn: number;
  expiresAt: number | null;
}

export type SignOutScope = 'local' | 'global' | 'others';

export type AccountStatus = 'active' | 'restricted' | 'suspended' | 'deletion_pending';
export type VerificationType = 'email' | 'phone' | 'identity';
export type VerificationStatus = 'not_started' | 'pending' | 'verified' | 'rejected' | 'expired' | 'revoked';

export interface Profile {
  id: string;
  displayName: string | null;
  city: string | null;
  neighborhood: string | null;
  bio: string | null;
  avatarPath: string | null;
  phoneVerifiedAt: string | null;
  profileCompletedAt: string | null;
  accountStatus: AccountStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Verification {
  type: VerificationType;
  status: VerificationStatus;
  verifiedAt: string | null;
  expiresAt: string | null;
  statusChangedAt: string;
}

// The identity of the caller of a protected route, established by
// requireAuth from a token Supabase has validated.
export interface AuthContext {
  user: AuthUser;
  accessToken: string;
  // From app_metadata.roles, which only the secret key can write. Used for
  // server-side authorization; never returned to clients.
  roles: string[];
}

export interface ProfileUpdate {
  displayName?: string | null | undefined;
  city?: string | null | undefined;
  neighborhood?: string | null | undefined;
  bio?: string | null | undefined;
}

// Supabase Auth operations the API uses. Implementations throw AppError with
// client-safe codes; raw provider errors never escape.
export interface AuthGateway {
  signUp(input: { email: string; password: string; displayName?: string | undefined }): Promise<{
    user: AuthUser | null;
    session: AuthSession | null;
  }>;
  signIn(input: { email: string; password: string }): Promise<{ user: AuthUser; session: AuthSession }>;
  refresh(refreshToken: string): Promise<{ user: AuthUser; session: AuthSession }>;
  resendSignupConfirmation(email: string): Promise<void>;
  // Validates the access token with the Supabase Auth server.
  getUser(accessToken: string): Promise<{ user: AuthUser; roles: string[] }>;
  signOut(accessToken: string, scope: SignOutScope): Promise<void>;
}

// Reads run with the caller's access token, so Row-Level Security applies.
export interface ProfileRepository {
  getProfile(accessToken: string, userId: string): Promise<Profile | null>;
  getVerifications(accessToken: string, userId: string): Promise<Verification[]>;
  // Returns null when Row-Level Security refused the update.
  updateProfile(accessToken: string, userId: string, changes: ProfileUpdate): Promise<Profile | null>;
}
