// Shapes returned by the listing endpoints. Built field by field from
// database rows, so only columns meant for public discovery reach clients:
// the owner appears as an id and display name, never contact details.

export const LISTING_CATEGORIES = ['tools', 'electronics', 'home', 'outdoor', 'kitchen', 'sports', 'books', 'other'] as const;
export const LISTING_CONDITIONS = ['excellent', 'good', 'fair'] as const;
export const LISTING_AVAILABILITY = ['available', 'unavailable'] as const;
export const LISTING_SORTS = ['newest', 'oldest', 'title'] as const;

export type ListingCategory = (typeof LISTING_CATEGORIES)[number];
export type ListingCondition = (typeof LISTING_CONDITIONS)[number];
export type ListingAvailability = (typeof LISTING_AVAILABILITY)[number];
export type ListingSort = (typeof LISTING_SORTS)[number];

export interface ListingImage {
  id: string;
  // Short-lived signed URL; null when Storage could not sign it.
  url: string | null;
  contentType: string;
  createdAt: string;
}

export interface Listing {
  id: string;
  owner: { id: string; displayName: string | null };
  title: string;
  description: string;
  category: ListingCategory;
  condition: ListingCondition;
  replacementValuePkr: number | null;
  borrowingTerms: string | null;
  area: string | null;
  availability: ListingAvailability;
  teachMeEnabled: boolean;
  tags: string[];
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  images: ListingImage[];
}

export interface ListingInput {
  title: string;
  description: string;
  category: ListingCategory;
  condition: ListingCondition;
  replacementValuePkr?: number | null | undefined;
  borrowingTerms?: string | null | undefined;
  area?: string | null | undefined;
  availability: ListingAvailability;
  teachMeEnabled: boolean;
  tags: string[];
}

export type ListingChanges = Partial<ListingInput>;

export interface ListingSearch {
  q?: string | undefined;
  category?: ListingCategory | undefined;
  condition?: ListingCondition | undefined;
  availability?: ListingAvailability | undefined;
  // Set only from the verified caller ("owner=me"), never from input.
  ownerId?: string | undefined;
  includeArchived: boolean;
  sort: ListingSort;
  page: number;
  pageSize: number;
}

export type ImageContentType = 'image/jpeg' | 'image/png' | 'image/webp';

// The signed-in caller, from requireAuth. Reads also work without one.
export interface Caller {
  userId: string;
  accessToken: string;
}

// Database and Storage access for listings. Every call runs with the caller's
// token (or anonymously), so Row-Level Security applies; the routes check
// ownership first to give clear errors. Implementations throw AppError.
export interface ListingRepository {
  search(caller: Caller | null, search: ListingSearch): Promise<{ items: Listing[]; total: number }>;
  // Archived listings are returned only to their owner.
  get(caller: Caller | null, id: string): Promise<Listing | null>;
  create(caller: Caller, input: ListingInput): Promise<Listing>;
  // Null when Row-Level Security matched no row.
  update(caller: Caller, id: string, changes: ListingChanges): Promise<Listing | null>;
  archive(caller: Caller, id: string): Promise<boolean>;
  addImage(caller: Caller, listingId: string, file: { data: Buffer; contentType: ImageContentType }): Promise<ListingImage>;
  // False when there is no such image on the listing.
  removeImage(caller: Caller, listingId: string, imageId: string): Promise<boolean>;
}
