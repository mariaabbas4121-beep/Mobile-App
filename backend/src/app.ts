import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Config } from './config/env.js';
import type { Logger } from './lib/logger.js';
import type { AuthGateway, ProfileRepository } from './auth/auth.types.js';
import { healthRoutes } from './routes/health.routes.js';
import { authRoutes } from './routes/auth.routes.js';
import { errorHandler, notFound } from './middleware/error.middleware.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  authGateway: AuthGateway;
  profiles: ProfileRepository;
}

export function createApp({ config, logger, authGateway, profiles }: AppDeps) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);

  app.use(
    pinoHttp({
      logger,
      // Always generate the id server-side; a client-supplied one could be
      // used to forge or confuse log correlation.
      genReqId: (_req, res) => {
        const id = randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      // Log only what is needed to trace a request: no headers, no body,
      // no query string (it may carry tokens on redirect URLs).
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          path: req.url.split('?')[0],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    }),
  );

  // JSON API: no HTML is served, so the strictest CSP is safe.
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // Browsers (e.g. Expo web) enforce CORS; native apps send no Origin header.
  app.use(
    cors({
      origin: config.corsOrigins,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '100kb' }));

  // Responses can contain tokens or personal data; never cache them.
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use('/health', healthRoutes());
  app.use('/api/v1/health', healthRoutes());
  app.use('/api/v1/auth', authRoutes({ gateway: authGateway, profiles }));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
