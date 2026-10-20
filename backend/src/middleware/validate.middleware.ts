import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { AppError } from '../lib/errors.js';

// Field-level problems only: the path and rule that failed, never the
// submitted value (it may be a password).
export function formatIssues(error: z.ZodError) {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || null,
    message: issue.message,
  }));
}

// Replaces req.body with the parsed value, so unknown keys are stripped and
// handlers see only typed, validated data.
export function validateBody<S extends z.ZodType>(schema: S): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      next(AppError.badRequest('VALIDATION_ERROR', 'Request validation failed', formatIssues(result.error)));
      return;
    }
    req.body = result.data;
    next();
  };
}
