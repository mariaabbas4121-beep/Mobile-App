// Calendar dates (YYYY-MM-DD) for borrow requests. Both ends of a range are
// inclusive: 2026-11-05..2026-11-07 is three days. The pilot runs in Pakistan
// (UTC+5, no daylight saving), so "today" is Pakistan's date; the database
// applies the same rule (public.borrow_today()).

export const PAKISTAN_UTC_OFFSET_MS = 5 * 60 * 60 * 1000;
// Limits shared with the migration's checks.
export const MAX_BORROW_DAYS = 30;
export const MAX_DAYS_AHEAD = 90;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isCalendarDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

export function todayInPakistan(nowMs: number): string {
  return new Date(nowMs + PAKISTAN_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Number of days in the inclusive range.
export function inclusiveDays(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

// Inclusive ranges overlap when they share at least one day.
export function rangesOverlap(a: { startDate: string; endDate: string }, b: { startDate: string; endDate: string }): boolean {
  return a.startDate <= b.endDate && b.startDate <= a.endDate;
}
