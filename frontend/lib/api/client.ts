import type {
  ActivityFeed,
  ApiErrorCode,
  CreatedPickupAuthorization,
  Handover,
  HandoverConfirmation,
  HandoverPhoto,
  HandoverState,
  PickupAuthorization,
  PickupAuthorizationInput,
  DueDateExtension,
  ItemReturn,
  ReturnConfirmation,
  ReturnInitiation,
  ReturnState,
  BorrowRequest,
  BorrowRequestInput,
  BorrowRequestPage,
  BorrowStatus,
  ChatMessage,
  Conversation,
  ConversationPage,
  DateRange,
  FieldIssue,
  ImageUploadType,
  Listing,
  ListingImage,
  ListingInput,
  ListingPage,
  ListingQuery,
  LogoutScope,
  MessagePage,
  OnboardingStatus,
  PhoneStartResult,
  PickupLocation,
  PhoneVerification,
  Profile,
  ProfileUpdate,
  Session,
  SignupResult,
  User,
} from './types';

// The backend gives up on Supabase after 12 s; allow for that plus transfer.
export const REQUEST_TIMEOUT_MS = 20_000;
// Sign-out clears the device whatever the server says, so it never waits
// long for an unreachable server.
export const LOGOUT_TIMEOUT_MS = 5_000;
// The health check does not touch Supabase; a slow answer means the API
// itself cannot be reached.
export const HEALTH_TIMEOUT_MS = 4_000;
// A photo of a few MB on a slow mobile connection.
export const UPLOAD_TIMEOUT_MS = 90_000;

// One finished request, for development timing logs. Never includes bodies,
// headers, tokens or query strings (they can hold search text).
export interface RequestTiming {
  method: string;
  path: string;
  status: number | 'NETWORK_ERROR' | 'TIMEOUT';
  durationMs: number;
  requestId: string | undefined;
}

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
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  accessToken?: string;
  timeoutMs?: number;
}

// Sends a local file as the raw request body (POST). Implemented natively on
// devices (lib/api/fileUpload.ts) so the file is never copied through a JS
// Blob. Resolves for any HTTP status; rejects on network failure, and with
// UploadTimeoutError when `timeoutMs` passes.
export type FileUploader = (
  url: string,
  fileUri: string,
  init: { headers: Record<string, string>; contentType: string; timeoutMs: number },
) => Promise<{ status: number; body: string; headers: Record<string, string> }>;

export class UploadTimeoutError extends Error {
  constructor() {
    super('Upload timed out');
    this.name = 'UploadTimeoutError';
  }
}

export interface ApiClientOptions {
  baseUrl: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  // Called once per finished request (development diagnostics).
  onTiming?: (timing: RequestTiming) => void;
  now?: () => number;
  // Needed only for photo uploads.
  uploadFile?: FileUploader;
}

// One client for the whole app. It never logs requests, bodies or headers.
export function createApiClient({
  baseUrl,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  onTiming,
  now = Date.now,
  uploadFile,
}: ApiClientOptions) {
  async function request<T>({ method, path, query, body, accessToken, timeoutMs: limit = timeoutMs }: RequestOptions): Promise<T> {
    if (!baseUrl) {
      throw new ApiError(0, 'NOT_CONFIGURED', 'The app is not configured with a server address.');
    }

    const started = now();
    const report = (status: RequestTiming['status'], requestId?: string) =>
      onTiming?.({ method, path, status, durationMs: now() - started, requestId });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/api/v1${path}${queryString(query)}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        report('TIMEOUT');
        throw new ApiError(0, 'TIMEOUT', 'The server took too long to respond. Please try again.');
      }
      report('NETWORK_ERROR');
      throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach NeighborShare. Check your connection and try again.');
    } finally {
      clearTimeout(timer);
    }
    report(response.status, response.headers.get('x-request-id') ?? undefined);

    if (response.status === 204) return undefined as T;

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ApiError(response.status, 'BAD_RESPONSE', 'The server sent an unexpected response.');
    }
    return unwrap<T>(response.status, payload, response.headers.get('retry-after'));
  }

  // Photo upload: the file goes as the raw body, read natively from disk.
  async function upload<T>(path: string, fileUri: string, contentType: string, accessToken: string): Promise<T> {
    if (!baseUrl) {
      throw new ApiError(0, 'NOT_CONFIGURED', 'The app is not configured with a server address.');
    }
    if (!uploadFile) {
      throw new ApiError(0, 'NOT_CONFIGURED', 'Photo uploads are not available in this build.');
    }
    const started = now();
    const report = (status: RequestTiming['status'], requestId?: string) =>
      onTiming?.({ method: 'POST', path, status, durationMs: now() - started, requestId });

    let result: Awaited<ReturnType<FileUploader>>;
    try {
      result = await uploadFile(`${baseUrl}/api/v1${path}`, fileUri, {
        headers: { Accept: 'application/json', 'Content-Type': contentType, Authorization: `Bearer ${accessToken}` },
        contentType,
        timeoutMs: UPLOAD_TIMEOUT_MS,
      });
    } catch (err) {
      if (err instanceof UploadTimeoutError) {
        report('TIMEOUT');
        throw new ApiError(0, 'TIMEOUT', 'The upload took too long. Please try again.');
      }
      report('NETWORK_ERROR');
      throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach NeighborShare. Check your connection and try again.');
    }
    const header = (name: string) =>
      Object.entries(result.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
    report(result.status, header('x-request-id') ?? undefined);

    let payload: unknown;
    try {
      payload = JSON.parse(result.body);
    } catch {
      throw new ApiError(result.status, 'BAD_RESPONSE', 'The server sent an unexpected response.');
    }
    return unwrap<T>(result.status, payload, header('retry-after'));
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
      request<void>({ method: 'POST', path: '/auth/logout', body: { scope }, accessToken, timeoutMs: LOGOUT_TIMEOUT_MS }),
    health: () => request<{ status: string }>({ method: 'GET', path: '/health', timeoutMs: HEALTH_TIMEOUT_MS }),
    me: (accessToken: string) => request<{ user: User; profile: Profile }>({ method: 'GET', path: '/auth/me', accessToken }),
    status: (accessToken: string) => request<OnboardingStatus>({ method: 'GET', path: '/auth/status', accessToken }),
    updateProfile: (accessToken: string, changes: ProfileUpdate) =>
      request<{ profile: Profile }>({ method: 'PATCH', path: '/profile/me', body: changes, accessToken }),
    phoneVerification: (accessToken: string) =>
      request<{ verification: PhoneVerification }>({ method: 'GET', path: '/verification/phone', accessToken }),
    startPhoneVerification: (accessToken: string, phone: string) =>
      request<PhoneStartResult>({ method: 'POST', path: '/verification/phone/start', body: { phone }, accessToken }),
    resendPhoneVerification: (accessToken: string) =>
      request<PhoneStartResult>({ method: 'POST', path: '/verification/phone/resend', body: {}, accessToken }),
    // The code is sent once, in the body, and never logged or stored.
    confirmPhoneVerification: (accessToken: string, phone: string, code: string) =>
      request<{ verification: PhoneVerification }>({
        method: 'POST',
        path: '/verification/phone/confirm',
        body: { phone, code },
        accessToken,
      }),

    // Listings. Reads work without a token; a token adds the caller's own
    // archived listings (owner=me) and archived detail pages.
    listItems: (query: ListingQuery, accessToken?: string) =>
      request<ListingPage>({ method: 'GET', path: '/items', query: { ...query }, ...(accessToken ? { accessToken } : {}) }),
    getItem: (id: string, accessToken?: string) =>
      request<{ listing: Listing }>({ method: 'GET', path: `/items/${encodeURIComponent(id)}`, ...(accessToken ? { accessToken } : {}) }),
    createItem: (accessToken: string, input: ListingInput) =>
      request<{ listing: Listing }>({ method: 'POST', path: '/items', body: input, accessToken }),
    updateItem: (accessToken: string, id: string, changes: Partial<ListingInput>) =>
      request<{ listing: Listing }>({ method: 'PATCH', path: `/items/${encodeURIComponent(id)}`, body: changes, accessToken }),
    archiveItem: (accessToken: string, id: string) =>
      request<{ listing: Listing }>({ method: 'DELETE', path: `/items/${encodeURIComponent(id)}`, accessToken }),
    // `fileUri` is a local file from the image picker (file://, content://,
    // or blob: on the web).
    uploadItemImage: (accessToken: string, id: string, fileUri: string, contentType: ImageUploadType) =>
      upload<{ image: ListingImage }>(`/items/${encodeURIComponent(id)}/images`, fileUri, contentType, accessToken),
    // The precise pickup point: owner only. Others see approximateLocation.
    getItemLocation: (accessToken: string, id: string) =>
      request<{ location: PickupLocation | null }>({ method: 'GET', path: `/items/${encodeURIComponent(id)}/location`, accessToken }),
    setItemLocation: (accessToken: string, id: string, point: { latitude: number; longitude: number }) =>
      request<{ location: PickupLocation; listing: Listing }>({
        method: 'PUT',
        path: `/items/${encodeURIComponent(id)}/location`,
        body: point,
        accessToken,
      }),
    clearItemLocation: (accessToken: string, id: string) =>
      request<void>({ method: 'DELETE', path: `/items/${encodeURIComponent(id)}/location`, accessToken }),
    // Public; dates only. Used to grey out booked days in the request form.
    getBookedDates: (id: string, accessToken?: string) =>
      request<{ bookedDates: DateRange[] }>({
        method: 'GET',
        path: `/items/${encodeURIComponent(id)}/booked-dates`,
        ...(accessToken ? { accessToken } : {}),
      }),

    // Borrow requests. The borrower and lender always come from the token
    // and the listing on the server.
    createBorrowRequest: (accessToken: string, input: BorrowRequestInput) =>
      request<{ request: BorrowRequest }>({ method: 'POST', path: '/borrow-requests', body: input, accessToken }),
    listOutgoingRequests: (accessToken: string, query: { status?: BorrowStatus; page?: number; pageSize?: number } = {}) =>
      request<BorrowRequestPage>({ method: 'GET', path: '/borrow-requests/outgoing', query: { ...query }, accessToken }),
    listIncomingRequests: (accessToken: string, query: { status?: BorrowStatus; page?: number; pageSize?: number } = {}) =>
      request<BorrowRequestPage>({ method: 'GET', path: '/borrow-requests/incoming', query: { ...query }, accessToken }),
    getBorrowRequest: (accessToken: string, id: string) =>
      request<{ request: BorrowRequest }>({ method: 'GET', path: `/borrow-requests/${encodeURIComponent(id)}`, accessToken }),
    decideBorrowRequest: (accessToken: string, id: string, action: 'accept' | 'decline' | 'cancel') =>
      request<{ request: BorrowRequest }>({
        method: 'POST',
        path: `/borrow-requests/${encodeURIComponent(id)}/${action}`,
        body: {},
        accessToken,
      }),

    // Chat. Participants come from the borrow request on the server; the
    // client only ever names a request or conversation id.
    listConversations: (accessToken: string, query: { page?: number; pageSize?: number } = {}) =>
      request<ConversationPage>({ method: 'GET', path: '/conversations', query: { ...query }, accessToken }),
    // Get-or-create for an accepted borrow request.
    openConversation: (accessToken: string, borrowRequestId: string) =>
      request<{ conversation: Conversation }>({ method: 'POST', path: '/conversations', body: { borrowRequestId }, accessToken }),
    getConversation: (accessToken: string, id: string) =>
      request<{ conversation: Conversation }>({ method: 'GET', path: `/conversations/${encodeURIComponent(id)}`, accessToken }),
    listMessages: (accessToken: string, id: string, query: { before?: string; limit?: number } = {}) =>
      request<MessagePage>({ method: 'GET', path: `/conversations/${encodeURIComponent(id)}/messages`, query: { ...query }, accessToken }),
    // REST fallback for when the socket is down. Safe to retry with the same clientId.
    sendMessage: (accessToken: string, id: string, input: { clientId: string; body: string }) =>
      request<{ message: ChatMessage; duplicate: boolean }>({
        method: 'POST',
        path: `/conversations/${encodeURIComponent(id)}/messages`,
        body: input,
        accessToken,
      }),
    markConversationRead: (accessToken: string, id: string) =>
      request<{ conversation: Conversation }>({ method: 'POST', path: `/conversations/${encodeURIComponent(id)}/read`, body: {}, accessToken }),

    // Pickup and handover. The code travels only in request bodies.
    getHandover: (accessToken: string, requestId: string) =>
      request<{ handover: HandoverState }>({ method: 'GET', path: `/borrow-requests/${encodeURIComponent(requestId)}/handover`, accessToken }),
    createPickupAuthorization: (accessToken: string, requestId: string, input: PickupAuthorizationInput) =>
      request<CreatedPickupAuthorization>({
        method: 'POST',
        path: `/borrow-requests/${encodeURIComponent(requestId)}/pickup-authorizations`,
        body: { ...input, confirm: true },
        accessToken,
      }),
    revokePickupAuthorization: (accessToken: string, requestId: string, authorizationId: string) =>
      request<{ authorization: PickupAuthorization }>({
        method: 'POST',
        path: `/borrow-requests/${encodeURIComponent(requestId)}/pickup-authorizations/${encodeURIComponent(authorizationId)}/revoke`,
        body: {},
        accessToken,
      }),
    verifyPickupCode: (accessToken: string, requestId: string, code: string) =>
      request<{ authorization: PickupAuthorization }>({
        method: 'POST',
        path: `/borrow-requests/${encodeURIComponent(requestId)}/handover/verify`,
        body: { code },
        accessToken,
      }),
    confirmHandover: (accessToken: string, requestId: string, confirmation: HandoverConfirmation) =>
      request<{ handover: Handover }>({
        method: 'POST',
        path: `/borrow-requests/${encodeURIComponent(requestId)}/handover`,
        body: { ...confirmation, confirm: true },
        accessToken,
      }),
    uploadHandoverPhoto: (accessToken: string, requestId: string, fileUri: string, contentType: ImageUploadType) =>
      upload<{ photo: HandoverPhoto }>(`/borrow-requests/${encodeURIComponent(requestId)}/handover/photos`, fileUri, contentType, accessToken),

    // Returns and due-date extensions. The code travels only in request bodies.
    getReturn: (accessToken: string, requestId: string) =>
      request<{ return: ReturnState }>({ method: 'GET', path: `/borrow-requests/${encodeURIComponent(requestId)}/return`, accessToken }),
    initiateReturn: (accessToken: string, requestId: string, input: ReturnInitiation) =>
      request<{ return: ReturnState }>({
        method: 'POST',
        path: `/borrow-requests/${encodeURIComponent(requestId)}/return`,
        body: { ...input, confirm: true },
        accessToken,
      }),
    createReturnAuthorization: (accessToken: string, requestId: string, input: PickupAuthorizationInput) =>
      request<CreatedPickupAuthorization>({
        method: 'POST',
        path: `/borrow-requests/${encodeURIComponent(requestId)}/return-authorizations`,
        body: { ...input, confirm: true },
        accessToken,
      }),
    revokeReturnAuthorization: (accessToken: string, requestId: string, authorizationId: string) =>
      request<{ authorization: PickupAuthorization }>({
        method: 'POST',
        path: `/borrow-requests/${encodeURIComponent(requestId)}/return-authorizations/${encodeURIComponent(authorizationId)}/revoke`,
        body: {},
        accessToken,
      }),
    verifyReturnCode: (accessToken: string, requestId: string, code: string) =>
      request<{ authorization: PickupAuthorization }>({
        method: 'POST',
        path: `/borrow-requests/${encodeURIComponent(requestId)}/return/verify`,
        body: { code },
        accessToken,
      }),
    confirmReturn: (accessToken: string, requestId: string, confirmation: ReturnConfirmation) =>
      request<{ return: ItemReturn }>({
        method: 'POST',
        path: `/borrow-requests/${encodeURIComponent(requestId)}/return/confirm`,
        body: { ...confirmation, confirm: true },
        accessToken,
      }),
    uploadReturnPhoto: (accessToken: string, requestId: string, fileUri: string, contentType: ImageUploadType) =>
      upload<{ photo: HandoverPhoto }>(`/borrow-requests/${encodeURIComponent(requestId)}/return/photos`, fileUri, contentType, accessToken),
    requestExtension: (accessToken: string, requestId: string, input: { requestedEndDate: string; reason?: string | null }) =>
      request<{ extension: DueDateExtension }>({
        method: 'POST',
        path: `/borrow-requests/${encodeURIComponent(requestId)}/extensions`,
        body: input,
        accessToken,
      }),
    decideExtension: (accessToken: string, requestId: string, extensionId: string, decision: 'approve' | 'reject') =>
      request<{ extension: DueDateExtension }>({
        method: 'POST',
        path: `/borrow-requests/${encodeURIComponent(requestId)}/extensions/${encodeURIComponent(extensionId)}/${decision}`,
        body: {},
        accessToken,
      }),

    // The caller's own recent activity, derived on the server from their
    // requests, conversations and listings.
    getActivity: (accessToken: string, query: { limit?: number } = {}) =>
      request<ActivityFeed>({ method: 'GET', path: '/activity', query: { ...query }, accessToken }),

    deleteItemImage: (accessToken: string, id: string, imageId: string) =>
      request<void>({
        method: 'DELETE',
        path: `/items/${encodeURIComponent(id)}/images/${encodeURIComponent(imageId)}`,
        accessToken,
      }),
  };
}

// The API's envelope: `data` on success, a coded ApiError otherwise.
function unwrap<T>(status: number, payload: unknown, retryAfterHeader: string | null): T {
  if (status >= 200 && status < 300 && isObject(payload) && payload.success === true) {
    return payload.data as T;
  }
  if (isObject(payload) && payload.success === false && typeof payload.code === 'string') {
    const retryAfter = Number(retryAfterHeader);
    throw new ApiError(status, payload.code, typeof payload.message === 'string' ? payload.message : 'Request failed', {
      details: payload.details,
      requestId: typeof payload.requestId === 'string' ? payload.requestId : undefined,
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    });
  }
  throw new ApiError(status, 'BAD_RESPONSE', 'The server sent an unexpected response.');
}

function queryString(query: RequestOptions['query']): string {
  if (!query) return '';
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export type ApiClient = ReturnType<typeof createApiClient>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
