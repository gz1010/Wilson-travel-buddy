import type { Clock, OpeningHours } from './types';

// Destination wall-clock helpers. Dates are "YYYY-MM-DD" strings and times
// are minutes since midnight; JavaScript Dates are only used in UTC so the
// Mac's own time zone never leaks in.

export const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parseDate(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** 0 = Sunday. */
export function weekday(date: string): number {
  return parseDate(date).getUTCDay();
}

export function addDays(date: string, days: number): string {
  const d = parseDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86_400_000);
}

/** Day of the month of the last Sunday in `month` (1–12). */
function lastSunday(year: number, month: number): number {
  const last = new Date(Date.UTC(year, month, 0));
  return last.getUTCDate() - last.getUTCDay();
}

/** True in EU summer time: 01:00 UTC on the last Sunday of March until 01:00 UTC on the last Sunday of October. */
export function euSummerTime(ms: number): boolean {
  const year = new Date(ms).getUTCFullYear();
  return ms >= Date.UTC(year, 2, lastSunday(year, 3), 1) && ms < Date.UTC(year, 9, lastSunday(year, 10), 1);
}

/**
 * The destination's wall clock at `ms` (the Mac's own clock, milliseconds since 1970): its
 * standard UTC offset (destination.json's utcOffsetMinutes), plus an hour in summer time.
 */
export function cityClock(ms: number, utcOffsetMinutes: number, summerTime: (ms: number) => boolean = euSummerTime): Clock {
  const t = new Date(ms + (utcOffsetMinutes + (summerTime(ms) ? 60 : 0)) * 60_000);
  return { date: t.toISOString().slice(0, 10), minute: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

export function parseHHMM(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`Bad time "${s}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function formatHHMM(minute: number): string {
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** "Tue 14:30" */
export function formatClock(clock: Clock): string {
  return `${WEEKDAY_NAMES[weekday(clock.date)].slice(0, 3)} ${formatHHMM(clock.minute)}`;
}

/** Moves the clock, rolling over midnight. */
export function shiftClock(clock: Clock, minutes: number): Clock {
  const total = clock.minute + minutes;
  const dayShift = Math.floor(total / 1440);
  return { date: addDays(clock.date, dayShift), minute: total - dayShift * 1440 };
}

/** Minutes from a to b; negative if b is earlier. */
export function minutesBetween(a: Clock, b: Clock): number {
  return daysBetween(a.date, b.date) * 1440 + (b.minute - a.minute);
}

// ---------------------------------------------------------------------------
// Opening hours

interface Range {
  start: number;
  end: number; // may exceed 1440 for ranges past midnight
}

function rangesFor(hours: OpeningHours, date: string): Range[] | 'unknown' {
  const key = WEEKDAY_KEYS[weekday(date)];
  const spec = hours[key] ?? hours.daily;
  if (spec === undefined) return 'unknown';
  const s = spec.trim().toLowerCase();
  if (s === 'closed') return [];
  if (s === '24h') return [{ start: 0, end: 1440 }];
  return s.split(',').map(part => {
    const [a, b] = part.split('-');
    const start = parseHHMM(a);
    let end = parseHHMM(b);
    if (end <= start) end += 1440;
    return { start, end };
  });
}

export interface OpenState {
  open: boolean;
  /** Minutes until closing, when open. */
  minutesLeft?: number;
  /** Closing time "HH:MM", when open and it closes. */
  closesAt?: string;
  /** Next opening today, "HH:MM", when closed. */
  opensAt?: string;
  /** True when the pack has no hours for this day. */
  unknown?: boolean;
}

export function openState(hours: OpeningHours, clock: Clock): OpenState {
  // A range from yesterday that runs past midnight counts too.
  const yesterday = rangesFor(hours, addDays(clock.date, -1));
  if (yesterday !== 'unknown') {
    for (const r of yesterday) {
      if (r.end > 1440 && clock.minute < r.end - 1440) {
        return { open: true, minutesLeft: r.end - 1440 - clock.minute, closesAt: formatHHMM(r.end) };
      }
    }
  }
  const today = rangesFor(hours, clock.date);
  if (today === 'unknown') return { open: true, unknown: true };
  for (const r of today) {
    if (clock.minute >= r.start && clock.minute < r.end) {
      const always = r.start === 0 && r.end === 1440;
      return always
        ? { open: true }
        : { open: true, minutesLeft: r.end - clock.minute, closesAt: formatHHMM(r.end) };
    }
  }
  const next = today.find(r => r.start > clock.minute);
  return { open: false, opensAt: next ? formatHHMM(next.start) : undefined };
}
