import type { PackIndex } from './pack';
import { prompts } from './prompts';
import { addDays, daysBetween, minutesBetween, parseHHMM, weekday, WEEKDAY_NAMES } from './time';
import { INTERESTS, type Clock, type Interest, type JSONSchema, type LLMClient, type Stop, type Trip } from './types';

// Trip setup by voice: the model turns what the traveller said into JSON
// that a grammar forces into this schema; code then resolves days, times and
// place names against the pack.

export interface TripDraft {
  days: number;
  base_area: string | null;
  interests: Interest[];
  stops: {
    title: string;
    place_name: string | null;
    day: number;
    start: string | null;
    duration_minutes: number | null;
    fixed: boolean;
  }[];
}

export const TRIP_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    days: { type: 'integer', minimum: 1, maximum: 14 },
    base_area: { type: ['string', 'null'] },
    interests: { type: 'array', items: { type: 'string', enum: [...INTERESTS] }, maxItems: 6 },
    stops: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          place_name: { type: ['string', 'null'] },
          day: { type: 'integer', minimum: 1, maximum: 14 },
          start: { type: ['string', 'null'], pattern: '^[0-2][0-9]:[0-5][0-9]$' },
          duration_minutes: { type: ['integer', 'null'] },
          fixed: { type: 'boolean' },
        },
        required: ['title', 'place_name', 'day', 'start', 'duration_minutes', 'fixed'],
      },
    },
  },
  required: ['days', 'base_area', 'interests', 'stops'],
};

/** "Day 1 = Saturday 14 Nov, day 2 = Sunday 15 Nov, …": small models need the calendar spelled out. */
export function calendarLines(startDate: string, days = 7): string {
  return Array.from({ length: days }, (_, i) => {
    const d = addDays(startDate, i);
    return `day ${i + 1} = ${WEEKDAY_NAMES[weekday(d)]} ${d}`;
  }).join('\n');
}

let stopCounter = 0;
const newStopId = () => `stop-${Date.now().toString(36)}-${(stopCounter++).toString(36)}`;

/** Turns a draft from the model into a trip, matching place names to the pack. */
export function resolveDraft(draft: TripDraft, index: PackIndex, startDate: string, description: string): Trip {
  const days = Math.max(1, Math.min(14, draft.days || 1));
  const stops: Stop[] = draft.stops.map(s => {
    const place = s.place_name ? index.findPlace(s.place_name) : index.findPlace(s.title);
    let start: string | undefined;
    if (s.start) {
      try {
        parseHHMM(s.start);
        start = s.start;
      } catch {
        start = undefined;
      }
    }
    return {
      id: newStopId(),
      title: s.title,
      placeId: place?.id,
      day: Math.max(1, Math.min(days, s.day || 1)),
      start,
      durationMinutes: s.duration_minutes ?? place?.visitMinutes,
      fixed: !!s.fixed,
    };
  });
  const basePlace = draft.base_area ? index.findPlace(draft.base_area) : undefined;
  return {
    startDate,
    days,
    base: draft.base_area
      ? { name: draft.base_area, placeId: basePlace?.id, point: basePlace?.point }
      : undefined,
    interests: [...new Set(draft.interests.filter(i => (INTERESTS as readonly string[]).includes(i)))],
    stops: sortStops(stops),
    description,
  };
}

export function sortStops(stops: Stop[]): Stop[] {
  return [...stops].sort(
    (a, b) => a.day - b.day || (a.start ? parseHHMM(a.start) : 9999) - (b.start ? parseHHMM(b.start) : 9999),
  );
}

export function tripToDraft(trip: Trip, index: PackIndex): TripDraft {
  return {
    days: trip.days,
    base_area: trip.base?.name ?? null,
    interests: trip.interests,
    stops: trip.stops.map(s => ({
      title: s.title,
      place_name: s.placeId ? index.place(s.placeId)?.name ?? null : null,
      day: s.day,
      start: s.start ?? null,
      duration_minutes: s.durationMinutes ?? null,
      fixed: s.fixed,
    })),
  };
}

export class TripPlanner {
  constructor(private llm: LLMClient, private index: PackIndex) {}

  /** First description of the trip. Day 1 is the clock's date. */
  async extract(description: string, today: string): Promise<Trip> {
    const draft = await this.llm.json<TripDraft>(
      {
        tag: 'trip.extract',
        maxTokens: 700,
        temperature: 0.2,
        messages: [
          { role: 'system', content: prompts.tripExtract(this.index.destination.name, calendarLines(today)) },
          { role: 'user', content: description },
        ],
      },
      TRIP_SCHEMA,
    );
    return resolveDraft(draft, this.index, today, description);
  }

  /** A correction or edit ("move the museum to tomorrow"). Returns the whole new trip. */
  async revise(trip: Trip, instruction: string, today: string): Promise<Trip> {
    const draft = await this.llm.json<TripDraft>(
      {
        tag: 'trip.revise',
        maxTokens: 700,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: prompts.tripRevise(
              this.index.destination.name,
              calendarLines(trip.startDate),
              `today is day ${Math.max(1, daysBetween(trip.startDate, today) + 1)}`,
            ),
          },
          { role: 'user', content: `Current trip:\n${JSON.stringify(tripToDraft(trip, this.index))}\n\nChange: ${instruction}` },
        ],
      },
      TRIP_SCHEMA,
    );
    return resolveDraft(draft, this.index, trip.startDate, `${trip.description}\n${instruction}`);
  }
}

/** 1-based trip day for a date, or undefined outside the trip. */
export function tripDay(trip: Trip, date: string): number | undefined {
  const d = daysBetween(trip.startDate, date) + 1;
  return d >= 1 && d <= trip.days ? d : undefined;
}

export function stopsOn(trip: Trip, date: string): Stop[] {
  const day = tripDay(trip, date);
  return day ? trip.stops.filter(s => s.day === day) : [];
}

/** The next fixed stop today that has a time, and how long until it starts. */
export function nextFixedStop(trip: Trip, clock: Clock): { stop: Stop; minutesUntil: number } | undefined {
  for (const stop of stopsOn(trip, clock.date)) {
    if (!stop.fixed || !stop.start) continue;
    const minutesUntil = minutesBetween(clock, { date: clock.date, minute: parseHHMM(stop.start) });
    if (minutesUntil > 0) return { stop, minutesUntil };
  }
  return undefined;
}

export function summarizeTrip(trip: Trip, index: PackIndex): string {
  const lines = [
    `${trip.days}-day trip starting ${WEEKDAY_NAMES[weekday(trip.startDate)]} ${trip.startDate}.`,
    trip.base ? `Staying near ${trip.base.name}.` : '',
    trip.interests.length ? `Likes: ${trip.interests.join(', ')}.` : '',
    ...trip.stops.map(s => {
      const where = s.placeId ? index.place(s.placeId)?.name : undefined;
      return `Day ${s.day}${s.start ? ` ${s.start}` : ''}: ${s.title}${where && where !== s.title ? ` (${where})` : ''}${s.fixed ? ' [booked]' : ''}`;
    }),
  ];
  return lines.filter(Boolean).join('\n');
}
