import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';

export interface ErrorBody {
  success: false;
  code: string;
  message: string;
  requestId?: string;
  details?: unknown;
}

export const notFound: RequestHandler = (req, res) => {
  const body: ErrorBody = {
    success: false,
    code: 'ROUTE_NOT_FOUND',
    message: `Route not found: ${req.method} ${req.path}`,
    requestId: String(req.id),
  };
  res.status(404).json(body);
};

// Errors raised by express.json() carry a `type`; their messages are safe.
interface BodyParserError {
  type: string;
  status: number;
}

const isBodyParserError = (err: unknown): err is BodyParserError =>
  typeof err === 'object' && err !== null && 'type' in err && 'status' in err;

// Express recognises error handlers by their four parameters.
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  let error: AppError;

  if (err instanceof AppError) {
    error = err;
  } else if (isBodyParserError(err) && err.type === 'entity.parse.failed') {
    error = AppError.badRequest('INVALID_JSON', 'Request body is not valid JSON');
  } else if (isBodyParserError(err) && err.type === 'entity.too.large') {
    error = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  } else if (isBodyParserError(err) && err.status >= 400 && err.status < 500) {
    error = AppError.badRequest('BAD_REQUEST', 'Malformed request');
  } else {
    error = new AppError(500, 'INTERNAL_ERROR', 'Internal server error');
  }

  if (error.status >= 500) {
    // The original error goes to the log only; the client gets the generic one.
    req.log.error({ err }, 'request failed');
  }

  const body: ErrorBody = {
    success: false,
    code: error.code,
    message: error.message,
    requestId: String(req.id),
  };
  if (error.details !== undefined) body.details = error.details;

  if (res.headersSent) return;
  // express-rate-limit sets its own Retry-After before calling next().
  if (error.retryAfterSeconds !== undefined && !res.getHeader('Retry-After')) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterSeconds))));
  }
  if (error.status === 401) {
    res.setHeader(
      'WWW-Authenticate',
      error.code === 'UNAUTHENTICATED' ? 'Bearer' : 'Bearer error="invalid_token"',
    );
  }
  res.status(error.status).json(body);
};
