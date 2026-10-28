// The database adapter for phone verification, with the Supabase client
// replaced by a fake. Checks how database errors are reported.
import { describe, expect, test, vi } from 'vitest';
import type { SupabaseClients } from '../../src/config/supabase.js';
import { AppError } from '../../src/lib/errors.js';
import { createSupabasePhoneVerificationStore } from '../../src/verification/supabase-phone-verification.store.js';
import { silentLogger } from '../helpers.js';

function storeWithError(error: { code: string }) {
  const result = { data: null, error };
  // Every query and RPC resolves to the same error.
  const query = { select: () => query, eq: () => query, maybeSingle: async () => result };
  const clients = {
    admin: () => ({ from: () => query, rpc: vi.fn(async () => result) }),
  } as unknown as SupabaseClients;
  return createSupabasePhoneVerificationStore(clients, silentLogger);
}

const catchErr = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as AppError);

describe('phone verification store errors', () => {
  test.each(['42703', '42883', 'PGRST202', 'PGRST204'])(
    'database error %s (migration not applied) is a setup problem, not an outage',
    async (code) => {
      const store = storeWithError({ code });
      for (const call of [store.get('u'), store.reserveSend('u', 60)]) {
        const err = await catchErr(call);
        expect([err?.status, err?.code, err?.details]).toEqual([503, 'PHONE_VERIFICATION_NOT_CONFIGURED', { reason: 'database_migration_missing' }]);
      }
    },
  );

  test('other database errors stay a generic temporary outage', async () => {
    const err = await catchErr(storeWithError({ code: '08006' }).get('u'));
    expect([err?.status, err?.code]).toEqual([503, 'DATABASE_UNAVAILABLE']);
  });
});
