import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SupabaseClients } from '../config/supabase.js';
import type { Logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';
import { timed } from '../lib/timing.js';
import { IMAGE_EXTENSIONS } from './listing.schemas.js';
import type {
  Caller,
  Listing,
  ListingChanges,
  ListingImage,
  ListingRepository,
  ListingSearch,
  PickupLocation,
} from './listing.types.js';

export const LISTING_IMAGES_BUCKET = 'listing-images';
// Long enough to browse a feed, short enough that a shared link soon dies.
export const SIGNED_URL_TTL_SECONDS = 3600;

// API field -> column. The database's column grants allow the same list.
const WRITABLE_COLUMNS: Record<keyof ListingChanges, string> = {
  title: 'title',
  description: 'description',
  category: 'category',
  condition: 'condition',
  replacementValuePkr: 'replacement_value_pkr',
  borrowingTerms: 'borrowing_terms',
  area: 'area',
  city: 'city',
  availability: 'availability',
  teachMeEnabled: 'teach_me_enabled',
  tags: 'tags',
};

// One element of search_listings' "items".
interface ListingRow {
  id: string;
  owner_id: string;
  owner_display_name: string | null;
  title: string;
  description: string;
  category: Listing['category'];
  condition: Listing['condition'];
  replacement_value_pkr: number | null;
  borrowing_terms: string | null;
  area: string | null;
  city?: string | null;
  public_latitude?: number | null;
  public_longitude?: number | null;
  distance_km?: number | string | null;
  availability: Listing['availability'];
  teach_me_enabled: boolean;
  tags: string[];
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ImageRow {
  id: string;
  listing_id: string;
  storage_path: string;
  content_type: string;
  created_at: string;
}

const IMAGE_COLUMNS = 'id, listing_id, storage_path, content_type, created_at';

const toListing = (r: ListingRow, images: ListingImage[]): Listing => ({
  id: r.id,
  owner: { id: r.owner_id, displayName: r.owner_display_name },
  title: r.title,
  description: r.description,
  category: r.category,
  condition: r.condition,
  replacementValuePkr: r.replacement_value_pkr,
  borrowingTerms: r.borrowing_terms,
  area: r.area,
  // `?? null` / `!= null`: rows from a database without the Phase 3A
  // migration have no such keys at all.
  city: r.city ?? null,
  approximateLocation:
    r.public_latitude != null && r.public_longitude != null ? { latitude: r.public_latitude, longitude: r.public_longitude } : null,
  distanceKm: r.distance_km != null ? Number(r.distance_km) : null,
  availability: r.availability,
  teachMeEnabled: r.teach_me_enabled,
  tags: r.tags,
  archivedAt: r.archived_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  images,
});

export function createSupabaseListingRepository(clients: SupabaseClients, logger: Logger): ListingRepository {
  const fail = (operation: string, error: { code?: string }) => {
    // PostgREST error codes only; messages can echo query details.
    logger.error({ operation, code: error.code }, 'database query failed');
    return AppError.unavailable('Data service is temporarily unavailable', 'DATABASE_UNAVAILABLE');
  };

  const storageFail = (operation: string, error: { message?: string; statusCode?: string | number }) => {
    const status = Number((error as { statusCode?: unknown }).statusCode ?? 0);
    logger.error({ operation, status }, 'storage request failed');
    if (/bucket not found/i.test(error.message ?? '')) {
      return AppError.unavailable('Photo storage is not set up on the server', 'STORAGE_NOT_CONFIGURED');
    }
    if (status === 403 || status === 401) return AppError.forbidden();
    return AppError.unavailable('Photo storage is temporarily unavailable', 'STORAGE_UNAVAILABLE');
  };

  // Timed by name only; rows hold user content.
  const db = <T>(operation: string, query: PromiseLike<T>) => timed(logger, `database.${operation}`, async () => query);

  // The caller's own token, or the publishable key alone for anonymous reads.
  const clientFor = (caller: Caller | null): SupabaseClient => (caller ? clients.forUser(caller.accessToken) : clients.anon());

  async function imagesFor(client: SupabaseClient, listingIds: string[]): Promise<Map<string, ListingImage[]>> {
    const byListing = new Map<string, ListingImage[]>();
    if (listingIds.length === 0) return byListing;

    const { data, error } = await db(
      'list_listing_images',
      client.from('listing_images').select(IMAGE_COLUMNS).in('listing_id', listingIds).order('created_at').returns<ImageRow[]>(),
    );
    if (error) throw fail('list_listing_images', error);
    const rows = data ?? [];

    // A signing failure costs the pictures, not the listings.
    const urls = new Map<string, string>();
    if (rows.length > 0) {
      const { data: signed, error: signError } = await timed(logger, 'storage.sign_listing_images', async () =>
        client.storage.from(LISTING_IMAGES_BUCKET).createSignedUrls(
          rows.map((r) => r.storage_path),
          SIGNED_URL_TTL_SECONDS,
        ),
      );
      if (signError) logger.warn({ operation: 'sign_listing_images' }, 'could not sign listing image URLs');
      for (const s of signed ?? []) if (s.path && s.signedUrl && !s.error) urls.set(s.path, s.signedUrl);
    }

    for (const r of rows) {
      const list = byListing.get(r.listing_id) ?? [];
      list.push({ id: r.id, url: urls.get(r.storage_path) ?? null, contentType: r.content_type, createdAt: r.created_at });
      byListing.set(r.listing_id, list);
    }
    return byListing;
  }

  async function runSearch(caller: Caller | null, args: Record<string, unknown>) {
    const client = clientFor(caller);
    const { data, error } = await db('search_listings', client.rpc('search_listings', args));
    if (error) throw fail('search_listings', error);
    const result = data as { total: number; items: ListingRow[] };
    const images = await imagesFor(client, result.items.map((r) => r.id));
    return { total: Number(result.total), items: result.items.map((r) => toListing(r, images.get(r.id) ?? [])) };
  }

  const writeError = (operation: string, error: { code?: string }) => {
    if (error.code === '42501') return AppError.forbidden();
    // Raised by set_listing_location / clear_listing_location.
    if (error.code === 'NSL01') return AppError.notFound('Listing not found', 'LISTING_NOT_FOUND');
    if (error.code === '22023') return AppError.badRequest('INVALID_LOCATION', 'Those coordinates are not valid');
    if (error.code === '23514') return AppError.badRequest('INVALID_LISTING', 'Listing values are not accepted');
    return fail(operation, error);
  };

  const repository: ListingRepository = {
    search(caller, s: ListingSearch) {
      return runSearch(caller, {
        p_query: s.q ?? null,
        p_category: s.category ?? null,
        p_condition: s.condition ?? null,
        p_availability: s.availability ?? null,
        p_owner_id: s.ownerId ?? null,
        p_include_archived: s.includeArchived,
        p_sort: s.sort,
        p_limit: s.pageSize,
        p_offset: (s.page - 1) * s.pageSize,
        // Sent only when used, so the call shape matches older callers.
        ...(s.near ? { p_latitude: s.near.latitude, p_longitude: s.near.longitude, p_radius_km: s.near.radiusKm } : {}),
        ...(s.city ? { p_city: s.city } : {}),
        // Needs 20261105120000_browse_exclude_owner.sql.
        ...(s.excludeOwnerId ? { p_exclude_owner_id: s.excludeOwnerId } : {}),
      });
    },

    async get(caller, id) {
      const { items } = await runSearch(caller, { p_id: id, p_include_archived: true, p_limit: 1 });
      return items[0] ?? null;
    },

    async create(caller, input) {
      const row: Record<string, unknown> = { owner_id: caller.userId };
      for (const [field, column] of Object.entries(WRITABLE_COLUMNS)) {
        const value = input[field as keyof ListingChanges];
        if (value !== undefined) row[column] = value;
      }
      const { data, error } = await db(
        'create_listing',
        clientFor(caller).from('listings').insert(row).select('id').single<{ id: string }>(),
      );
      if (error) throw writeError('create_listing', error);
      const created = await repository.get(caller, data.id);
      if (!created) throw fail('create_listing', {});
      return created;
    },

    async update(caller, id, changes) {
      const row: Record<string, unknown> = {};
      for (const [field, column] of Object.entries(WRITABLE_COLUMNS)) {
        const value = changes[field as keyof ListingChanges];
        if (value !== undefined) row[column] = value;
      }
      const { data, error } = await db(
        'update_listing',
        clientFor(caller).from('listings').update(row).eq('id', id).select('id').maybeSingle<{ id: string }>(),
      );
      if (error) throw writeError('update_listing', error);
      return data ? repository.get(caller, data.id) : null;
    },

    async archive(caller, id) {
      // The database replaces the timestamp with its own clock.
      const { data, error } = await db(
        'archive_listing',
        clientFor(caller)
          .from('listings')
          .update({ archived_at: new Date().toISOString() })
          .eq('id', id)
          .select('id')
          .maybeSingle<{ id: string }>(),
      );
      if (error) throw writeError('archive_listing', error);
      return data !== null;
    },

    async addImage(caller, listingId, file) {
      const client = clientFor(caller);
      // Server-chosen name: the client never picks a path or overwrites one.
      const path = `${caller.userId}/${listingId}/${randomUUID()}.${IMAGE_EXTENSIONS[file.contentType]}`;

      const { error: uploadError } = await timed(logger, 'storage.upload_listing_image', async () =>
        client.storage.from(LISTING_IMAGES_BUCKET).upload(path, file.data, { contentType: file.contentType, upsert: false }),
      );
      if (uploadError) throw storageFail('upload_listing_image', uploadError);

      const { data, error } = await db(
        'add_listing_image',
        client
          .from('listing_images')
          .insert({
            listing_id: listingId,
            owner_id: caller.userId,
            storage_path: path,
            content_type: file.contentType,
            size_bytes: file.data.length,
          })
          .select(IMAGE_COLUMNS)
          .single<ImageRow>(),
      );
      if (error) {
        // Do not leave an unreferenced file behind.
        await client.storage.from(LISTING_IMAGES_BUCKET).remove([path]).catch(() => undefined);
        if (error.code === '23514') throw AppError.conflict('IMAGE_LIMIT_REACHED', 'A listing can have at most 5 photos');
        throw writeError('add_listing_image', error);
      }

      const { data: signed } = await client.storage.from(LISTING_IMAGES_BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
      return { id: data.id, url: signed?.signedUrl ?? null, contentType: data.content_type, createdAt: data.created_at };
    },

    async removeImage(caller, listingId, imageId) {
      const client = clientFor(caller);
      const { data, error } = await db(
        'remove_listing_image',
        client
          .from('listing_images')
          .delete()
          .eq('id', imageId)
          .eq('listing_id', listingId)
          .select('storage_path')
          .maybeSingle<{ storage_path: string }>(),
      );
      if (error) throw writeError('remove_listing_image', error);
      if (!data) return false;

      // The row is gone, so the file is no longer served. A failed delete
      // leaves an orphaned file in the owner's folder, which is logged.
      const { error: removeError } = await client.storage.from(LISTING_IMAGES_BUCKET).remove([data.storage_path]);
      if (removeError) logger.warn({ operation: 'remove_listing_image_file' }, 'listing image file was not deleted');
      return true;
    },

    async getLocation(caller, listingId) {
      // Row-Level Security returns the row to its owner only.
      const { data, error } = await db(
        'get_listing_location',
        clientFor(caller)
          .from('listing_locations')
          .select('latitude, longitude, updated_at')
          .eq('listing_id', listingId)
          .maybeSingle<{ latitude: number; longitude: number; updated_at: string }>(),
      );
      if (error) throw fail('get_listing_location', error);
      return data ? { latitude: data.latitude, longitude: data.longitude, updatedAt: data.updated_at } : null;
    },

    async setLocation(caller, listingId, point): Promise<PickupLocation> {
      const { data, error } = await db(
        'set_listing_location',
        clientFor(caller).rpc('set_listing_location', {
          p_listing_id: listingId,
          p_latitude: point.latitude,
          p_longitude: point.longitude,
        }),
      );
      if (error) throw writeError('set_listing_location', error);
      const r = data as { latitude: number; longitude: number; updated_at: string };
      return { latitude: r.latitude, longitude: r.longitude, updatedAt: r.updated_at };
    },

    async clearLocation(caller, listingId) {
      const { error } = await db(
        'clear_listing_location',
        clientFor(caller).rpc('clear_listing_location', { p_listing_id: listingId }),
      );
      if (error) throw writeError('clear_listing_location', error);
    },
  };


  return repository;
}

// Used when the app is built without a listing repository (some tests).
export function unconfiguredListings(): ListingRepository {
  const refuse = async (): Promise<never> => {
    throw AppError.unavailable('Listings are not configured on the server', 'SERVER_NOT_CONFIGURED');
  };
  return {
    search: refuse,
    get: refuse,
    create: refuse,
    update: refuse,
    archive: refuse,
    addImage: refuse,
    removeImage: refuse,
    getLocation: refuse,
    setLocation: refuse,
    clearLocation: refuse,
  };
}
