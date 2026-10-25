import { ApiError, isApiError, type ApiClient } from '../api/client';
import type { LogoutScope, Session } from '../api/types';
import type { TokenStorage } from './tokenStorage';

// Refresh a little before expiry so requests do not race the deadline.
const EXPIRY_MARGIN_SECONDS = 60;

export type SessionEvent = 'changed' | 'expired';

// The single owner of the session for the whole app. Every token refresh in
// the app happens here, and concurrent refreshes share one request, because
// Supabase rotates refresh tokens and a second refresh with the old token
// would fail.
export class SessionManager {
  private session: Session | null = null;
  private refreshing: Promise<Session> | null = null;
  private readonly listeners = new Set<(event: SessionEvent) => void>();

  constructor(
    private readonly api: ApiClient,
    private readonly storage: TokenStorage,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  get current(): Session | null {
    return this.session;
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SessionEvent) {
    for (const l of this.listeners) l(event);
  }

  async restore(): Promise<Session | null> {
    try {
      this.session = await this.storage.load();
    } catch {
      // Unreadable storage (e.g. keychain reset): start signed out.
      this.session = null;
      await this.storage.clear().catch(() => undefined);
    }
    return this.session;
  }

  async setSession(session: Session): Promise<void> {
    this.session = session;
    await this.storage.save(session);
    this.emit('changed');
  }

  async clear(): Promise<void> {
    this.session = null;
    this.refreshing = null;
    await this.storage.clear().catch(() => undefined);
    this.emit('changed');
  }

  private isExpiring(session: Session): boolean {
    if (!session.expiresAt) return true;
    return session.expiresAt - EXPIRY_MARGIN_SECONDS <= this.nowSeconds();
  }

  // Exchanges the refresh token for a new session. If the server says the
  // refresh token is no longer valid, the session has ended: it is cleared
  // and 'expired' is emitted. Network and server errors leave it in place.
  refresh(): Promise<Session> {
    if (this.refreshing) return this.refreshing;
    const session = this.session;
    if (!session) return Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'Not signed in.'));

    this.refreshing = (async () => {
      try {
        const { session: next } = await this.api.refresh(session.refreshToken);
        // Signed out while the refresh was in flight: do not resurrect it.
        if (this.session !== session) throw new ApiError(401, 'UNAUTHENTICATED', 'Not signed in.');
        await this.setSession(next);
        return next;
      } catch (err) {
        if (isApiError(err) && (err.code === 'INVALID_REFRESH_TOKEN' || err.status === 401)) {
          if (this.session === session) {
            await this.clear();
            this.emit('expired');
          }
        }
        throw err;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  async getAccessToken(): Promise<string> {
    const session = this.session;
    if (!session) throw new ApiError(401, 'UNAUTHENTICATED', 'Not signed in.');
    if (this.isExpiring(session)) return (await this.refresh()).accessToken;
    return session.accessToken;
  }

  // Runs an authenticated API call. If the access token is rejected, the
  // session is refreshed once and the call retried once.
  async authorized<T>(call: (accessToken: string) => Promise<T>): Promise<T> {
    const token = await this.getAccessToken();
    try {
      return await call(token);
    } catch (err) {
      if (!(isApiError(err) && err.code === 'INVALID_TOKEN')) throw err;
      // Another request may already have refreshed.
      const fresh = this.session && this.session.accessToken !== token ? this.session.accessToken : (await this.refresh()).accessToken;
      return call(fresh);
    }
  }

  // Ends the session on the server where possible, then always clears it
  // locally, so signing out works offline too.
  async signOut(scope: LogoutScope = 'local'): Promise<void> {
    const session = this.session;
    if (session) {
      try {
        await this.api.logout(session.accessToken, scope);
      } catch {
        // Expired token, offline, or server error: the local session is
        // removed regardless; the server session expires on its own.
      }
    }
    await this.clear();
  }
}
