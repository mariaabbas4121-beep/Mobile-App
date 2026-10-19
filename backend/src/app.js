import express from 'express';
import cors from 'cors';
import { config } from './config/env.js';
import healthRoutes from './routes/health.routes.js';
import { errorHandler, notFound } from './middleware/error.middleware.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');

  // CORS is enforced by browsers (e.g. Expo web). Native mobile requests send
  // no Origin header and are not affected by this list.
  app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json({ limit: '100kb' }));

  app.use('/health', healthRoutes);
  app.use('/api/health', healthRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
