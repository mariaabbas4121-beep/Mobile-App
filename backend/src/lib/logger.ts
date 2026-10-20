import { pino, type Logger } from 'pino';
import type { Config } from '../config/env.js';

// Anything that could carry a credential or personal secret. Pino replaces
// these paths with "[REDACTED]" before a line is written.
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers.apikey',
  'res.headers["set-cookie"]',
  '*.password',
  '*.access_token',
  '*.refresh_token',
  '*.accessToken',
  '*.refreshToken',
  '*.token',
  '*.otp',
  '*.secret',
  '*.secretKey',
  '*.publishableKey',
];

export function createLogger(config: Pick<Config, 'logLevel'>): Logger {
  return pino({
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type { Logger };
