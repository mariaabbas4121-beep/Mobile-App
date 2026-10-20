import { describe, expect, test } from 'vitest';
import request from 'supertest';
import { testApp } from '../helpers.js';

const { app } = testApp();

describe('health', () => {
  for (const path of ['/health', '/api/v1/health']) {
    test(`GET ${path} returns 200 without contacting Supabase`, async () => {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { status: 'ok' } });
    });
  }
});

describe('security headers', () => {
  test('sets Helmet headers, no-store and a request id; hides Express', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('ignores a client-supplied request id', async () => {
    const res = await request(app).get('/api/v1/health').set('X-Request-Id', 'forged');
    expect(res.headers['x-request-id']).not.toBe('forged');
  });
});

describe('CORS', () => {
  test('allows a configured origin', async () => {
    const res = await request(app).get('/api/v1/health').set('Origin', 'http://localhost:8081');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8081');
  });

  test('does not allow an unlisted origin', async () => {
    const res = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('error handling', () => {
  test('unknown routes return a structured 404', async () => {
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: 'ROUTE_NOT_FOUND' });
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  test('malformed JSON returns a safe 400 without internals', async () => {
    const res = await request(app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{"broken": ');
    expect(res.status).toBe(400);
    expect(Object.keys(res.body).sort()).toEqual(['code', 'message', 'requestId', 'success']);
    expect(res.body.code).toBe('INVALID_JSON');
    expect(JSON.stringify(res.body)).not.toMatch(/\bat\s.+:\d+|SyntaxError/);
  });

  test('oversized bodies return 413', async () => {
    const res = await request(app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ x: 'a'.repeat(200_000) }));
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
