import type { DateRange } from '../api/types';

// Calendar dates (YYYY-MM-DD), inclusive at both ends, in Pakistan time.
// Same rules as the server (backend/src/borrow/dates.ts); the server decides.

const PAKISTAN_UTC_OFFSET_MS = 5 * 60 * 60 * 1000;
export const MAX_BORROW_DAYS = 30;
export const MAX_DAYS_AHEAD = 90;

export function todayInPakistan(nowMs: number = Date.now()): string {
  return new Date(nowMs + PAKISTAN_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function inclusiveDays(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return a.startDate <= b.endDate && b.startDate <= a.endDate;
}

export function isBooked(date: string, booked: DateRange[]): boolean {
  return booked.some((r) => r.startDate <= date && date <= r.endDate);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dateParts(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  return { weekday: WEEKDAYS[d.getUTCDay()]!, day: d.getUTCDate(), month: MONTHS[d.getUTCMonth()]! };
}

// "12 Nov" or "12 Nov – 14 Nov".
export function formatRange(start: string, end: string): string {
  const a = dateParts(start);
  const b = dateParts(end);
  return start === end ? `${a.day} ${a.month}` : `${a.day} ${a.month} – ${b.day} ${b.month}`;
}

// Why a selected range cannot be requested, or null if it can.
export function rangeProblem(range: DateRange | null, booked: DateRange[], today: string): string | null {
  if (!range) return 'Choose a start and end date.';
  if (range.startDate < today) return 'Choose dates from today onwards.';
  if (range.startDate > addDays(today, MAX_DAYS_AHEAD)) return `Choose a start date within ${MAX_DAYS_AHEAD} days.`;
  if (range.endDate < range.startDate) return 'The end date must be on or after the start date.';
  if (inclusiveDays(range.startDate, range.endDate) > MAX_BORROW_DAYS) return `You can borrow for at most ${MAX_BORROW_DAYS} days.`;
  if (booked.some((b) => rangesOverlap(b, range))) return 'Some of those days are already booked.';
  return null;
}
