// The real Supabase SDK and adapters pointed at a local server that accepts
// connections and then never answers (a hung dependency). Checks that auth
// requests end with a prompt, safe 503 instead of waiting, that the health
// check is independent of Supabase, and that the timing logs carry the
// request id but no credentials. No real Supabase project is involved.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { pino } from 'pino';
import { createApp } from '../../src/app.js';
import { createSupabaseClients } from '../../src/config/supabase.js';
import { createSupabaseAuthGateway } from '../../src/auth/supabase-auth.gateway.js';
import { createSupabaseProfileRepository } from '../../src/auth/supabase-profile.repository.js';
import { REDACT_PATHS } from '../../src/lib/logger.js';
import { currentRequestId } from '../../src/lib/request-context.js';
import { testConfig, VALID_TOKEN } from '../helpers.js';

const DEADLINE_MS = 1500;
let hung: Server;
const open = new Set<import('node:net').Socket>();
let requestsSeen = 0;

beforeAll(async () => {
  // Reads the request, then never responds.
  hung = createServer(() => {
    requestsSeen += 1;
  });
  hung.on('connection', (s) => {
    open.add(s);
    s.on('close', () => open.delete(s));
  });
  await new Promise<void>((r) => hung.listen(0, '127.0.0.1', r));
});

afterAll(async () => {
  for (const s of open) s.destroy();
  await new Promise<void>((r) => hung.close(() => r()));
});

function appWithLogs() {
  const lines: string[] = [];
  const logger = pino(
    {
      level: 'debug',
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      mixin: () => {
        const reqId = currentRequestId();
        return reqId ? { reqId } : {};
      },
    },
    { write: (l: string) => void lines.push(l) },
  );
  const { port } = hung.address() as AddressInfo;
  const config = testConfig({
    supabase: { url: `http://127.0.0.1:${port}`, publishableKey: 'sb_publishable_unit_test_placeholder_key', secretKey: undefined },
  });
  const clients = createSupabaseClients(config);
  const app = createApp({
    config,
    logger,
    authGateway: createSupabaseAuthGateway(clients, config, logger, { deadlineMs: DEADLINE_MS }),
    profiles: createSupabaseProfileRepository(clients, logger),
  });
  return { app, lines };
}

describe('Supabase accepts connections but never answers', () => {
  test.each([
    ['login', (app: Parameters<typeof request>[0]) => request(app).post('/api/v1/auth/login').send({ email: 'a@example.test', password: 'pw-secret-1' })],
    ['refresh', (app: Parameters<typeof request>[0]) => request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'refresh-secret' })],
    ['me', (app: Parameters<typeof request>[0]) => request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${VALID_TOKEN}`)],
    ['status', (app: Parameters<typeof request>[0]) => request(app).get('/api/v1/auth/status').set('Authorization', `Bearer ${VALID_TOKEN}`)],
  ])('%s ends with 503 AUTH_UNAVAILABLE at the deadline instead of hanging', async (_label, call) => {
    const { app } = appWithLogs();
    const before = requestsSeen;
    const started = Date.now();
    const res = await call(app);
    const elapsed = Date.now() - started;
    expect(requestsSeen).toBeGreaterThan(before); // it really reached the hung server
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AUTH_UNAVAILABLE');
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
    expect(elapsed).toBeLessThan(DEADLINE_MS + 2000);
  }, 15_000);

  test('the health check answers at once, without Supabase', async () => {
    const { app } = appWithLogs();
    const started = Date.now();
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('timing logs name the slow call and its request id, never credentials', async () => {
    const { app, lines } = appWithLogs();
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'person@example.test', password: 'pw-secret-1' });
    const requestId = res.headers['x-request-id'];
    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);

    const dependency = entries.find((e) => e.dependency === 'supabase_auth.sign_in_with_password');
    expect(dependency).toMatchObject({ outcome: 'error', reqId: requestId });
    expect(dependency?.durationMs).toBeGreaterThanOrEqual(DEADLINE_MS - 50);

    const completed = entries.find((e) => typeof e.responseTime === 'number');
    expect(completed).toMatchObject({ reqId: requestId });

    const output = lines.join('\n');
    for (const secret of ['pw-secret-1', 'person@example.test', 'sb_publishable_unit_test_placeholder_key']) {
      expect(output).not.toContain(secret);
    }
  }, 15_000);
});
