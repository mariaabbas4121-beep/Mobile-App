// Returns and due-date extensions through the API, with in-memory
// repositories that apply the migration's rules (tests/db/returns.test.ts
// checks the same rules on the real migration).
import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { AppError } from '../../src/lib/errors.js';
import type { AuthUser } from '../../src/auth/auth.types.js';
import type { HandoverChangedEvent } from '../../src/handover/handover.service.js';
import { codeFromScan, hashPickupCode, returnQrPayload } from '../../src/handover/pickup-code.js';
import { OTHER_TOKEN, VALID_TOKEN, profileFor, testApp, userA } from '../helpers.js';

const NOW = Date.parse('2026-11-10T06:00:00Z');
const DAY = 86_400_000;
const THIRD_TOKEN = 'header.payload-user-c.signature';
const lender = userA;
const borrower: AuthUser = { ...userA, id: '00000000-0000-4000-8000-00000000000b', email: 'b@example.test' };
const outsider: AuthUser = { ...userA, id: '00000000-0000-4000-8000-00000000000c', email: 'c@example.test' };
const asLender = { Authorization: `Bearer ${VALID_TOKEN}` };
const asBorrower = { Authorization: `Bearer ${OTHER_TOKEN}` };
const asOutsider = { Authorization: `Bearer ${THIRD_TOKEN}` };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);

let t: ReturnType<typeof testApp>;
let listingId: string;
let published: HandoverChangedEvent[];

beforeEach(async () => {
  t = testApp({ now: () => NOW });
  t.gateway.getUser.mockImplementation(async (token) => {
    const user = { [VALID_TOKEN]: lender, [OTHER_TOKEN]: borrower, [THIRD_TOKEN]: outsider }[token];
    if (!user) throw AppError.unauthenticated('Access token is invalid or expired', 'INVALID_TOKEN');
    return { user, roles: [] };
  });
  t.profiles.getProfile.mockImplementation(async (_token, userId) => {
    const user = [lender, borrower, outsider].find((u) => u.id === userId);
    return user ? profileFor(user, { accountStatus: 'active' }) : null;
  });
  published = [];
  t.returnEvents.subscribe((e) => published.push(e));
  const created = await request(t.app)
    .post('/api/v1/items')
    .set(asLender)
    .send({ title: 'Camping tent', description: 'Four person tent, waterproof.', category: 'outdoor', condition: 'good' });
  listingId = created.body.data.listing.id;
});

const base = (id: string) => `/api/v1/borrow-requests/${id}`;

// Accepted 12-14 Nov, picked up in person unless told otherwise.
async function borrowed({ pickedUp = true, start = '2026-11-12', end = '2026-11-14' } = {}) {
  const res = await request(t.app).post('/api/v1/borrow-requests').set(asBorrower).send({ listingId, startDate: start, endDate: end });
  expect(res.status).toBe(201);
  const id = res.body.data.request.id as string;
  expect((await request(t.app).post(`${base(id)}/accept`).set(asLender).send({})).status).toBe(200);
  if (pickedUp) {
    expect((await request(t.app).post(`${base(id)}/handover`).set(asLender).send({ method: 'personal', confirm: true })).status).toBe(201);
  }
  return id;
}

const state = (id: string, headers = asBorrower) => request(t.app).get(`${base(id)}/return`).set(headers);
const initiate = (id: string, body: Record<string, unknown> = { method: 'personal', confirm: true }, headers = asBorrower) =>
  request(t.app).post(`${base(id)}/return`).set(headers).send(body);
const authorize = (id: string, headers = asBorrower, body: Record<string, unknown> = {}) =>
  request(t.app)
    .post(`${base(id)}/return-authorizations`)
    .set(headers)
    .send({ recipientName: 'Bilal', recipientPhone: '0300 111 2233', note: 'My cousin', confirm: true, ...body });
const verify = (id: string, code: string, headers = asLender) => request(t.app).post(`${base(id)}/return/verify`).set(headers).send({ code });
const confirm = (id: string, body: Record<string, unknown>, headers = asLender) =>
  request(t.app).post(`${base(id)}/return/confirm`).set(headers).send({ confirm: true, ...body });
const extend = (id: string, requestedEndDate: string, headers = asBorrower) =>
  request(t.app).post(`${base(id)}/extensions`).set(headers).send({ requestedEndDate, reason: 'Trip got longer' });
const decide = (id: string, extId: string, decision: 'approve' | 'reject', headers = asLender) =>
  request(t.app).post(`${base(id)}/extensions/${extId}/${decision}`).set(headers).send({});

describe('return codes', () => {
  test('use their own QR route; a pickup QR is not a return code and vice versa', () => {
    const code = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
    expect(returnQrPayload(code)).toBe(`neighborshare://return?v=1&code=${code}`);
    expect(codeFromScan(returnQrPayload(code), 'return')).toBe(code);
    expect(codeFromScan(returnQrPayload(code), 'pickup')).toBeNull();
    expect(codeFromScan(`neighborshare://pickup?v=1&code=${code}`, 'return')).toBeNull();
  });
});

describe('initiating a return', () => {
  test('state before and after: ready, then awaiting the lender; delivery details kept; both told', async () => {
    const id = await borrowed();
    expect((await state(id)).body.data.return).toMatchObject({ status: 'ready', dueDate: '2026-11-14', overdue: false, return: null });
    const res = await initiate(id, { method: 'delivery', deliveryProvider: 'TCS', deliveryReference: 'TRK-123', deliveryNote: 'Gate', confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.data.return).toMatchObject({
      status: 'awaiting_confirmation',
      return: { method: 'delivery', delivery: { provider: 'TCS', reference: 'TRK-123', note: 'Gate' }, confirmedAt: null },
    });
    expect(published).toEqual([{ borrowRequestId: id, participantIds: [borrower.id, lender.id] }]);
  });

  test('needs confirmation; only the borrower; only after pickup', async () => {
    const id = await borrowed();
    expect((await initiate(id, { method: 'personal' })).status).toBe(400);
    expect((await initiate(id, { method: 'authorized', confirm: true })).status).toBe(400);
    expect((await initiate(id, { method: 'personal', confirm: true, borrowerId: lender.id })).status).toBe(400);
    expect((await initiate(id, undefined, asLender)).status).toBe(403);
    expect((await initiate(id, undefined, asOutsider)).status).toBe(404);
    const notPicked = await borrowed({ pickedUp: false, start: '2026-11-20', end: '2026-11-21' });
    expect((await initiate(notPicked)).body.code).toBe('NOT_PICKED_UP');
  });
});

describe('third-party return authorization', () => {
  test('code returned once, stored hashed, return QR; a replacement revokes the old code', async () => {
    const id = await borrowed();
    const res = await authorize(id);
    expect(res.status).toBe(201);
    const { authorization, code, qrPayload } = res.body.data;
    expect(authorization).toMatchObject({ operation: 'return', status: 'active', recipientName: 'Bilal', recipientPhone: '03001112233' });
    expect(qrPayload).toBe(`neighborshare://return?v=1&code=${code}`);
    const stored = [...t.returns.authorizations.values()][0]!;
    expect(stored.tokenHash).toBe(hashPickupCode(code));
    expect(JSON.stringify((await state(id)).body)).not.toContain(code);

    const second = (await authorize(id)).body.data;
    expect((await verify(id, code)).body.code).toBe('AUTHORIZATION_REVOKED');
    expect((await verify(id, second.code)).status).toBe(200);
    const s = (await state(id)).body.data.return;
    expect(s.authorizations.map((a: { status: string }) => a.status)).toEqual(['active', 'revoked']);
    expect(s.return).toMatchObject({ method: 'authorized', confirmedAt: null });
  });

  test('the lender, an outsider, and anyone before pickup are refused; revoke is borrower-only', async () => {
    const id = await borrowed();
    expect((await authorize(id, asLender)).status).toBe(403);
    expect((await authorize(id, asOutsider)).status).toBe(404);
    const { authorization } = (await authorize(id)).body.data;
    const revoke = (headers: Record<string, string>) =>
      request(t.app).post(`${base(id)}/return-authorizations/${authorization.id}/revoke`).set(headers).send({});
    expect((await revoke(asLender)).status).toBe(403);
    expect((await revoke(asBorrower)).body.data.authorization).toMatchObject({ status: 'revoked' });
    expect((await revoke(asBorrower)).body.code).toBe('AUTHORIZATION_NOT_ACTIVE');
  });
});

describe('verifying and confirming receipt', () => {
  test('verify shows the person and changes nothing; the lender confirms once with notes', async () => {
    const id = await borrowed();
    const { code, qrPayload, authorization } = (await authorize(id)).body.data;
    const v = await verify(id, qrPayload);
    expect(v.status).toBe(200);
    expect(v.body.data.authorization).toMatchObject({ recipientName: 'Bilal', status: 'active' });
    expect((await state(id)).body.data.return.status).toBe('awaiting_confirmation');

    const res = await confirm(id, { method: 'authorized', code, conditionNotes: 'Pole slightly bent' });
    expect(res.status).toBe(201);
    expect(res.body.data.return).toMatchObject({
      method: 'authorized',
      authorizationId: authorization.id,
      recipientName: 'Bilal',
      conditionNotes: 'Pole slightly bent',
      confirmedBy: { id: lender.id },
    });
    expect((await state(id)).body.data.return).toMatchObject({ status: 'returned', overdue: false });
    // Duplicate and replayed confirmations.
    expect((await confirm(id, { method: 'authorized', code })).body.code).toBe('ALREADY_RETURNED');
    expect((await confirm(id, { method: 'personal' })).body.code).toBe('ALREADY_RETURNED');
    // The borrow request itself stays accepted.
    expect((await request(t.app).get(base(id)).set(asBorrower)).body.data.request.status).toBe('accepted');
  });

  test('wrong borrower, wrong lender and unrelated users cannot verify or confirm', async () => {
    const id = await borrowed();
    const { code } = (await authorize(id)).body.data;
    expect((await verify(id, code, asBorrower)).status).toBe(403);
    expect((await confirm(id, { method: 'authorized', code }, asBorrower)).status).toBe(403);
    expect((await confirm(id, { method: 'personal' }, asBorrower)).status).toBe(403);
    expect((await verify(id, code, asOutsider)).status).toBe(404);
    expect((await confirm(id, { method: 'authorized', code }, asOutsider)).status).toBe(404);
    expect([...t.returns.returns.values()][0]!.confirmedAt).toBeNull();
  });

  test('invalid, expired, revoked and already-used codes are refused; a code works for its own request only', async () => {
    const id = await borrowed();
    const other = await borrowed({ start: '2026-11-20', end: '2026-11-22' });
    const { code } = (await authorize(id)).body.data;
    expect((await verify(id, 'ABCDEFGHJKMNPQRSTVWXYZ0123456789')).body.code).toBe('INVALID_RETURN_CODE');
    await initiate(other);
    expect((await confirm(other, { method: 'authorized', code })).body.code).toBe('INVALID_RETURN_CODE');

    t.returns.advance(24 * 3_600_000 + 60_000);
    expect((await verify(id, code)).body.code).toBe('AUTHORIZATION_EXPIRED');
    expect((await confirm(id, { method: 'authorized', code })).body.code).toBe('AUTHORIZATION_EXPIRED');

    const fresh = (await authorize(id)).body.data;
    await confirm(id, { method: 'authorized', code: fresh.code });
    // Used: the return is complete, so the code can never work again.
    expect((await verify(id, fresh.code)).body.code).toBe('ALREADY_RETURNED');
  });

  test('pickup and return codes never work for each other', async () => {
    const id = await borrowed({ pickedUp: false });
    const pickup = (await request(t.app).post(`${base(id)}/pickup-authorizations`).set(asBorrower).send({ recipientName: 'Ali', confirm: true })).body.data;
    // A pickup QR is refused by return verification before any lookup.
    expect((await verify(id, pickup.qrPayload)).status).toBe(400);
    expect(t.returns.verifyCode).not.toHaveBeenCalled();
    await request(t.app).post(`${base(id)}/handover`).set(asLender).send({ method: 'authorized', code: pickup.code, confirm: true });
    // The bare pickup code is not a return code.
    expect((await verify(id, pickup.code)).body.code).toBe('INVALID_RETURN_CODE');
    const ret = (await authorize(id)).body.data;
    // A return QR is refused by pickup verification.
    expect((await request(t.app).post(`${base(id)}/handover/verify`).set(asLender).send({ code: ret.qrPayload })).status).toBe(400);
    expect((await request(t.app).post(`${base(id)}/handover`).set(asLender).send({ method: 'authorized', code: ret.code, confirm: true })).body.code).toBe(
      'ALREADY_HANDED_OVER',
    );
  });

  test('personal or delivery receipt needs an initiated return and retires an unused code', async () => {
    const id = await borrowed();
    expect((await confirm(id, { method: 'personal' })).body.code).toBe('RETURN_NOT_INITIATED');
    expect((await confirm(id, { method: 'personal', code: 'x' })).status).toBe(400);
    const { code } = (await authorize(id)).body.data;
    expect((await confirm(id, { method: 'delivery' })).status).toBe(201);
    const s = (await state(id)).body.data.return;
    expect(s.authorizations[0]).toMatchObject({ status: 'revoked' });
    expect(s.return).toMatchObject({ method: 'delivery', recipientName: null });
    expect((await verify(id, code)).body.code).toBe('ALREADY_RETURNED');
  });

  test('concurrent confirmations record exactly one receipt', async () => {
    const id = await borrowed();
    const { code } = (await authorize(id)).body.data;
    const results = await Promise.all([
      confirm(id, { method: 'authorized', code }),
      confirm(id, { method: 'authorized', code }),
      confirm(id, { method: 'personal' }),
      verify(id, code),
    ]);
    expect(results.slice(0, 3).map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect([...t.returns.returns.values()].filter((x) => x.confirmedAt)).toHaveLength(1);
    expect(t.returns.events.filter((e) => e.kind === 'return_confirmed')).toHaveLength(1);
  });
});

describe('return evidence', () => {
  const upload = (id: string, headers = asLender, body = JPEG, type = 'image/jpeg') =>
    request(t.app).post(`${base(id)}/return/photos`).set(headers).set('Content-Type', type).send(body);

  test('after confirmation, by the confirming lender, at most 5; private signed URLs for participants', async () => {
    const id = await borrowed();
    await initiate(id);
    expect((await upload(id)).body.code).toBe('RETURN_NOT_CONFIRMED');
    await confirm(id, { method: 'personal' });
    expect((await upload(id, asBorrower)).status).toBe(403);
    expect((await upload(id, asOutsider)).status).toBe(404);
    for (let i = 0; i < 5; i++) expect((await upload(id)).status).toBe(201);
    expect((await upload(id)).body.code).toBe('EVIDENCE_LIMIT_REACHED');
    const photos = (await state(id)).body.data.return.return.photos;
    expect(photos).toHaveLength(5);
    expect(new Set(photos.map((p: { id: string }) => p.id)).size).toBe(5);
    expect(photos[0].url).toMatch(/^https:\/\/storage\.test\/signed\//);
    expect((await state(id, asOutsider)).status).toBe(404);
  });

  test('files over 5 MB and non-images are refused', async () => {
    const id = await borrowed();
    await initiate(id);
    await confirm(id, { method: 'personal' });
    const big = Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]);
    expect((await upload(id, asLender, big)).status).toBe(413);
    expect((await upload(id, asLender, Buffer.from('not an image'))).status).toBe(415);
    expect(t.returns.addPhoto).not.toHaveBeenCalled();
  });

  test('a failed upload leaves the confirmed return intact, and can be retried', async () => {
    const id = await borrowed();
    await initiate(id);
    await confirm(id, { method: 'personal' });
    t.returns.addPhoto.mockRejectedValueOnce(AppError.unavailable('down', 'STORAGE_UNAVAILABLE'));
    expect((await upload(id)).status).toBe(503);
    expect((await state(id)).body.data.return.status).toBe('returned');
    expect((await upload(id)).status).toBe(201);
  });

  test('closes 24 hours after confirmation', async () => {
    const id = await borrowed();
    await initiate(id);
    await confirm(id, { method: 'personal' });
    t.returns.advance(24 * 3_600_000 + 60_000);
    expect((await upload(id)).body.code).toBe('EVIDENCE_WINDOW_CLOSED');
  });
});

describe('due-date extensions', () => {
  test('a valid request stays pending without moving the due date; approval moves it; history kept', async () => {
    const id = await borrowed();
    const res = await extend(id, '2026-11-18');
    expect(res.status).toBe(201);
    const ext = res.body.data.extension;
    expect(ext).toMatchObject({ status: 'pending', previousEndDate: '2026-11-14', requestedEndDate: '2026-11-18', requestedWhileOverdue: false });
    expect((await state(id)).body.data.return).toMatchObject({ dueDate: '2026-11-14', pendingExtension: { id: ext.id } });
    expect((await extend(id, '2026-11-19')).body.code).toBe('EXTENSION_PENDING');

    expect((await decide(id, ext.id, 'approve', asBorrower)).status).toBe(403);
    expect((await decide(id, ext.id, 'approve', asOutsider)).status).toBe(404);
    const approved = await decide(id, ext.id, 'approve');
    expect(approved.body.data.extension).toMatchObject({ status: 'approved', overdueAtDecision: false });
    expect((await state(id)).body.data.return).toMatchObject({ dueDate: '2026-11-18', originalDueDate: '2026-11-14', pendingExtension: null });
    expect((await decide(id, ext.id, 'reject')).body.code).toBe('EXTENSION_ALREADY_DECIDED');
    // The booking itself now ends later, so nobody else can take those days.
    expect((await request(t.app).get(base(id)).set(asBorrower)).body.data.request.endDate).toBe('2026-11-18');
  });

  test('rejection leaves the due date unchanged', async () => {
    const id = await borrowed();
    const ext = (await extend(id, '2026-11-16')).body.data.extension;
    expect((await decide(id, ext.id, 'reject')).body.data.extension).toMatchObject({ status: 'rejected' });
    expect((await state(id)).body.data.return.dueDate).toBe('2026-11-14');
  });

  test('invalid dates and the wrong people are refused', async () => {
    const id = await borrowed();
    for (const bad of ['2026-11-14', '2026-11-13', '2026-12-12']) expect((await extend(id, bad)).body.code).toBe('INVALID_EXTENSION_DATE');
    expect((await extend(id, '2026-02-30')).status).toBe(400);
    expect((await extend(id, 'next week')).status).toBe(400);
    expect((await extend(id, '2026-11-18', asLender)).status).toBe(403);
    expect((await extend(id, '2026-11-18', asOutsider)).status).toBe(404);
  });

  test('overdue uses the approved due date and the server’s Pakistan date', async () => {
    const id = await borrowed();
    // 17 Nov in Pakistan: three days past the 14th.
    t.returns.advance(7 * DAY);
    let s = (await state(id)).body.data.return;
    expect(s).toMatchObject({ today: '2026-11-17', overdue: true, daysOverdue: 3 });
    const ext = (await extend(id, '2026-11-20')).body.data.extension;
    expect(ext.requestedWhileOverdue).toBe(true);
    // Still overdue while pending.
    expect((await state(id)).body.data.return.overdue).toBe(true);
    const approved = (await decide(id, ext.id, 'approve')).body.data.extension;
    expect(approved.overdueAtDecision).toBe(true);
    s = (await state(id)).body.data.return;
    expect(s).toMatchObject({ dueDate: '2026-11-20', overdue: false, daysOverdue: 0 });
    expect(s.extensions[0]).toMatchObject({ requestedWhileOverdue: true, overdueAtDecision: true });
  });

  test('not overdue before pickup', async () => {
    const id = await borrowed({ pickedUp: false });
    t.returns.advance(7 * DAY);
    expect((await state(id)).body.data.return).toMatchObject({ status: 'not_picked_up', overdue: false });
  });
});

describe('activity', () => {
  test('return and extension events for both participants only', async () => {
    const id = await borrowed();
    const { code } = (await authorize(id)).body.data;
    await confirm(id, { method: 'authorized', code });
    const other = await borrowed({ start: '2026-11-20', end: '2026-11-21' });
    await extend(other, '2026-11-23');
    const types = async (headers: Record<string, string>) =>
      ((await request(t.app).get('/api/v1/activity').set(headers)).body.data.items as { type: string }[]).map((i) => i.type);
    for (const headers of [asLender, asBorrower]) {
      expect(await types(headers)).toEqual(
        expect.arrayContaining(['return_initiated', 'return_authorized', 'return_authorization_redeemed', 'item_returned', 'extension_requested']),
      );
    }
    expect((await types(asOutsider)).some((x) => x.startsWith('return') || x.startsWith('extension') || x === 'item_returned')).toBe(false);
    const items = (await request(t.app).get('/api/v1/activity').set(asLender)).body.data.items;
    expect(items.find((i: { type: string }) => i.type === 'item_returned')).toMatchObject({ returnMethod: 'authorized', recipientName: 'Bilal' });
    expect(items.find((i: { type: string }) => i.type === 'extension_requested')).toMatchObject({ requestedEndDate: '2026-11-23' });
  });
});

describe('access', () => {
  test('every endpoint needs a token', async () => {
    const id = await borrowed();
    expect((await request(t.app).get(`${base(id)}/return`)).status).toBe(401);
    for (const path of ['return', 'return-authorizations', 'return/verify', 'return/confirm', 'extensions']) {
      expect((await request(t.app).post(`${base(id)}/${path}`).send({})).status).toBe(401);
    }
  });
});
