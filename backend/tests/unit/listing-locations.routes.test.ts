// Nearby discovery and pickup locations through the HTTP API, with in-memory
// repositories. The database's own rules (private precise point, secret
// offset, radius filter) are tested in tests/db/listing-locations.test.ts.
import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { AppError } from '../../src/lib/errors.js';
import { DEFAULT_RATE_LIMITS } from '../../src/middleware/rate-limit.middleware.js';
import { OTHER_TOKEN, VALID_TOKEN, haversineKm, profileFor, testApp, userA } from '../helpers.js';
import type { AuthUser } from '../../src/auth/auth.types.js';

const owner = userA;
const neighbor: AuthUser = { ...userA, id: '00000000-0000-4000-8000-00000000000b', email: 'b@example.test' };
const asOwner = { Authorization: `Bearer ${VALID_TOKEN}` };
const asNeighbor = { Authorization: `Bearer ${OTHER_TOKEN}` };

const UAF = { latitude: 31.431, longitude: 73.07 };
const north = (km: number) => ({ latitude: UAF.latitude + km / 111.32, longitude: UAF.longitude });

let t: ReturnType<typeof testApp>;

function setup(rateLimits = DEFAULT_RATE_LIMITS) {
  t = testApp({ rateLimits });
  t.gateway.getUser.mockImplementation(async (token) => {
    const user = { [VALID_TOKEN]: owner, [OTHER_TOKEN]: neighbor }[token];
    if (!user) throw AppError.unauthenticated('Access token is invalid or expired', 'INVALID_TOKEN');
    return { user, roles: [] };
  });
  t.profiles.getProfile.mockImplementation(async (_token, userId) => {
    const user = [owner, neighbor].find((u) => u.id === userId);
    return user ? profileFor(user) : null;
  });
}

beforeEach(() => setup());

async function listing(title: string, at: { latitude: number; longitude: number } | null, extra: Record<string, unknown> = {}) {
  const res = await request(t.app)
    .post('/api/v1/items')
    .set(asOwner)
    .send({ title, description: 'A useful item to borrow.', category: 'tools', condition: 'good', city: 'Faisalabad', ...extra });
  expect(res.status).toBe(201);
  const id = res.body.data.listing.id as string;
  if (at) expect((await request(t.app).put(`/api/v1/items/${id}/location`).set(asOwner).send(at)).status).toBe(200);
  return id;
}

const browse = (query: Record<string, string | number>) => request(t.app).get('/api/v1/items').query(query);

describe('GET /api/v1/items nearby', () => {
  beforeEach(async () => {
    await listing('One km', north(1));
    await listing('Two and a half km', north(2.5));
    await listing('Four km', north(4));
    await listing('Lahore', { latitude: 31.5204, longitude: 74.3587 });
    await listing('No pickup point', null);
  });

  test('defaults to 3 km, nearest first, each with a rounded distance and the scope', async () => {
    const res = await browse({ lat: UAF.latitude, lng: UAF.longitude });
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((i: { title: string }) => i.title)).toEqual(['One km', 'Two and a half km']);
    expect(res.body.data.scope).toEqual({ mode: 'nearby', radiusKm: 3 });
    for (const item of res.body.data.items) {
      expect(item.distanceKm).toBeLessThanOrEqual(3);
      expect(item.distanceKm).toBe(Math.round(haversineKm(UAF, item.approximateLocation) * 10) / 10);
    }
  });

  test('a wider radius includes more, but never a listing in another city', async () => {
    const five = await browse({ lat: UAF.latitude, lng: UAF.longitude, radiusKm: 5 });
    expect(five.body.data.items.map((i: { title: string }) => i.title)).toEqual(['One km', 'Two and a half km', 'Four km']);
    const fifty = await browse({ lat: UAF.latitude, lng: UAF.longitude, radiusKm: 50 });
    expect(fifty.body.data.items.map((i: { title: string }) => i.title)).not.toContain('Lahore');
  });

  test('listings without a pickup point are not "nearby" but stay in city and default browsing', async () => {
    const near = await browse({ lat: UAF.latitude, lng: UAF.longitude, radiusKm: 50 });
    expect(near.body.data.items.map((i: { title: string }) => i.title)).not.toContain('No pickup point');
    const city = await browse({ city: 'faisalabad' });
    expect(city.body.data.scope).toEqual({ mode: 'city', city: 'faisalabad' });
    expect(city.body.data.items.map((i: { title: string }) => i.title)).toContain('No pickup point');
    const all = await browse({});
    expect(all.body.data.scope).toEqual({ mode: 'all' });
    expect(all.body.data.items).toHaveLength(5);
    expect(all.body.data.items.every((i: { distanceKm: unknown }) => i.distanceKm === null)).toBe(true);
  });

  test('filters and pagination still apply', async () => {
    const page1 = await browse({ lat: UAF.latitude, lng: UAF.longitude, radiusKm: 10, pageSize: 2 });
    const page2 = await browse({ lat: UAF.latitude, lng: UAF.longitude, radiusKm: 10, pageSize: 2, page: 2 });
    expect([...page1.body.data.items, ...page2.body.data.items].map((i: { title: string }) => i.title)).toEqual([
      'One km',
      'Two and a half km',
      'Four km',
    ]);
    expect(page1.body.data.pagination).toMatchObject({ total: 3, totalPages: 2 });
    const none = await browse({ lat: UAF.latitude, lng: UAF.longitude, radiusKm: 10, category: 'kitchen' });
    expect(none.body.data.items).toEqual([]);
    expect(t.listings.search).toHaveBeenLastCalledWith(null, expect.objectContaining({ category: 'kitchen', sort: 'distance' }));
  });

  test('another sort can be asked for explicitly', async () => {
    await browse({ lat: UAF.latitude, lng: UAF.longitude, sort: 'title' });
    expect(t.listings.search).toHaveBeenLastCalledWith(null, expect.objectContaining({ sort: 'title' }));
  });
});

describe('GET /api/v1/items query validation', () => {
  test.each([
    [{ lat: 91, lng: 73 }, 'lat'],
    [{ lat: -91, lng: 73 }, 'lat'],
    [{ lat: 31, lng: 181 }, 'lng'],
    [{ lat: 'north', lng: 73 }, 'lat'],
    [{ lat: 31 }, 'lng'],
    [{ lng: 73 }, 'lat'],
    [{ lat: 31, lng: 73, radiusKm: 0.1 }, 'radiusKm'],
    [{ lat: 31, lng: 73, radiusKm: 51 }, 'radiusKm'],
    [{ radiusKm: 3 }, 'radiusKm'],
    [{ lat: 31, lng: 73, city: 'Lahore' }, 'city'],
    [{ sort: 'distance' }, 'sort'],
  ])('%o is refused (%s)', async (query, field) => {
    const res = await browse(query as Record<string, string | number>);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details.map((d: { field: string }) => d.field)).toContain(field);
    expect(t.listings.search).not.toHaveBeenCalled();
  });

  test('an empty lat is treated as absent, not as 0', async () => {
    const res = await browse({ lat: '', lng: '' });
    expect(res.status).toBe(200);
    expect(res.body.data.scope).toEqual({ mode: 'all' });
  });

  test('without location parameters the search is exactly as before', async () => {
    await browse({ q: 'drill' });
    expect(t.listings.search).toHaveBeenLastCalledWith(null, {
      q: 'drill',
      category: undefined,
      condition: undefined,
      availability: undefined,
      ownerId: undefined,
      includeArchived: false,
      near: undefined,
      city: undefined,
      sort: 'newest',
      page: 1,
      pageSize: 20,
    });
  });
});

describe('pickup location', () => {
  test('the owner sets it; others see only the approximate point, never the precise one', async () => {
    const id = await listing('Drill', null);
    const point = { latitude: 31.43123, longitude: 73.07456 };
    const set = await request(t.app).put(`/api/v1/items/${id}/location`).set(asOwner).send(point);
    expect(set.status).toBe(200);
    expect(set.body.data.location).toMatchObject(point);

    const publicView = await request(t.app).get(`/api/v1/items/${id}`);
    const { approximateLocation } = publicView.body.data.listing;
    expect(approximateLocation).not.toEqual({ latitude: point.latitude, longitude: point.longitude });
    expect(JSON.stringify(publicView.body)).not.toContain('31.43123');
    expect(JSON.stringify(publicView.body)).not.toContain('73.07456');
    const listed = await browse({ lat: UAF.latitude, lng: UAF.longitude });
    expect(JSON.stringify(listed.body)).not.toContain('31.43123');

    expect((await request(t.app).get(`/api/v1/items/${id}/location`).set(asOwner)).body.data.location).toMatchObject(point);
    const neighborView = await request(t.app).get(`/api/v1/items/${id}/location`).set(asNeighbor);
    expect(neighborView.status).toBe(403);
  });

  test('only the owner can set or clear it, and only with valid coordinates', async () => {
    const id = await listing('Drill', null);
    expect((await request(t.app).put(`/api/v1/items/${id}/location`).set(asNeighbor).send(UAF)).status).toBe(403);
    expect((await request(t.app).put(`/api/v1/items/${id}/location`).send(UAF)).status).toBe(401);
    for (const body of [{ latitude: 95, longitude: 73 }, { latitude: 31 }, { latitude: '31', longitude: '73' }, { ...UAF, address: 'x' }]) {
      const res = await request(t.app).put(`/api/v1/items/${id}/location`).set(asOwner).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await request(t.app).delete(`/api/v1/items/${id}/location`).set(asNeighbor)).status).toBe(403);
  });

  test('clearing it takes the listing out of nearby results', async () => {
    const id = await listing('Drill', north(1));
    expect((await browse({ lat: UAF.latitude, lng: UAF.longitude })).body.data.items).toHaveLength(1);
    expect((await request(t.app).delete(`/api/v1/items/${id}/location`).set(asOwner)).status).toBe(204);
    expect((await browse({ lat: UAF.latitude, lng: UAF.longitude })).body.data.items).toHaveLength(0);
    expect((await request(t.app).get(`/api/v1/items/${id}`)).body.data.listing.approximateLocation).toBeNull();
  });

  test('archived listings cannot be moved', async () => {
    const id = await listing('Drill', null);
    await request(t.app).delete(`/api/v1/items/${id}`).set(asOwner);
    const res = await request(t.app).put(`/api/v1/items/${id}/location`).set(asOwner).send(UAF);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LISTING_ARCHIVED');
  });

  test('editing a listing never moves it', async () => {
    const id = await listing('Drill', north(1));
    const before = (await request(t.app).get(`/api/v1/items/${id}`)).body.data.listing.approximateLocation;
    await request(t.app).patch(`/api/v1/items/${id}`).set(asOwner).send({ title: 'Cordless drill', city: 'Lahore' });
    const after = (await request(t.app).get(`/api/v1/items/${id}`)).body.data.listing;
    expect(after.approximateLocation).toEqual(before);
    expect(after.city).toBe('Lahore');
  });

  test('setting it is rate limited per user', async () => {
    setup({ ...DEFAULT_RATE_LIMITS, listingLocationPerUser: { windowMs: 60_000, limit: 1 } });
    const id = await listing('Drill', null);
    expect((await request(t.app).put(`/api/v1/items/${id}/location`).set(asOwner).send(UAF)).status).toBe(200);
    expect((await request(t.app).put(`/api/v1/items/${id}/location`).set(asOwner).send(UAF)).status).toBe(429);
  });
});
