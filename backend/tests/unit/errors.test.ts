import { describe, expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { pinoHttp } from 'pino-http';
import { AppError } from '../../src/lib/errors.js';
import { errorHandler } from '../../src/middleware/error.middleware.js';
import { validateBody } from '../../src/middleware/validate.middleware.js';
import { silentLogger } from '../helpers.js';

function appWith(handler: express.RequestHandler, ...middleware: express.RequestHandler[]) {
  const app = express();
  app.use(pinoHttp({ logger: silentLogger }));
  app.use(express.json());
  app.post('/t', ...middleware, handler);
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  test('unexpected errors become a generic 500 with no internal details', async () => {
    const app = appWith(() => {
      throw new Error('connection string postgres://user:pw@db/internal failed');
    });
    const res = await request(app).post('/t');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, code: 'INTERNAL_ERROR', message: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toContain('postgres');
  });

  test('AppError status, code and message are passed through', async () => {
    const app = appWith(() => {
      throw AppError.forbidden();
    });
    const res = await request(app).post('/t');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});

describe('validateBody', () => {
  const schema = z.object({ email: z.email(), password: z.string().min(8) });
  const app = appWith((req, res) => res.json(req.body), validateBody(schema));

  test('rejects invalid input with field errors and never echoes values', async () => {
    const res = await request(app).post('/t').send({ email: 'nope', password: 'secret1' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details.map((d: { field: string }) => d.field).sort()).toEqual(['email', 'password']);
    expect(JSON.stringify(res.body)).not.toContain('secret1');
  });

  test('strips unknown fields from valid input', async () => {
    const res = await request(app)
      .post('/t')
      .send({ email: 'a@example.com', password: 'longenough', role: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: 'a@example.com', password: 'longenough' });
  });
});
