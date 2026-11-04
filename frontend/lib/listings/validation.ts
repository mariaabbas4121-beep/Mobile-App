import type { FieldIssue, ListingCategory, ListingCondition, ListingInput } from '../api/types';

// The listing form as typed. Numbers stay strings until validated.
export interface ListingForm {
  title: string;
  description: string;
  category: ListingCategory;
  condition: ListingCondition;
  replacementValue: string;
  borrowingTerms: string;
  area: string;
  city: string;
  tags: string;
  teachMeEnabled: boolean;
}

export type ListingFormField = keyof ListingForm;
export type ListingFormErrors = Partial<Record<ListingFormField, string>>;

// Mirrors the server's rules (backend/src/listings/listing.schemas.ts) so
// most mistakes are caught before a request; the server still decides.
export function validateListingForm(form: ListingForm): { errors: ListingFormErrors; input: ListingInput | null } {
  const errors: ListingFormErrors = {};
  const title = form.title.trim();
  const description = form.description.trim();
  const area = form.area.trim();
  const city = form.city.trim();
  const terms = form.borrowingTerms.trim();
  const tags = form.tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  if (title.length < 3) errors.title = 'Enter a title of at least 3 characters.';
  else if (title.length > 80) errors.title = 'Keep the title under 80 characters.';

  if (description.length < 10) errors.description = 'Describe the item in at least 10 characters.';
  else if (description.length > 2000) errors.description = 'Keep the description under 2000 characters.';

  let replacementValuePkr: number | null = null;
  const rawValue = form.replacementValue.replace(/[,\s]/g, '');
  if (rawValue) {
    if (!/^\d+$/.test(rawValue) || Number(rawValue) > 10_000_000) {
      errors.replacementValue = 'Enter a whole number of rupees up to 10,000,000.';
    } else {
      replacementValuePkr = Number(rawValue);
    }
  }

  if (terms.length > 1000) errors.borrowingTerms = 'Keep the borrowing terms under 1000 characters.';
  if (area && (area.length < 2 || area.length > 80)) errors.area = 'Enter an area between 2 and 80 characters.';
  if (city && (city.length < 2 || city.length > 80)) errors.city = 'Enter a city between 2 and 80 characters.';

  if (tags.length > 5) errors.tags = 'Use at most 5 tags.';
  else if (tags.some((t) => t.length > 24)) errors.tags = 'Keep each tag under 24 characters.';

  if (Object.keys(errors).length > 0) return { errors, input: null };
  return {
    errors,
    input: {
      title,
      description,
      category: form.category,
      condition: form.condition,
      replacementValuePkr,
      borrowingTerms: terms || null,
      area: area || null,
      city: city || null,
      teachMeEnabled: form.teachMeEnabled,
      tags,
    },
  };
}

// API field names -> form fields, for VALIDATION_ERROR responses.
const SERVER_FIELDS: Record<string, ListingFormField> = {
  title: 'title',
  description: 'description',
  category: 'category',
  condition: 'condition',
  replacementValuePkr: 'replacementValue',
  borrowingTerms: 'borrowingTerms',
  area: 'area',
  city: 'city',
  tags: 'tags',
  teachMeEnabled: 'teachMeEnabled',
};

export function serverFieldErrors(issues: FieldIssue[]): ListingFormErrors {
  const errors: ListingFormErrors = {};
  for (const issue of issues) {
    const field = issue.field ? SERVER_FIELDS[issue.field.split('.')[0] ?? ''] : undefined;
    if (field && !errors[field]) errors[field] = `${issue.message.charAt(0).toUpperCase()}${issue.message.slice(1)}.`;
  }
  return errors;
}
