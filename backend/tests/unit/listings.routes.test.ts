// Listing endpoints with an in-memory repository: validation, ownership,
// archived listings, pagination, filters and photo upload checks. The same
// access rules are tested against the real migration in tests/db/listings.
import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { AppError } from '../../src/lib/errors.js';
import { DEFAULT_RATE_LIMITS } from '../../src/middleware/rate-limit.middleware.js';
import { sniffImageType } from '../../src/listings/listing.schemas.js';
import { OTHER_TOKEN, VALID_TOKEN, profileFor, testApp, userA, type memoryListings } from '../helpers.js';
import type { AuthUser, Profile } from '../../src/auth/auth.types.js';

const userB: AuthUser = { ...userA, id: '00000000-0000-4000-8000-00000000000b', email: 'b@example.test' };

const asA = { Authorization: `Bearer ${VALID_TOKEN}` };
const asB = { Authorization: `Bearer ${OTHER_TOKEN}` };

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

const validListing = {
  title: 'Bosch power drill',
  description: 'Cordless drill with two batteries and a set of bits.',
  category: 'tools',
  condition: 'good',
};

let app: ReturnType<typeof testApp>['app'];
let listings: ReturnType<typeof memoryListings>;
let statuses: Record<string, Profile['accountStatus']>;

beforeEach(() => {
  const t = testApp();
  app = t.app;
  listings = t.listings;
  statuses = { [userA.id]: 'active', [userB.id]: 'active' };
  // Two users: A (VALID_TOKEN) and B (OTHER_TOKEN).
  t.gateway.getUser.mockImplementation(async (token) => {
    if (token === VALID_TOKEN) return { user: userA, roles: [] };
    if (token === OTHER_TOKEN) return { user: userB, roles: [] };
    throw AppError.unauthenticated('Access token is invalid or expired', 'INVALID_TOKEN');
  });
  t.profiles.getProfile.mockImplementation(async (_token, userId) => {
    const user = userId === userA.id ? userA : userId === userB.id ? userB : null;
    return user ? profileFor(user, { accountStatus: statuses[user.id]! }) : null;
  });
});

const create = async (body: object = validListing, headers = asA) =>
  request(app).post('/api/v1/items').set(headers).send(body);

const createdId = async (body: object = validListing, headers = asA): Promise<string> => {
  const res = await create(body, headers);
  expect(res.status).toBe(201);
  return res.body.data.listing.id as string;
};

describe('POST /api/v1/items', () => {
  test('creates a listing owned by the caller, with defaults', async () => {
    const res = await create({ ...validListing, tags: ['DIY', 'diy', 'Home'], area: '  UAF Hostel 3 ', borrowingTerms: '' });
    expect(res.status).toBe(201);
    expect(res.body.data.listing).toMatchObject({
      owner: { id: userA.id },
      title: 'Bosch power drill',
      availability: 'available',
      teachMeEnabled: false,
      tags: ['diy', 'Home'],
      area: 'UAF Hostel 3',
      borrowingTerms: null,
      archivedAt: null,
      images: [],
    });
  });

  test('requires authentication', async () => {
    expect((await create(validListing, {} as typeof asA)).status).toBe(401);
    const bad = await create(validListing, { Authorization: 'Bearer not.a.valid-token' });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('INVALID_TOKEN');
    expect(listings.create).not.toHaveBeenCalled();
  });

  test('rejects a client-supplied owner instead of trusting it', async () => {
    const res = await create({ ...validListing, ownerId: userB.id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(listings.create).not.toHaveBeenCalled();
  });

  test.each([
    ['title too short', { title: 'ab' }, 'title'],
    ['description too short', { description: 'short' }, 'description'],
    ['unknown category', { category: 'cars' }, 'category'],
    ['unknown condition', { condition: 'broken' }, 'condition'],
    ['negative value', { replacementValuePkr: -1 }, 'replacementValuePkr'],
    ['fractional value', { replacementValuePkr: 10.5 }, 'replacementValuePkr'],
    ['too many tags', { tags: ['a', 'b', 'c', 'd', 'e', 'f'] }, 'tags'],
    ['bad availability', { availability: 'reserved' }, 'availability'],
  ])('validation: %s', async (_name, change, field) => {
    const res = await create({ ...validListing, ...change });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details.map((d: { field: string }) => d.field)).toContain(field);
  });

  test('missing required fields are each reported', async () => {
    const res = await create({});
    expect(res.status).toBe(400);
    expect(res.body.details.map((d: { field: string }) => d.field).sort()).toEqual(['category', 'condition', 'description', 'title']);
  });

  test('restricted and suspended accounts cannot publish', async () => {
    statuses[userA.id] = 'restricted';
    expect((await create()).body.code).toBe('ACCOUNT_RESTRICTED');
    statuses[userA.id] = 'suspended';
    expect((await create()).body.code).toBe('ACCOUNT_SUSPENDED');
    expect(listings.create).not.toHaveBeenCalled();
  });

  test('is rate limited per user', async () => {
    const t = testApp({ rateLimits: { ...DEFAULT_RATE_LIMITS, listingCreatePerUser: { windowMs: 60_000, limit: 2 } } });
    const send = () => request(t.app).post('/api/v1/items').set(asA).send(validListing);
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(201);
    const third = await send();
    expect(third.status).toBe(429);
    expect(third.body.code).toBe('RATE_LIMITED');
  });
});

describe('GET /api/v1/items', () => {
  beforeEach(async () => {
    await createdId({ ...validListing, title: 'Canon camera', description: 'DSLR with kit lens, great for events.', category: 'electronics', condition: 'excellent' });
    await createdId({ ...validListing, title: 'Camping tent', description: 'Waterproof four person tent.', category: 'outdoor', tags: ['Camping'] });
    await createdId({ ...validListing, title: 'Drill', availability: 'unavailable' }, asB);
  });

  test('is public and paginated', async () => {
    const res = await request(app).get('/api/v1/items?pageSize=2&sort=title');
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((i: { title: string }) => i.title)).toEqual(['Camping tent', 'Canon camera']);
    expect(res.body.data.pagination).toEqual({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
    const next = await request(app).get('/api/v1/items?pageSize=2&sort=title&page=2');
    expect(next.body.data.items.map((i: { title: string }) => i.title)).toEqual(['Drill']);
  });

  test('searches and filters', async () => {
    const titles = async (qs: string) =>
      (await request(app).get(`/api/v1/items?${qs}`)).body.data.items.map((i: { title: string }) => i.title);
    expect(await titles('q=camping')).toEqual(['Camping tent']);
    expect(await titles('q=kit%20lens')).toEqual(['Canon camera']);
    expect(await titles('category=electronics')).toEqual(['Canon camera']);
    expect(await titles('condition=excellent')).toEqual(['Canon camera']);
    expect(await titles('availability=unavailable')).toEqual(['Drill']);
    expect(await titles('q=nothing-like-this')).toEqual([]);
  });

  test('passes only validated filters to the repository', async () => {
    await request(app).get('/api/v1/items?q=%20tent%20&category=outdoor&ownerId=someone-else');
    expect(listings.search).toHaveBeenLastCalledWith(null, {
      q: 'tent',
      category: 'outdoor',
      condition: undefined,
      availability: undefined,
      ownerId: undefined,
      includeArchived: false,
      sort: 'newest',
      page: 1,
      pageSize: 20,
    });
  });

  test.each([
    ['page=0'],
    ['pageSize=51'],
    ['page=abc'],
    ['category=cars'],
    ['sort=price'],
    ['owner=' + userB.id],
    ['q=' + 'x'.repeat(101)],
    ['q=a&q=b'],
  ])('rejects invalid query %s', async (qs) => {
    const res = await request(app).get(`/api/v1/items?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('owner=me lists the caller’s own listings and needs a token', async () => {
    expect((await request(app).get('/api/v1/items?owner=me')).status).toBe(401);
    const res = await request(app).get('/api/v1/items?owner=me').set(asB);
    expect(res.body.data.items.map((i: { title: string }) => i.title)).toEqual(['Drill']);
  });

  test('a present but invalid token is refused, not treated as anonymous', async () => {
    const res = await request(app).get('/api/v1/items').set({ Authorization: `Bearer a.b.c` });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/items/:id', () => {
  test('returns a listing', async () => {
    const id = await createdId();
    const res = await request(app).get(`/api/v1/items/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.listing).toMatchObject({ id, title: validListing.title });
  });

  test('404 for an id that does not exist, 400 for one that is not an id', async () => {
    const missing = await request(app).get('/api/v1/items/00000000-0000-4000-8000-0000000000ff');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('LISTING_NOT_FOUND');
    const malformed = await request(app).get('/api/v1/items/not-a-uuid');
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('VALIDATION_ERROR');
  });

  test('responses carry no private owner details', async () => {
    const id = await createdId();
    const { listing } = (await request(app).get(`/api/v1/items/${id}`)).body.data;
    expect(Object.keys(listing.owner).sort()).toEqual(['displayName', 'id']);
    expect(JSON.stringify(listing)).not.toMatch(/email|phone|accessToken/i);
  });
});

describe('PATCH /api/v1/items/:id', () => {
  test('the owner updates fields and availability', async () => {
    const id = await createdId();
    const res = await request(app).patch(`/api/v1/items/${id}`).set(asA).send({ title: 'Bosch drill v2', availability: 'unavailable' });
    expect(res.status).toBe(200);
    expect(res.body.data.listing).toMatchObject({ title: 'Bosch drill v2', availability: 'unavailable' });
    expect((await request(app).get(`/api/v1/items/${id}`)).body.data.listing.availability).toBe('unavailable');
  });

  test('another user gets 403 and nothing changes', async () => {
    const id = await createdId();
    const res = await request(app).patch(`/api/v1/items/${id}`).set(asB).send({ title: 'Mine now' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(listings.update).not.toHaveBeenCalled();
    expect(listings.rows.get(id)?.title).toBe(validListing.title);
  });

  test('anonymous callers get 401', async () => {
    const id = await createdId();
    expect((await request(app).patch(`/api/v1/items/${id}`).send({ title: 'Anon' })).status).toBe(401);
  });

  test('unknown listing is 404; empty or unknown changes are 400', async () => {
    const id = await createdId();
    expect((await request(app).patch('/api/v1/items/00000000-0000-4000-8000-0000000000ff').set(asA).send({ title: 'Nope' })).status).toBe(404);
    expect((await request(app).patch(`/api/v1/items/${id}`).set(asA).send({})).status).toBe(400);
    expect((await request(app).patch(`/api/v1/items/${id}`).set(asA).send({ ownerId: userB.id })).status).toBe(400);
    expect((await request(app).patch(`/api/v1/items/${id}`).set(asA).send({ archivedAt: null })).status).toBe(400);
  });

  test('restricted owners may change availability only', async () => {
    const id = await createdId();
    statuses[userA.id] = 'restricted';
    expect((await request(app).patch(`/api/v1/items/${id}`).set(asA).send({ availability: 'unavailable' })).status).toBe(200);
    const res = await request(app).patch(`/api/v1/items/${id}`).set(asA).send({ title: 'New title' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_RESTRICTED');
  });

  test('archived listings cannot be edited', async () => {
    const id = await createdId();
    await request(app).delete(`/api/v1/items/${id}`).set(asA);
    const res = await request(app).patch(`/api/v1/items/${id}`).set(asA).send({ title: 'Back again' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LISTING_ARCHIVED');
  });
});

describe('DELETE /api/v1/items/:id (archive)', () => {
  test('the owner archives; the listing leaves discovery but the owner still sees it', async () => {
    const id = await createdId();
    const res = await request(app).delete(`/api/v1/items/${id}`).set(asA);
    expect(res.status).toBe(200);
    expect(res.body.data.listing.archivedAt).toEqual(expect.any(String));

    expect((await request(app).get(`/api/v1/items/${id}`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/items/${id}`).set(asB)).status).toBe(404);
    expect((await request(app).get(`/api/v1/items/${id}`).set(asA)).status).toBe(200);
    expect((await request(app).get('/api/v1/items')).body.data.pagination.total).toBe(0);
    const mine = await request(app).get('/api/v1/items?owner=me&includeArchived=true').set(asA);
    expect(mine.body.data.items.map((i: { id: string }) => i.id)).toEqual([id]);
  });

  test('is idempotent', async () => {
    const id = await createdId();
    expect((await request(app).delete(`/api/v1/items/${id}`).set(asA)).status).toBe(200);
    expect((await request(app).delete(`/api/v1/items/${id}`).set(asA)).status).toBe(200);
  });

  test('another user gets 403; unknown id 404; anonymous 401', async () => {
    const id = await createdId();
    expect((await request(app).delete(`/api/v1/items/${id}`).set(asB)).status).toBe(403);
    expect(listings.rows.get(id)?.archivedAt).toBeNull();
    expect((await request(app).delete('/api/v1/items/00000000-0000-4000-8000-0000000000ff').set(asA)).status).toBe(404);
    expect((await request(app).delete(`/api/v1/items/${id}`)).status).toBe(401);
  });

  test('suspended owners cannot archive', async () => {
    const id = await createdId();
    statuses[userA.id] = 'suspended';
    expect((await request(app).delete(`/api/v1/items/${id}`).set(asA)).status).toBe(403);
  });
});

describe('listing photos', () => {
  const upload = (id: string, body: Buffer, type: string, headers = asA) =>
    request(app).post(`/api/v1/items/${id}/images`).set(headers).set('Content-Type', type).send(body);

  test('the owner uploads JPEG, PNG and WebP photos', async () => {
    const id = await createdId();
    for (const [body, type] of [[JPEG, 'image/jpeg'], [PNG, 'image/png'], [WEBP, 'image/webp']] as const) {
      const res = await upload(id, body, type);
      expect(res.status).toBe(201);
      expect(res.body.data.image).toMatchObject({ contentType: type, url: expect.any(String) });
    }
    expect((await request(app).get(`/api/v1/items/${id}`)).body.data.listing.images).toHaveLength(3);
  });

  test('another user cannot add photos to my listing', async () => {
    const id = await createdId();
    const res = await upload(id, JPEG, 'image/jpeg', asB);
    expect(res.status).toBe(403);
    expect(listings.addImage).not.toHaveBeenCalled();
  });

  test('unsupported types and mislabelled files are refused', async () => {
    const id = await createdId();
    const gif = await upload(id, Buffer.from('GIF89a....'), 'image/gif');
    expect(gif.status).toBe(415);
    expect(gif.body.code).toBe('UNSUPPORTED_IMAGE_TYPE');
    const text = await upload(id, Buffer.from('hello'), 'text/plain');
    expect(text.status).toBe(415);
    const fakeJpeg = await upload(id, PNG, 'image/jpeg');
    expect(fakeJpeg.status).toBe(415);
    const script = await upload(id, Buffer.from('<script>alert(1)</script>'), 'image/png');
    expect(script.status).toBe(415);
    expect(listings.addImage).not.toHaveBeenCalled();
  });

  test('files over 5 MB are refused with 413', async () => {
    const id = await createdId();
    const big = Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]);
    const res = await upload(id, big, 'image/jpeg');
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('at most five photos per listing', async () => {
    const id = await createdId();
    for (let i = 0; i < 5; i++) expect((await upload(id, JPEG, 'image/jpeg')).status).toBe(201);
    const res = await upload(id, JPEG, 'image/jpeg');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IMAGE_LIMIT_REACHED');
  });

  test('photos cannot be added to an archived or unknown listing', async () => {
    const id = await createdId();
    await request(app).delete(`/api/v1/items/${id}`).set(asA);
    expect((await upload(id, JPEG, 'image/jpeg')).status).toBe(409);
    expect((await upload('00000000-0000-4000-8000-0000000000ff', JPEG, 'image/jpeg')).status).toBe(404);
  });

  test('uploading requires authentication', async () => {
    const id = await createdId();
    expect((await upload(id, JPEG, 'image/jpeg', {} as typeof asA)).status).toBe(401);
  });

  test('the owner removes a photo; others cannot', async () => {
    const id = await createdId();
    const imageId = (await upload(id, JPEG, 'image/jpeg')).body.data.image.id as string;
    expect((await request(app).delete(`/api/v1/items/${id}/images/${imageId}`).set(asB)).status).toBe(403);
    expect((await request(app).delete(`/api/v1/items/${id}/images/${imageId}`).set(asA)).status).toBe(204);
    const again = await request(app).delete(`/api/v1/items/${id}/images/${imageId}`).set(asA);
    expect(again.status).toBe(404);
    expect(again.body.code).toBe('IMAGE_NOT_FOUND');
  });
});

describe('sniffImageType', () => {
  test('recognises the three formats from their first bytes only', () => {
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(WEBP)).toBe('image/webp');
    expect(sniffImageType(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('without a configured repository', () => {
  test('listing endpoints answer 503 SERVER_NOT_CONFIGURED', async () => {
    const { createApp } = await import('../../src/app.js');
    const { testConfig, silentLogger, fakeGateway, fakeProfiles } = await import('../helpers.js');
    const bare = createApp({ config: testConfig(), logger: silentLogger, authGateway: fakeGateway(), profiles: fakeProfiles() });
    const res = await request(bare).get('/api/v1/items');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SERVER_NOT_CONFIGURED');
  });
});
