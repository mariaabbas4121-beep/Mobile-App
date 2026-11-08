// Pickup authorization and handover through the API, with in-memory
// repositories that apply the migration's rules (tests/db/handover.test.ts
// checks the same rules on the real migration).
import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { AppError } from '../../src/lib/errors.js';
import type { AuthUser } from '../../src/auth/auth.types.js';
import type { HandoverChangedEvent } from '../../src/handover/handover.service.js';
import { codeFromScan, generatePickupCode, hashPickupCode, normalizePickupCode, pickupQrPayload } from '../../src/handover/pickup-code.js';
import { OTHER_TOKEN, VALID_TOKEN, profileFor, testApp, userA } from '../helpers.js';

const NOW = Date.parse('2026-11-10T06:00:00Z');
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
  t.handoverEvents.subscribe((e) => published.push(e));
  const created = await request(t.app)
    .post('/api/v1/items')
    .set(asLender)
    .send({ title: 'Camping tent', description: 'Four person tent, waterproof.', category: 'outdoor', condition: 'good' });
  listingId = created.body.data.listing.id;
});

async function borrowRequest(decision?: 'accept' | 'decline' | 'cancel', start = '2026-11-12') {
  const res = await request(t.app).post('/api/v1/borrow-requests').set(asBorrower).send({ listingId, startDate: start, endDate: start });
  expect(res.status).toBe(201);
  const id = res.body.data.request.id as string;
  if (decision) {
    expect((await request(t.app).post(`/api/v1/borrow-requests/${id}/${decision}`).set(decision === 'cancel' ? asBorrower : asLender).send({})).status).toBe(200);
  }
  return id;
}

const authorize = (id: string, headers = asBorrower, body: Record<string, unknown> = {}) =>
  request(t.app)
    .post(`/api/v1/borrow-requests/${id}/pickup-authorizations`)
    .set(headers)
    .send({ recipientName: 'Ali Khan', recipientPhone: '0300 123-4567', note: 'My brother', confirm: true, ...body });
const verify = (id: string, code: string, headers = asLender) =>
  request(t.app).post(`/api/v1/borrow-requests/${id}/handover/verify`).set(headers).send({ code });
const confirmAuthorized = (id: string, code: string, headers = asLender, notes?: string) =>
  request(t.app)
    .post(`/api/v1/borrow-requests/${id}/handover`)
    .set(headers)
    .send({ method: 'authorized', code, confirm: true, ...(notes ? { conditionNotes: notes } : {}) });
const confirmPersonal = (id: string, headers = asLender) =>
  request(t.app).post(`/api/v1/borrow-requests/${id}/handover`).set(headers).send({ method: 'personal', confirm: true });
const state = (id: string, headers = asBorrower) => request(t.app).get(`/api/v1/borrow-requests/${id}/handover`).set(headers);

describe('pickup codes', () => {
  test('are 32 characters from a CSPRNG, accept typing variations, and the QR carries only route, version and code', () => {
    const codes = new Set(Array.from({ length: 200 }, generatePickupCode));
    expect(codes.size).toBe(200);
    const code = [...codes][0]!;
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{32}$/);
    const typed = code.toLowerCase().match(/.{4}/g)!.join('-');
    expect(normalizePickupCode(typed)).toBe(code);
    expect(pickupQrPayload(code)).toBe(`neighborshare://pickup?v=1&code=${code}`);
    expect(codeFromScan(pickupQrPayload(code))).toBe(code);
    expect(codeFromScan(`neighborshare://pickup?v=2&code=${code}`)).toBeNull();
    expect(codeFromScan('https://example.com')).toBeNull();
    expect(hashPickupCode(code)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('creating an authorization', () => {
  test('the borrower gets the code once; only its hash is stored; both participants are told', async () => {
    const id = await borrowRequest('accept');
    const res = await authorize(id);
    expect(res.status).toBe(201);
    const { authorization, code, displayCode, qrPayload } = res.body.data;
    expect(authorization).toMatchObject({ status: 'active', operation: 'pickup', recipientName: 'Ali Khan', recipientPhone: '03001234567', note: 'My brother' });
    expect(Date.parse(authorization.expiresAt) - Date.parse(authorization.createdAt)).toBe(24 * 3_600_000);
    expect(qrPayload).toBe(`neighborshare://pickup?v=1&code=${code}`);
    expect(displayCode.replace(/-/g, '')).toBe(code);

    const stored = [...t.handovers.authorizations.values()][0]!;
    expect(stored.tokenHash).toBe(hashPickupCode(code));
    expect(JSON.stringify(stored)).not.toContain(code);
    // Never again: state has no code or hash.
    const s = await state(id);
    expect(JSON.stringify(s.body)).not.toContain(code);
    expect(JSON.stringify(s.body)).not.toContain(stored.tokenHash);
    expect(published).toEqual([{ borrowRequestId: id, participantIds: [borrower.id, lender.id] }]);
  });

  test('needs explicit confirmation and valid details; ids in the body are refused', async () => {
    const id = await borrowRequest('accept');
    expect((await authorize(id, asBorrower, { confirm: false })).status).toBe(400);
    expect((await authorize(id, asBorrower, { recipientName: 'A' })).status).toBe(400);
    expect((await authorize(id, asBorrower, { recipientPhone: 'call me' })).status).toBe(400);
    expect((await authorize(id, asBorrower, { borrowerId: lender.id })).status).toBe(400);
    expect((await authorize(id, asBorrower, { code: generatePickupCode() })).status).toBe(400);
    expect((await authorize(id, asBorrower, { recipientPhone: '', note: '' })).body.data.authorization).toMatchObject({ recipientPhone: null, note: null });
  });

  test('an unrelated user sees no request; the lender cannot authorize on the borrower’s behalf', async () => {
    const id = await borrowRequest('accept');
    expect((await authorize(id, asOutsider)).status).toBe(404);
    const byLender = await authorize(id, asLender);
    expect(byLender.status).toBe(403);
    expect(t.handovers.authorizations.size).toBe(0);
  });

  test('only for accepted requests', async () => {
    // One pending request per borrower per listing, so the pending one comes last.
    const declined = await borrowRequest('decline', '2026-11-14');
    const cancelled = await borrowRequest('cancel', '2026-11-16');
    const pending = await borrowRequest();
    for (const id of [pending, declined, cancelled]) {
      const res = await authorize(id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('REQUEST_NOT_ACCEPTED');
    }
  });

  test('one active at a time; revoke, then a new and different code for the same person', async () => {
    const id = await borrowRequest('accept');
    const first = (await authorize(id)).body.data;
    const again = await authorize(id);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ACTIVE_AUTHORIZATION_EXISTS');

    const revokeUrl = `/api/v1/borrow-requests/${id}/pickup-authorizations/${first.authorization.id}/revoke`;
    expect((await request(t.app).post(revokeUrl).set(asLender).send({})).status).toBe(403);
    expect((await request(t.app).post(revokeUrl).set(asOutsider).send({})).status).toBe(404);
    const revoked = await request(t.app).post(revokeUrl).set(asBorrower).send({});
    expect(revoked.body.data.authorization).toMatchObject({ status: 'revoked' });
    expect((await request(t.app).post(revokeUrl).set(asBorrower).send({})).body.code).toBe('AUTHORIZATION_NOT_ACTIVE');

    const second = (await authorize(id)).body.data;
    expect(second.authorization.id).not.toBe(first.authorization.id);
    expect(second.code).not.toBe(first.code);
    expect((await state(id)).body.data.handover.authorizations.map((a: { status: string }) => a.status)).toEqual(['active', 'revoked']);
  });
});

describe('verifying and redeeming', () => {
  test('scanning only shows who may collect; it never hands over', async () => {
    const id = await borrowRequest('accept');
    const { code, qrPayload } = (await authorize(id)).body.data;
    const res = await verify(id, qrPayload);
    expect(res.status).toBe(200);
    expect(res.body.data.authorization).toMatchObject({ recipientName: 'Ali Khan', status: 'active' });
    expect((await verify(id, code.toLowerCase())).status).toBe(200);
    expect((await state(id)).body.data.handover).toMatchObject({ status: 'pending', handover: null });
  });

  test('a wrong lender, the borrower or an outsider cannot redeem', async () => {
    const id = await borrowRequest('accept');
    const { code } = (await authorize(id)).body.data;
    expect((await verify(id, code, asBorrower)).status).toBe(403);
    expect((await confirmAuthorized(id, code, asBorrower)).status).toBe(403);
    expect((await verify(id, code, asOutsider)).status).toBe(404);
    expect((await confirmAuthorized(id, code, asOutsider)).status).toBe(404);
    expect(t.handovers.handovers.size).toBe(0);
  });

  test('the correct lender redeems and confirms: handover recorded once, with the recipient and notes', async () => {
    const id = await borrowRequest('accept');
    const { code, authorization } = (await authorize(id)).body.data;
    const res = await confirmAuthorized(id, code, asLender, 'Small scratch on the left pole');
    expect(res.status).toBe(201);
    expect(res.body.data.handover).toMatchObject({
      method: 'authorized',
      authorizationId: authorization.id,
      recipientName: 'Ali Khan',
      recipientPhone: '03001234567',
      conditionNotes: 'Small scratch on the left pole',
      confirmedBy: { id: lender.id },
      photos: [],
    });
    const s = (await state(id)).body.data.handover;
    expect(s).toMatchObject({ status: 'completed', requestStatus: 'accepted', activeAuthorization: null });
    expect(s.authorizations[0]).toMatchObject({ status: 'redeemed' });

    // Replay of the same code.
    const replay = await confirmAuthorized(id, code);
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe('ALREADY_HANDED_OVER');
    expect((await confirmPersonal(id)).body.code).toBe('ALREADY_HANDED_OVER');
    // The borrow request itself is untouched.
    expect((await request(t.app).get(`/api/v1/borrow-requests/${id}`).set(asBorrower)).body.data.request.status).toBe('accepted');
  });

  test('a code cannot be used for another request', async () => {
    const first = await borrowRequest('accept');
    const second = await borrowRequest('accept', '2026-11-20');
    const { code } = (await authorize(first)).body.data;
    const res = await confirmAuthorized(second, code);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PICKUP_CODE');
  });

  test('revoked and expired codes are rejected with a clear reason', async () => {
    const id = await borrowRequest('accept');
    const first = (await authorize(id)).body.data;
    await request(t.app).post(`/api/v1/borrow-requests/${id}/pickup-authorizations/${first.authorization.id}/revoke`).set(asBorrower).send({});
    expect((await verify(id, first.code)).body.code).toBe('AUTHORIZATION_REVOKED');
    expect((await confirmAuthorized(id, first.code)).body.code).toBe('AUTHORIZATION_REVOKED');

    const second = (await authorize(id)).body.data;
    t.handovers.advance(24 * 3_600_000 + 1);
    expect((await verify(id, second.code)).body.code).toBe('AUTHORIZATION_EXPIRED');
    expect((await confirmAuthorized(id, second.code)).body.code).toBe('AUTHORIZATION_EXPIRED');
    expect((await state(id)).body.data.handover.authorizations[0]).toMatchObject({ status: 'expired' });
    // An expired code does not block a replacement.
    expect((await authorize(id)).status).toBe(201);
  });

  test('garbage is refused before it reaches the database, without echoing it', async () => {
    const id = await borrowRequest('accept');
    const res = await verify(id, 'not-a-code-SECRET123');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('SECRET123');
    expect(t.handovers.verifyCode).not.toHaveBeenCalled();
  });

  test('concurrent confirmations create exactly one handover', async () => {
    const id = await borrowRequest('accept');
    const { code } = (await authorize(id)).body.data;
    const results = await Promise.all([confirmAuthorized(id, code), confirmAuthorized(id, code), confirmPersonal(id), confirmAuthorized(id, code)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect(t.handovers.handovers.size).toBe(1);
  });
});

describe('personal pickup', () => {
  test('the lender confirms explicitly; the borrower cannot confirm their own pickup', async () => {
    const id = await borrowRequest('accept');
    expect((await confirmPersonal(id, asBorrower)).status).toBe(403);
    const unconfirmed = await request(t.app).post(`/api/v1/borrow-requests/${id}/handover`).set(asLender).send({ method: 'personal' });
    expect(unconfirmed.status).toBe(400);
    const res = await confirmPersonal(id);
    expect(res.status).toBe(201);
    expect(res.body.data.handover).toMatchObject({ method: 'personal', recipientName: null, authorizationId: null });
    expect((await confirmPersonal(id)).body.code).toBe('ALREADY_HANDED_OVER');
  });

  test('collecting in person retires an unused authorization', async () => {
    const id = await borrowRequest('accept');
    const { code } = (await authorize(id)).body.data;
    await confirmPersonal(id);
    expect((await state(id)).body.data.handover.authorizations[0]).toMatchObject({ status: 'revoked' });
    expect((await confirmAuthorized(id, code)).body.code).toBe('ALREADY_HANDED_OVER');
  });

  test('not for requests that are not accepted', async () => {
    const id = await borrowRequest();
    expect((await confirmPersonal(id)).body.code).toBe('REQUEST_NOT_ACCEPTED');
  });
});

describe('condition evidence', () => {
  const upload = (id: string, headers = asLender, body = JPEG, type = 'image/jpeg') =>
    request(t.app).post(`/api/v1/borrow-requests/${id}/handover/photos`).set(headers).set('Content-Type', type).send(body);

  test('only after the handover, only by the confirming lender, at most 5', async () => {
    const id = await borrowRequest('accept');
    expect((await upload(id)).body.code).toBe('HANDOVER_NOT_CONFIRMED');
    await confirmPersonal(id);
    expect((await upload(id, asBorrower)).status).toBe(403);
    expect((await upload(id, asOutsider)).status).toBe(404);
    for (let i = 0; i < 5; i++) expect((await upload(id)).status).toBe(201);
    expect((await upload(id)).body.code).toBe('EVIDENCE_LIMIT_REACHED');
    expect((await upload(id, asLender, Buffer.from('not an image'))).status).toBe(415);
  });

  test('photos are visible to the two participants only, through signed URLs', async () => {
    const id = await borrowRequest('accept');
    await confirmPersonal(id);
    await upload(id);
    const forBorrower = await state(id, asBorrower);
    expect(forBorrower.body.data.handover.handover.photos).toHaveLength(1);
    expect(forBorrower.body.data.handover.handover.photos[0].url).toMatch(/^https:\/\/storage\.test\/signed\//);
    expect((await state(id, asOutsider)).status).toBe(404);
  });

  test('closes 24 hours after the handover', async () => {
    const id = await borrowRequest('accept');
    await confirmPersonal(id);
    t.handovers.advance(24 * 3_600_000 + 1);
    expect((await upload(id)).body.code).toBe('EVIDENCE_WINDOW_CLOSED');
  });
});

describe('activity', () => {
  test('pickup events appear for both participants only, with the authorized person’s name', async () => {
    const id = await borrowRequest('accept');
    const { code } = (await authorize(id)).body.data;
    await confirmAuthorized(id, code);
    const types = async (headers: Record<string, string>) =>
      ((await request(t.app).get('/api/v1/activity').set(headers)).body.data.items as { type: string; request: { id: string } | null }[])
        .filter((i) => i.request?.id === id)
        .map((i) => i.type);
    for (const headers of [asLender, asBorrower]) {
      expect(await types(headers)).toEqual(expect.arrayContaining(['pickup_authorized', 'pickup_authorization_redeemed', 'item_handed_over']));
    }
    expect(await types(asOutsider)).toEqual([]);
    const handed = (await request(t.app).get('/api/v1/activity').set(asBorrower)).body.data.items.find(
      (i: { type: string }) => i.type === 'item_handed_over',
    );
    expect(handed).toMatchObject({ recipientName: 'Ali Khan', handoverMethod: 'authorized', actor: { id: lender.id, isYou: false } });
  });
});

describe('access', () => {
  test('every endpoint needs a token', async () => {
    const id = await borrowRequest('accept');
    expect((await request(t.app).get(`/api/v1/borrow-requests/${id}/handover`)).status).toBe(401);
    expect((await request(t.app).post(`/api/v1/borrow-requests/${id}/pickup-authorizations`).send({})).status).toBe(401);
    expect((await request(t.app).post(`/api/v1/borrow-requests/${id}/handover/verify`).send({})).status).toBe(401);
    expect((await request(t.app).post(`/api/v1/borrow-requests/${id}/handover`).send({})).status).toBe(401);
  });
});
