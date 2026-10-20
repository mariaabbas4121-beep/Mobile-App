// Starts the real entry point (src/server.ts) as a separate process. It runs
// from an empty temporary directory so no .env file is loaded, and with
// fake Supabase values: nothing here contacts Supabase.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { validEnv } from '../helpers.js';

const BACKEND = join(import.meta.dirname, '..', '..');
const TSX = pathToFileURL(join(BACKEND, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href;
const SERVER = join(BACKEND, 'src', 'server.ts');

const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(async () => {
  // Wait for each child to exit: Windows will not remove a directory that a
  // running process uses as its working directory.
  await Promise.all(
    children.splice(0).map(
      (c) =>
        new Promise<void>((resolve) => {
          if (c.exitCode !== null || c.signalCode !== null) return resolve();
          c.once('exit', () => resolve());
          c.kill();
        }),
    ),
  );
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function start(env: Record<string, string>) {
  const cwd = mkdtempSync(join(tmpdir(), 'ns-server-'));
  dirs.push(cwd);
  // Only PATH/SystemRoot from the parent, so no real credentials leak in.
  const base = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' };
  const child = spawn(process.execPath, ['--import', TSX, SERVER], { cwd, env: { ...base, ...env } });
  children.push(child);
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  return { child, exited, output: () => output };
}

async function waitFor(check: () => boolean, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
}

describe('server process', () => {
  test('starts with valid configuration and serves the health check', async () => {
    const port = String(41_000 + Math.floor(Math.random() * 2000));
    const proc = start({ ...validEnv, NODE_ENV: 'development', PORT: port, LOG_LEVEL: 'info' });
    await waitFor(() => proc.output().includes('NeighborShare API listening'), 15_000);

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { status: 'ok' } });
    expect(proc.output()).not.toContain(validEnv.SUPABASE_PUBLISHABLE_KEY);
  }, 30_000);

  test('refuses to start with invalid configuration, naming variables but not values', async () => {
    const secretLooking = 'sb_secret_value_that_must_not_be_printed';
    const proc = start({
      NODE_ENV: 'development',
      SUPABASE_URL: 'not-a-url',
      SUPABASE_PUBLISHABLE_KEY: '',
      SUPABASE_SECRET_KEY: secretLooking.slice(0, 5),
      PORT: 'abc',
    });
    const code = await proc.exited;
    expect(code).toBe(1);
    const out = proc.output();
    expect(out).toContain('Invalid server configuration');
    expect(out).toMatch(/SUPABASE_URL/);
    expect(out).toMatch(/SUPABASE_PUBLISHABLE_KEY is required/);
    expect(out).toMatch(/PORT has an invalid value/);
    expect(out).not.toContain('not-a-url');
    expect(out).not.toContain('sb_se');
    expect(out).not.toMatch(/\bat\s.+:\d+:\d+/); // no stack trace
  }, 30_000);
});
