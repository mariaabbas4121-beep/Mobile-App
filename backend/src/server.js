import { createApp } from './app.js';
import { config } from './config/env.js';
import { isSupabaseConfigured } from './config/supabase.js';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`NeighborShare API listening on http://localhost:${config.port} (${config.nodeEnv})`);
  if (!isSupabaseConfigured()) {
    console.warn('Supabase is not configured; Supabase-backed requests will return 503. See backend/README.md.');
  }
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  // Don't hang forever on keep-alive connections.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
