import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

// Simulate a machine with no Supabase credentials. dotenv never overrides
// variables that already exist, so a local .env cannot change these.
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_PUBLISHABLE_KEY = '';
process.env.SUPABASE_SECRET_KEY = '';

const { createApp } = await import('../src/app.js');
const { ConfigurationError, getSupabaseAdminClient, getSupabaseClient, isSupabaseConfigured } =
  await import('../src/config/supabase.js');

let server;
let baseUrl;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

describe('health check', () => {
  for (const path of ['/health', '/api/health']) {
    test(`GET ${path} returns 200 without Supabase credentials`, async () => {
      const res = await fetch(baseUrl + path);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        success: true,
        message: 'NeighborShare API is running',
      });
    });
  }
});

describe('error handling', () => {
  test('unknown routes return a JSON 404', async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.message, /not found/i);
  });

  test('malformed JSON returns a safe 400 without a stack trace', async () => {
    const res = await fetch(`${baseUrl}/api/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"broken": ',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.deepEqual(Object.keys(body).sort(), ['message', 'success']);
    assert.doesNotMatch(body.message, /\bat\s.+:\d+/);
  });
});

describe('Supabase configuration', () => {
  test('reports not configured', () => {
    assert.equal(isSupabaseConfigured(), false);
  });

  test('client access fails with a 503 configuration error instead of a fake client', () => {
    assert.throws(getSupabaseClient, (err) => err instanceof ConfigurationError && err.statusCode === 503);
    assert.throws(getSupabaseAdminClient, ConfigurationError);
  });
});
