import dotenv from 'dotenv';
import { createApp } from './app.js';
import { ConfigValidationError, loadConfig, type Config } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { createSupabaseClients } from './config/supabase.js';
import { createSupabaseAuthGateway } from './auth/supabase-auth.gateway.js';
import { createSupabaseProfileRepository } from './auth/supabase-profile.repository.js';
import { createSupabasePhoneAuth } from './verification/supabase-phone-auth.js';
import { createSupabasePhoneVerificationStore } from './verification/supabase-phone-verification.store.js';
import { createPhoneVerificationService } from './verification/phone-verification.service.js';
import { createSupabaseListingRepository } from './listings/supabase-listing.repository.js';
import { createSupabaseBorrowRequestRepository } from './borrow/supabase-borrow.repository.js';
import { createSupabaseChatRepository } from './chat/supabase-chat.repository.js';
import { createChatEvents, createChatService } from './chat/chat.service.js';
import { DEFAULT_RATE_LIMITS } from './middleware/rate-limit.middleware.js';
import { attachChatSocket } from './realtime/chat.socket.js';
import { createSupabaseHandoverRepository } from './handover/supabase-handover.repository.js';
import { createHandoverEvents } from './handover/handover.service.js';

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
const supabase = createSupabaseClients(config);
const authGateway = createSupabaseAuthGateway(supabase, config, logger);
const profiles = createSupabaseProfileRepository(supabase, logger);
// One chat service for REST and Socket.IO, so both share rules and limits,
// and a message sent over either is broadcast to connected sockets.
const chatEvents = createChatEvents(logger);
const chat = createChatService({
  repository: createSupabaseChatRepository(supabase, logger),
  profiles,
  events: chatEvents,
  sendLimit: DEFAULT_RATE_LIMITS.chatMessagePerUser,
});
// Handover changes are announced to both participants' sockets.
const handoverEvents = createHandoverEvents(logger);
const app = createApp({
  config,
  logger,
  authGateway,
  profiles,
  // Needs SUPABASE_SECRET_KEY to record results; without it the endpoints
  // answer 503 SERVER_NOT_CONFIGURED.
  phoneVerification: createPhoneVerificationService({
    auth: createSupabasePhoneAuth(supabase, config, logger),
    store: createSupabasePhoneVerificationStore(supabase, logger),
    policy: config.phoneVerification,
    logger,
  }),
  // Runs every query with the caller's token (or anonymously); no secret key.
  listings: createSupabaseListingRepository(supabase, logger),
  borrowRequests: createSupabaseBorrowRequestRepository(supabase, logger),
  chat,
  // Caller's token only, like the rest; the database functions do the checks.
  handovers: createSupabaseHandoverRepository(supabase, logger),
  handoverEvents,
});

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.nodeEnv }, 'NeighborShare API listening');
});
// Same port as the API, path /socket.io.
const realtime = attachChatSocket(server, { config, logger, gateway: authGateway, chat, events: chatEvents, handoverEvents });

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  // Disconnects sockets, then closes the HTTP server.
  void realtime.close().then(() => process.exit(0));
  // Don't hang forever on keep-alive connections.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
