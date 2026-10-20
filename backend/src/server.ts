import dotenv from 'dotenv';
import { createApp } from './app.js';
import { ConfigValidationError, loadConfig, type Config } from './config/env.js';
import { createLogger } from './lib/logger.js';

// Load .env only in the entry point, so tests decide their own environment.
// Existing process variables take precedence over the file.
dotenv.config({ quiet: true });

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigValidationError) {
    // Names variables and rules only, never values.
    console.error(`${err.message}\nSee backend/.env.example.`);
    process.exit(1);
  }
  throw err;
}

const logger = createLogger(config);
const app = createApp({ config, logger });

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.nodeEnv }, 'NeighborShare API listening');
});

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(() => process.exit(0));
  // Don't hang forever on keep-alive connections.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
