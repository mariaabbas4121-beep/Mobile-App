// Database tests for 20261103120000_chat.sql on PGlite: conversations exist
// only for accepted requests, only the two participants can read or write
// them, messages are validated and idempotent, and history pages correctly.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asRole, createAuthUser, createMigratedDb, sqlState } from './pglite.js';

let db: PGlite;
let today: string;

beforeAll(async () => {
  db = await createMigratedDb();
  today = (await db.query<{ d: string }>(`select public.borrow_today()::text as d`)).rows[0]!.d;
});

const day = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function readyUser(name = 'User'): Promise<string> {
  const id = await createAuthUser(db);
  await db.query(`update public.profiles set display_name = $2 where id = $1`, [id, name]);
  return id;
}

async function seedListing(ownerId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.listings (owner_id, title, description, category, condition)
     values ($1, 'Camping tent', 'Four person tent, waterproof.', 'outdoor', 'good') returning id`,
    [ownerId],
  );
  return rows[0]!.id;
}

// Runs one statement as `userId` (authenticated; null = service role) and commits it.
async function as<T = Record<string, unknown>>(userId: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
    await tx.exec(`set local role ${userId ? 'authenticated' : 'service_role'}`);
    return (await tx.query<T>(sql, params)).rows;
  });
}

// A lender, a borrower, an outsider and a request between the first two.
async function scenario(status: 'pending' | 'accepted' | 'declined' | 'cancelled' = 'accepted', offset = 1) {
  const [lender, borrower, outsider] = [await readyUser('Lender'), await readyUser('Borrower'), await readyUser('Outsider')];
  const listing = await seedListing(lender);
  const [req] = await as<{ id: string }>(
    borrower,
    `insert into public.borrow_requests (listing_id, borrower_id, start_date, end_date) values ($1, $2, $3, $4) returning id`,
    [listing, borrower, day(offset), day(offset + 1)],
  );
  const requestId = req!.id;
  if (status !== 'pending') {
    await as(status === 'cancelled' ? borrower : lender, `update public.borrow_requests set status = $2::public.borrow_request_status where id = $1`, [
      requestId,
      status,
    ]);
  }
  return { lender, borrower, outsider, listing, requestId };
}

const conversationOf = async (requestId: string) =>
  (await db.query<{ id: string }>(`select id from public.conversations where borrow_request_id = $1`, [requestId])).rows[0]?.id;

const send = (userId: string, conversationId: string, body: string, clientId = randomUUID()) =>
  as<{ r: { created: boolean; message: { id: string; body: string; sender_id: string; created_at: string } } }>(
    userId,
    `select public.send_message($1, $2, $3) as r`,
    [conversationId, clientId, body],
  ).then((rows) => rows[0]!.r);

const openConversation = (userId: string, requestId: string) =>
  as<{ id: string | null }>(userId, `select public.open_conversation($1) as id`, [requestId]).then((r) => r[0]!.id);

const listConversations = (userId: string) =>
  as<{ r: { total: number; items: Record<string, any>[] } }>(userId, `select public.list_conversations() as r`).then((r) => r[0]!.r);

describe('creating conversations', () => {
  test('accepting a request opens its conversation with the request’s participants', async () => {
    const { lender, borrower, listing, requestId } = await scenario('accepted');
    const { rows } = await db.query(`select * from public.conversations where borrow_request_id = $1`, [requestId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ borrower_id: borrower, lender_id: lender, listing_id: listing });
  });

  test('pending, declined and cancelled requests have no conversation and cannot open one', async () => {
    for (const status of ['pending', 'declined', 'cancelled'] as const) {
      const { borrower, lender, requestId } = await scenario(status);
      expect(await conversationOf(requestId), status).toBeUndefined();
      expect(await sqlState(openConversation(borrower, requestId)), status).toBe('NSC01');
      expect(await sqlState(openConversation(lender, requestId)), status).toBe('NSC01');
    }
  });

  test('open_conversation is idempotent and returns the same conversation to both sides', async () => {
    const { borrower, lender, requestId } = await scenario('accepted');
    const first = await openConversation(borrower, requestId);
    expect(first).toBe(await conversationOf(requestId));
    expect(await openConversation(borrower, requestId)).toBe(first);
    expect(await openConversation(lender, requestId)).toBe(first);
    const { rows } = await db.query(`select count(*)::int as n from public.conversations where borrow_request_id = $1`, [requestId]);
    expect(rows[0]).toEqual({ n: 1 });
  });

  test('a missing conversation is created on demand (e.g. requests accepted before the migration)', async () => {
    const { borrower, requestId } = await scenario('accepted');
    await db.query(`delete from public.conversations where borrow_request_id = $1`, [requestId]);
    const id = await openConversation(borrower, requestId);
    expect(id).toBeTruthy();
    expect(await conversationOf(requestId)).toBe(id);
  });

  test('outsiders and unknown ids get null, revealing nothing', async () => {
    const { outsider, requestId } = await scenario('accepted');
    expect(await openConversation(outsider, requestId)).toBeNull();
    expect(await openConversation(outsider, randomUUID())).toBeNull();
  });

  test('users cannot create, change or delete conversations directly', async () => {
    const { borrower, lender, outsider, listing, requestId } = await scenario('accepted');
    const id = (await conversationOf(requestId))!;
    expect(
      await sqlState(
        as(outsider, `insert into public.conversations (borrow_request_id, listing_id, borrower_id, lender_id) values ($1, $2, $3, $4)`, [
          requestId, listing, outsider, lender,
        ]),
      ),
    ).toBe('42501');
    expect(await sqlState(as(borrower, `update public.conversations set borrower_id = $2 where id = $1`, [id, outsider]))).toBe('42501');
    expect(await sqlState(as(lender, `delete from public.conversations where id = $1`, [id]))).toBe('42501');
  });

  test('private helpers are not callable by users', async () => {
    const { borrower, requestId } = await scenario('accepted');
    expect(await sqlState(as(borrower, `select public.ensure_conversation($1)`, [requestId]))).toBe('42501');
  });
});

describe('reading', () => {
  test('only the two participants can read the conversation and its messages', async () => {
    const { borrower, lender, outsider, requestId } = await scenario('accepted');
    const id = (await conversationOf(requestId))!;
    await send(borrower, id, 'Hi, when can I pick it up?');

    for (const who of [borrower, lender]) {
      expect(await as(who, `select id from public.conversations where id = $1`, [id])).toHaveLength(1);
      expect(await as(who, `select id from public.messages where conversation_id = $1`, [id])).toHaveLength(1);
    }
    expect(await as(outsider, `select id from public.conversations where id = $1`, [id])).toHaveLength(0);
    expect(await as(outsider, `select id from public.messages where conversation_id = $1`, [id])).toHaveLength(0);
    expect(await as(outsider, `select * from public.list_messages($1)`, [id])).toHaveLength(0);
    expect((await listConversations(outsider)).items.map((c) => c.id)).not.toContain(id);
  });

  test('anonymous callers can read nothing and call nothing', async () => {
    const { borrower, requestId } = await scenario('accepted');
    const id = (await conversationOf(requestId))!;
    await send(borrower, id, 'Hello');
    for (const sql of [`select * from public.conversations`, `select * from public.messages`, `select public.list_conversations()`]) {
      expect(await sqlState(asRole(db, 'anon', null, (tx) => tx.query(sql))), sql).toBe('42501');
    }
  });

  test('list_conversations shows the listing, request, other participant, last message and unread count', async () => {
    const { borrower, lender, listing, requestId } = await scenario('accepted');
    const id = (await conversationOf(requestId))!;
    await send(borrower, id, 'First');
    await send(borrower, id, 'Second');

    const forLender = (await listConversations(lender)).items.find((c) => c.id === id)!;
    expect(forLender).toMatchObject({
      borrow_request_id: requestId,
      viewer_role: 'lender',
      request: { id: requestId, status: 'accepted' },
      listing: { id: listing, title: 'Camping tent', archived: false },
      other: { id: borrower, display_name: 'Borrower' },
      last_message: { body: 'Second', sender_id: borrower },
      unread_count: 2,
    });
    // Own messages never count as unread.
    const forBorrower = (await listConversations(borrower)).items.find((c) => c.id === id)!;
    expect(forBorrower).toMatchObject({ viewer_role: 'borrower', other: { id: lender, display_name: 'Lender' }, unread_count: 0 });

    expect(await as(lender, `select public.mark_conversation_read($1) as ok`, [id])).toEqual([{ ok: true }]);
    expect((await listConversations(lender)).items.find((c) => c.id === id)!.unread_count).toBe(0);
  });

  test('mark_conversation_read is refused for outsiders', async () => {
    const { outsider, requestId } = await scenario('accepted');
    const id = (await conversationOf(requestId))!;
    expect(await as(outsider, `select public.mark_conversation_read($1) as ok`, [id])).toEqual([{ ok: false }]);
  });

  test('history pages newest first with a (created_at, id) cursor and no gaps or repeats', async () => {
    const { borrower, lender, requestId } = await scenario('accepted');
    const id = (await conversationOf(requestId))!;
    // Each send is its own transaction, so timestamps increase.
    for (let i = 1; i <= 7; i++) await send(i % 2 ? borrower : lender, id, `m${i}`);

    const seen: string[] = [];
    let cursor: { created_at: string; id: string } | null = null;
    for (;;) {
      const page: { id: string; body: string; created_at: string }[] = await as(
        lender,
        `select id, body, created_at from public.list_messages($1, $2, $3, 3)`,
        [id, cursor?.created_at ?? null, cursor?.id ?? null],
      );
      if (page.length === 0) break;
      seen.push(...page.map((m) => m.body));
      cursor = page[page.length - 1]!;
    }
    expect(seen).toEqual(['m7', 'm6', 'm5', 'm4', 'm3', 'm2', 'm1']);
  });
});

describe('sending', () => {
  test('a participant sends; the server sets id, sender and time', async () => {
    const { borrower, lender, requestId } = await scenario('accepted');
    const id = (await conversationOf(requestId))!;
    const r = await send(lender, id, 'Pick it up after 5pm');
    expect(r.created).toBe(true);
    expect(r.message).toMatchObject({ body: 'Pick it up after 5pm', sender_id: lender });
    expect(r.message.id).toBeTruthy();
    const reply = await send(borrower, id, 'Great, thanks');
    expect(reply.message.sender_id).toBe(borrower);
  });

  test('a retry with the same client id stores the message once', async () => {
    const { borrower, requestId } = await scenario('accepted');
    const id = (await conversationOf(requestId))!;
    const clientId = randomUUID();
    const first = await send(borrower, id, 'Hello', clientId);
    const again = await send(borrower, id, 'Hello', clientId);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.message.id).toBe(first.message.id);
    const { rows } = await db.query(`select count(*)::int as n from public.messages where conversation_id = $1`, [id]);
    expect(rows[0]).toEqual({ n: 1 });
    // Reusing the id for a different text is refused, not silently merged.
    expect(await sqlState(send(borrower, id, 'Something else', clientId))).toBe('NSC03');
  });

  test('empty, blank and over-long messages are refused', async () => {
    const { borrower, requestId } = await scenario('accepted');
    const id = (await conversationOf(requestId))!;
    for (const body of ['', '   ', '\n\t ', 'x'.repeat(2001)]) {
      expect(await sqlState(send(borrower, id, body)), JSON.stringify(body.slice(0, 5))).toBe('23514');
    }
    expect((await send(borrower, id, 'x'.repeat(2000))).created).toBe(true);
  });

  test('outsiders cannot send, through the function or directly', async () => {
    const { outsider, borrower, requestId } = await scenario('accepted');
    const id = (await conversationOf(requestId))!;
    expect(await sqlState(send(outsider, id, 'Hi'))).toBe('NSC02');
    expect(
      await sqlState(
        as(outsider, `insert into public.messages (conversation_id, sender_id, client_id, body) values ($1, $2, $3, 'hi')`, [
          id, outsider, randomUUID(),
        ]),
      ),
    ).toBe('42501');
    // Nor can a participant send in someone else's name.
    expect(
      await sqlState(
        as(outsider, `insert into public.messages (conversation_id, sender_id, client_id, body) values ($1, $2, $3, 'hi')`, [
          id, borrower, randomUUID(),
        ]),
      ),
    ).toBe('42501');
  });

  test('a participant cannot impersonate the other participant', async () => {
    const { lender, borrower, requestId } = await scenario('accepted');
    const id = (await conversationOf(requestId))!;
    expect(
      await sqlState(
        as(borrower, `insert into public.messages (conversation_id, sender_id, client_id, body) values ($1, $2, $3, 'hi')`, [
          id, lender, randomUUID(),
        ]),
      ),
    ).toBe('42501');
  });

  test('the id and timestamp cannot be chosen by the client', async () => {
    const { borrower, requestId } = await scenario('accepted');
    const id = (await conversationOf(requestId))!;
    expect(
      await sqlState(
        as(borrower, `insert into public.messages (conversation_id, sender_id, client_id, body, created_at)
                      values ($1, $2, $3, 'hi', '2020-01-01')`, [id, borrower, randomUUID()]),
      ),
    ).toBe('42501');
  });

  test('messages cannot be edited or deleted', async () => {
    const { borrower, requestId } = await scenario('accepted');
    const id = (await conversationOf(requestId))!;
    const { message } = await send(borrower, id, 'Original');
    expect(await sqlState(as(borrower, `update public.messages set body = 'Edited' where id = $1`, [message.id]))).toBe('42501');
    expect(await sqlState(as(borrower, `delete from public.messages where id = $1`, [message.id]))).toBe('42501');
  });

  test('suspended accounts cannot send; restricted ones can', async () => {
    const { borrower, lender, requestId } = await scenario('accepted');
    const id = (await conversationOf(requestId))!;
    await db.query(`update public.profiles set account_status = 'suspended' where id = $1`, [borrower]);
    expect(await sqlState(send(borrower, id, 'Hi'))).toBe('42501');
    await db.query(`update public.profiles set account_status = 'restricted' where id = $1`, [lender]);
    expect((await send(lender, id, 'Hi')).created).toBe(true);
  });

  test('a conversation whose request is no longer accepted refuses messages', async () => {
    // Accepted is final in this phase; this guards later phases that add
    // states after acceptance.
    const { borrower, requestId } = await scenario('accepted');
    const id = (await conversationOf(requestId))!;
    await db.query(`alter table public.borrow_requests disable trigger borrow_requests_before_update`);
    try {
      await db.query(`update public.borrow_requests set status = 'cancelled', decided_at = null, cancelled_at = now() where id = $1`, [requestId]);
    } finally {
      await db.query(`alter table public.borrow_requests enable trigger borrow_requests_before_update`);
    }
    expect(await sqlState(send(borrower, id, 'Hi'))).toBe('NSC01');
    expect(
      await sqlState(
        as(borrower, `insert into public.messages (conversation_id, sender_id, client_id, body) values ($1, $2, $3, 'hi')`, [
          id, borrower, randomUUID(),
        ]),
      ),
    ).toBe('42501');
  });

  test('archiving the listing keeps the conversation open', async () => {
    const { borrower, lender, listing, requestId } = await scenario('accepted');
    const id = (await conversationOf(requestId))!;
    await as(lender, `update public.listings set archived_at = now() where id = $1`, [listing]);
    expect((await send(borrower, id, 'Still on for Saturday?')).created).toBe(true);
    expect((await listConversations(borrower)).items.find((c) => c.id === id)!.listing.archived).toBe(true);
  });

  test('sending moves the conversation to the top and counts as read by the sender', async () => {
    const { lender, borrower, requestId } = await scenario('accepted');
    // A second accepted request between the same two people, on another listing.
    const otherListing = await seedListing(lender);
    const [second] = await as<{ id: string }>(
      borrower,
      `insert into public.borrow_requests (listing_id, borrower_id, start_date, end_date) values ($1, $2, $3, $4) returning id`,
      [otherListing, borrower, day(5), day(6)],
    );
    await as(lender, `update public.borrow_requests set status = 'accepted' where id = $1`, [second!.id]);
    const [first, latest] = [(await conversationOf(requestId))!, (await conversationOf(second!.id))!];

    expect((await listConversations(lender)).items.map((c) => c.id)).toEqual([latest, first]);
    await send(borrower, first, 'Ping');
    expect((await listConversations(lender)).items.map((c) => c.id)).toEqual([first, latest]);

    const row = (await db.query<{ last_message_at: string | null; borrower_last_read_at: string | null }>(
      `select last_message_at, borrower_last_read_at from public.conversations where id = $1`, [first],
    )).rows[0]!;
    expect(row.last_message_at).not.toBeNull();
    expect(row.borrower_last_read_at).toEqual(row.last_message_at);
  });
});
