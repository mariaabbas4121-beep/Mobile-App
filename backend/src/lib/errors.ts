// Errors whose message and code are safe to send to clients. Anything thrown
// that is not an AppError is reported as a generic 500.
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  // Sent as the Retry-After header when set.
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, code: string, message: string, details?: unknown, retryAfterSeconds?: number) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  static badRequest(code: string, message: string, details?: unknown) {
    return new AppError(400, code, message, details);
  }

  // Missing, invalid or expired credentials: the caller is not known.
  static unauthenticated(message = 'Authentication required', code = 'UNAUTHENTICATED') {
    return new AppError(401, code, message);
  }

  // The caller is known but may not do this.
  static forbidden(message = 'You do not have permission to perform this action', code = 'FORBIDDEN') {
    return new AppError(403, code, message);
  }

  static notFound(message = 'Not found', code = 'NOT_FOUND') {
    return new AppError(404, code, message);
  }

  static conflict(code: string, message: string) {
    return new AppError(409, code, message);
  }

  static rateLimited(message = 'Too many requests, please try again later', retryAfterSeconds?: number, details?: unknown) {
    return new AppError(429, 'RATE_LIMITED', message, details, retryAfterSeconds);
  }

  static unavailable(message = 'Service temporarily unavailable', code = 'SERVICE_UNAVAILABLE') {
    return new AppError(503, code, message);
  }
}
