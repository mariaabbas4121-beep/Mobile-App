import { z } from 'zod';
import { BORROW_STATUSES } from './borrow.types.js';
import { MAX_BORROW_DAYS, MAX_DAYS_AHEAD, addDays, inclusiveDays, isCalendarDate } from './dates.js';

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'must be a date in YYYY-MM-DD format' })
  .refine(isCalendarDate, { error: 'must be a real calendar date' });

// Strict: borrower and lender ids are never taken from the body; they come
// from the access token and the listing.
export const borrowRequestCreateBody = z
  .object({
    listingId: z.uuid({ error: 'must be a valid id' }),
    startDate: calendarDate,
    endDate: calendarDate,
    message: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
      z.string().trim().max(500, { error: 'must be at most 500 characters' }).nullable().optional(),
    ),
  })
  .strict();

export type BorrowRequestCreateBody = z.infer<typeof borrowRequestCreateBody>;

export const borrowRequestListQuery = z.object({
  status: z.enum(BORROW_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const borrowRequestParams = z.object({ id: z.uuid({ error: 'must be a valid id' }) });

// Date rules that depend on today's date, as field issues in the same shape
// as VALIDATION_ERROR details. Ends are inclusive; same-day is allowed.
export function dateWindowIssues(startDate: string, endDate: string, today: string) {
  const issues: { field: string; message: string }[] = [];
  if (startDate < today) issues.push({ field: 'startDate', message: 'must be today or later' });
  else if (startDate > addDays(today, MAX_DAYS_AHEAD)) {
    issues.push({ field: 'startDate', message: `must be within ${MAX_DAYS_AHEAD} days from today` });
  }
  if (endDate < startDate) issues.push({ field: 'endDate', message: 'must be on or after the start date' });
  else if (inclusiveDays(startDate, endDate) > MAX_BORROW_DAYS) {
    issues.push({ field: 'endDate', message: `must be at most ${MAX_BORROW_DAYS} days after the start date, counting both days` });
  }
  return issues;
}
