import { addDays, formatHHMM, parseHHMM, weekday, WEEKDAY_NAMES } from './time';
import { tripDay } from './trip';
import type { Stop, Trip } from './types';

// The Now screen's day plan, in plain code: which days the day strip shows, and which rows a
// day's timeline has (the default times, the planned stops, and "now" on today). Which places
// fill the free times comes from the recommender; this file only keeps them from repeating.

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The default times of a day's timeline, in minutes since midnight. */
export const DAY_SLOTS: readonly number[] = [9, 11, 13, 16, 18, 20, 22].map(h => h * 60);

/** On today, free times this soon after the clock are left out: "now" covers them. */
export const NOW_COVERS_MINUTES = 60;

/** A stop with no duration is taken to last this long when deciding which times it fills. */
export const DEFAULT_STOP_MINUTES = 60;

/** The most days the strip shows: the longest trip the planner makes. */
export const MAX_PLAN_DAYS = 14;

export interface PlanDay {
  /** YYYY-MM-DD at the destination. */
  date: string;
  /** "Sun 15" */
  label: string;
  /** "Nov": on the first day, and on a day whose month differs from the day before. */
  month?: string;
  /** "Sunday 15 November", for VoiceOver. */
  spoken: string;
  /** 1-based day of the trip, when the date is in it. */
  tripDay?: number;
  /** The clock's date. */
  today: boolean;
}

const monthOf = (date: string) => MONTH_NAMES[Number(date.slice(5, 7)) - 1] ?? '';
const dayOfMonth = (date: string) => Number(date.slice(8, 10));

/** "Sun 15" */
export function dayLabel(date: string): string {
  return `${WEEKDAY_NAMES[weekday(date)].slice(0, 3)} ${dayOfMonth(date)}`;
}

/** "Nov" */
export function monthLabel(date: string): string {
  return monthOf(date).slice(0, 3);
}

/** "Sunday 15 November" */
export function spokenDate(date: string): string {
  return `${WEEKDAY_NAMES[weekday(date)]} ${dayOfMonth(date)} ${monthOf(date)}`;
}

/** The dates a saved forecast covers, in order. */
export function forecastDates(hours: readonly { time: string }[]): string[] {
  return [...new Set(hours.map(h => h.time.slice(0, 10)))].sort();
}

/**
 * The dates the strip shows. With a trip: every day of it, from its start date (so days added in
 * Chat show up at once). Without one: today and the following days the saved forecast covers.
 * Today is always there, in date order, so "now" can be reached even outside the trip.
 */
export function planDates(trip: Trip | undefined, today: string, forecast: readonly string[] = []): string[] {
  let dates: string[];
  if (trip) {
    const n = Math.max(1, Math.min(MAX_PLAN_DAYS, Math.floor(trip.days) || 1));
    dates = Array.from({ length: n }, (_, i) => addDays(trip.startDate, i));
  } else {
    dates = [...new Set(forecast)].filter(d => d > today).sort().slice(0, MAX_PLAN_DAYS - 1);
  }
  return dates.includes(today) ? dates : [...dates, today].sort();
}

/** The strip's days, labelled. */
export function planDays(trip: Trip | undefined, today: string, forecast: readonly string[] = []): PlanDay[] {
  const dates = planDates(trip, today, forecast);
  return dates.map((date, i) => {
    const prev = dates[i - 1];
    return {
      date,
      label: dayLabel(date),
      month: !prev || prev.slice(0, 7) !== date.slice(0, 7) ? monthLabel(date) : undefined,
      spoken: spokenDate(date),
      tripDay: trip ? tripDay(trip, date) : undefined,
      today: date === today,
    };
  });
}

export interface TimelineRow {
  /** Stable within a day: "any", "stop-780", "slot-540" or "now". */
  key: string;
  /** Minutes since midnight; undefined for the stops that have no time. */
  minute?: number;
  /** "09:00", or "Any time". */
  label: string;
  /** The stops that start at this time (or have none), in trip order. */
  stops: Stop[];
  /** A free time: suggestions for it go here. */
  open: boolean;
  /** Over by the clock, on today (a stop still going on is not past). */
  past: boolean;
  /** The clock's own row, on today: what to do right now. */
  now: boolean;
}

/** A stop's start in minutes, or undefined when it has no (valid) time. */
export function stopStart(stop: Stop): number | undefined {
  if (!stop.start) return undefined;
  try {
    return parseHHMM(stop.start);
  } catch {
    return undefined;
  }
}

/** "13:00–14:30", "13:00", or undefined for a stop with no time. */
export function stopSpan(stop: Stop): string | undefined {
  const start = stopStart(stop);
  if (start === undefined) return undefined;
  return stop.durationMinutes ? `${formatHHMM(start)}–${formatHHMM(start + stop.durationMinutes)}` : formatHHMM(start);
}

/** At the same minute: a stop first, then a free time, then "now". */
const rowOrder = (r: TimelineRow) => (r.now ? 2 : r.open ? 1 : 0);

/** When a stop is over, in minutes (a stop with no duration lasts DEFAULT_STOP_MINUTES). */
const stopEnd = (start: number, s: Stop) => start + (s.durationMinutes || DEFAULT_STOP_MINUTES);

/**
 * A day's timeline, top to bottom. Stops with no time come first ("Any time"); then, by time,
 * the stops and the default times that no stop fills. On today (`now` given): stops that are over
 * stay (marked past; one still going on is not), past default times go, the clock gets its own
 * row, and default times in the hour after it are left to that row.
 */
export function dayTimeline(stops: readonly Stop[], opts: { now?: number; slots?: readonly number[] } = {}): TimelineRow[] {
  const { now, slots = DAY_SLOTS } = opts;
  const head: TimelineRow[] = [];
  const untimed = stops.filter(s => stopStart(s) === undefined);
  if (untimed.length) head.push({ key: 'any', label: 'Any time', stops: untimed, open: false, past: false, now: false });

  const byMinute = new Map<number, Stop[]>();
  for (const s of stops) {
    const m = stopStart(s);
    if (m !== undefined) byMinute.set(m, [...(byMinute.get(m) ?? []), s]);
  }
  const rows: TimelineRow[] = [...byMinute].map(([m, at]) => ({
    key: `stop-${m}`,
    minute: m,
    label: formatHHMM(m),
    stops: at,
    open: false,
    past: now !== undefined && at.every(s => stopEnd(m, s) <= now),
    now: false,
  }));

  const filled = (m: number) =>
    stops.some(s => {
      const start = stopStart(s);
      return start !== undefined && start <= m && m < stopEnd(start, s);
    });
  for (const m of slots) {
    if (filled(m)) continue;
    if (now !== undefined && m < now + NOW_COVERS_MINUTES) continue;
    rows.push({ key: `slot-${m}`, minute: m, label: formatHHMM(m), stops: [], open: true, past: false, now: false });
  }
  if (now !== undefined) {
    rows.push({ key: 'now', minute: now, label: formatHHMM(now), stops: [], open: true, past: false, now: true });
  }
  rows.sort((a, b) => a.minute! - b.minute! || rowOrder(a) - rowOrder(b));
  return [...head, ...rows];
}

/**
 * Keeps a day's suggestions from repeating: down the day, each list gives its first `per` items
 * whose place is not taken yet (by a stop, by "now", or by an earlier time).
 */
export function pickDistinct<T extends { place: { id: string } }>(lists: readonly (readonly T[])[], taken: Iterable<string> = [], per = 1): T[][] {
  const used = new Set(taken);
  return lists.map(list => {
    const out: T[] = [];
    for (const c of list) {
      if (out.length >= per) break;
      if (used.has(c.place.id)) continue;
      used.add(c.place.id);
      out.push(c);
    }
    return out;
  });
}

/** The place of the latest stop starting before `minute`: where the traveller will be then, if planned. */
export function placeBefore(stops: readonly Stop[], minute: number): string | undefined {
  let best: { m: number; id: string } | undefined;
  for (const s of stops) {
    const m = stopStart(s);
    if (m !== undefined && s.placeId && m < minute && (!best || m >= best.m)) best = { m, id: s.placeId };
  }
  return best?.id;
}

/**
 * A reason written by code without its leading "8 min walk" (the card shows the walk on its own
 * pill). Undefined when nothing is left.
 */
export function reasonWithoutWalk(reason: string): string | undefined {
  const rest = reason.replace(/^\s*\d+\s*min walk\s*(?:[;,.]\s*|$)/i, '').trim();
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : undefined;
}
