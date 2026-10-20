import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';

// A minimal stand-in for the parts of a Supabase database the migrations rely
// on: the API roles, auth.users, auth.uid() and Supabase's default grants on
// the public schema. This lets migrations, triggers, grants and RLS be checked
// on real PostgreSQL offline. It is NOT proof of behaviour on the hosted
// project; the integration suite covers that.
const SUPABASE_STUB = `
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;

  create schema auth;
  create table auth.users (
    id uuid primary key,
    email text,
    email_confirmed_at timestamptz,
    raw_user_meta_data jsonb not null default '{}'::jsonb
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;

  grant usage on schema public, auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;

  -- Supabase's defaults: new public objects are fully granted to API roles.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');

export async function createMigratedDb(): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(SUPABASE_STUB);
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return db;
}

// Simulates Supabase Auth creating a user (the trigger fires as it would).
export async function createAuthUser(
  db: PGlite,
  opts: { email?: string | null; confirmed?: boolean; metadata?: unknown } = {},
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
     values ($1, $2, case when $3 then now() end, $4::jsonb)`,
    [id, opts.email === undefined ? `${id}@example.test` : opts.email, opts.confirmed ?? false, JSON.stringify(opts.metadata ?? {})],
  );
  return id;
}

// Runs fn as the `authenticated` role with auth.uid() = userId, the way
// PostgREST runs a request carrying that user's JWT. Rolled back afterwards.
export async function asUser<T>(db: PGlite, userId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return asRole(db, 'authenticated', userId, fn);
}

export async function asRole<T>(
  db: PGlite,
  role: 'anon' | 'authenticated' | 'service_role',
  userId: string | null,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  let failure: unknown;
  await db
    .transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
      await tx.exec(`set local role ${role}`);
      try {
        result = await fn(tx);
      } catch (err) {
        failure = err;
      }
      await tx.rollback();
    })
    .catch(() => undefined);
  if (failure) throw failure;
  return result as T;
}

// PostgreSQL error code of a failed statement, e.g. 42501 insufficient_privilege.
export async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}
