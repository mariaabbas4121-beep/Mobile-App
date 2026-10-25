import type {
  ApiErrorCode,
  FieldIssue,
  LogoutScope,
  OnboardingStatus,
  Profile,
  ProfileUpdate,
  Session,
  SignupResult,
  User,
} from './types';

// The backend gives up on Supabase after 12 s; allow for that plus transfer.
export const REQUEST_TIMEOUT_MS = 20_000;

// Every failure the client reports. `code` is a backend error code or one of
// the client-side codes (NETWORK_ERROR, TIMEOUT, BAD_RESPONSE, NOT_CONFIGURED).
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | (string & {});
  readonly details: unknown;
  readonly requestId: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: number,
    code: ApiErrorCode | (string & {}),
    message: string,
    extra: { details?: unknown; requestId?: string; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = extra.details;
    this.requestId = extra.requestId;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }

  // Validation issues from a VALIDATION_ERROR response.
  get fieldIssues(): FieldIssue[] {
    return Array.isArray(this.details) ? (this.details as FieldIssue[]) : [];
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: unknown;
  accessToken?: string;
}

export interface ApiClientOptions {
  baseUrl: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

// One client for the whole app. It never logs requests, bodies or headers.
export function createApiClient({ baseUrl, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS }: ApiClientOptions) {
  async function request<T>({ method, path, body, accessToken }: RequestOptions): Promise<T> {
    if (!baseUrl) {
      throw new ApiError(0, 'NOT_CONFIGURED', 'The app is not configured with a server address.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/api/v1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new ApiError(0, 'TIMEOUT', 'The server took too long to respond. Please try again.');
      }
      throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach NeighborShare. Check your connection and try again.');
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 204) return undefined as T;

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ApiError(response.status, 'BAD_RESPONSE', 'The server sent an unexpected response.');
    }

    if (response.ok && isObject(payload) && payload.success === true) {
      return payload.data as T;
    }

    if (isObject(payload) && payload.success === false && typeof payload.code === 'string') {
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new ApiError(response.status, payload.code, typeof payload.message === 'string' ? payload.message : 'Request failed', {
        details: payload.details,
        requestId: typeof payload.requestId === 'string' ? payload.requestId : undefined,
        retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      });
    }

    throw new ApiError(response.status, 'BAD_RESPONSE', 'The server sent an unexpected response.');
  }

  return {
    signup: (input: { email: string; password: string; displayName?: string }) =>
      request<SignupResult>({ method: 'POST', path: '/auth/signup', body: input }),
    login: (input: { email: string; password: string }) =>
      request<{ user: User; session: Session }>({ method: 'POST', path: '/auth/login', body: input }),
    refresh: (refreshToken: string) =>
      request<{ user: User; session: Session }>({ method: 'POST', path: '/auth/refresh', body: { refreshToken } }),
    resendConfirmation: (email: string) =>
      request<{ message: string }>({ method: 'POST', path: '/auth/email/resend', body: { email } }),
    logout: (accessToken: string, scope: LogoutScope = 'local') =>
      request<void>({ method: 'POST', path: '/auth/logout', body: { scope }, accessToken }),
    me: (accessToken: string) => request<{ user: User; profile: Profile }>({ method: 'GET', path: '/auth/me', accessToken }),
    status: (accessToken: string) => request<OnboardingStatus>({ method: 'GET', path: '/auth/status', accessToken }),
    updateProfile: (accessToken: string, changes: ProfileUpdate) =>
      request<{ profile: Profile }>({ method: 'PATCH', path: '/profile/me', body: changes, accessToken }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
