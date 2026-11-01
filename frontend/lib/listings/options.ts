import type { ListingCategory, ListingCondition } from '../api/types';

// Display labels for the values the API accepts. The values themselves are
// the source of truth on the server (backend/src/listings/listing.types.ts).
export const CATEGORY_OPTIONS: { value: ListingCategory; label: string; icon: string }[] = [
  { value: 'tools', label: 'Tools', icon: '🔧' },
  { value: 'electronics', label: 'Electronics', icon: '📷' },
  { value: 'home', label: 'Home', icon: '🛋️' },
  { value: 'outdoor', label: 'Outdoor', icon: '⛺' },
  { value: 'kitchen', label: 'Kitchen', icon: '🍳' },
  { value: 'sports', label: 'Sports', icon: '🏏' },
  { value: 'books', label: 'Books', icon: '📚' },
  { value: 'other', label: 'Other', icon: '📦' },
];

export const CONDITION_OPTIONS: { value: ListingCondition; label: string }[] = [
  { value: 'excellent', label: 'Excellent' },
  { value: 'good', label: 'Good' },
  { value: 'fair', label: 'Fair' },
];

export const categoryLabel = (value: ListingCategory) => CATEGORY_OPTIONS.find((c) => c.value === value)?.label ?? value;
export const conditionLabel = (value: ListingCondition) => CONDITION_OPTIONS.find((c) => c.value === value)?.label ?? value;

export const MAX_LISTING_PHOTOS = 5;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export const formatPkr = (value: number) => `Rs ${value.toLocaleString('en-PK')}`;
