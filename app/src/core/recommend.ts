import type { PackIndex } from './pack';
import { prompts } from './prompts';
import { scoreCandidates, templateReason } from './scoring';
import { sunTimes } from './sun';
import { formatClock, formatHHMM } from './time';
import { nextFixedStop } from './trip';
import type { Candidate, JSONSchema, LLMClient, Recommendation, Situation, Trip } from './types';

interface Picks {
  picks: { place_id: string; reason: string }[];
}

/** The place_id enum is the candidate list, so the grammar makes an invented place impossible. */
export function picksSchema(candidates: Candidate[]): JSONSchema {
  return {
    type: 'object',
    properties: {
      picks: {
        type: 'array',
        minItems: 1,
        maxItems: Math.min(3, candidates.length),
        items: {
          type: 'object',
          properties: {
            place_id: { type: 'string', enum: candidates.map(c => c.place.id) },
            reason: { type: 'string', maxLength: 180 },
          },
          required: ['place_id', 'reason'],
        },
      },
    },
    required: ['picks'],
  };
}

export class Recommender {
  constructor(private llm: LLMClient, private index: PackIndex, private timeoutMs = 12_000) {}

  candidates(trip: Trip | undefined, sit: Situation): Candidate[] {
    return scoreCandidates(this.index, trip, sit);
  }

  /** Instant: the top three with reasons written by code. Shown while the model thinks. */
  quick(trip: Trip | undefined, sit: Situation): Recommendation[] {
    return this.candidates(trip, sit)
      .slice(0, 3)
      .map(c => ({ placeId: c.place.id, reason: templateReason(c), candidate: c, fromModel: false }));
  }

  /** The model picks three of the top eight and explains them. Falls back to quick() on any failure. */
  async refine(trip: Trip | undefined, sit: Situation): Promise<Recommendation[]> {
    const candidates = this.candidates(trip, sit);
    if (candidates.length === 0) return [];
    const fallback = () => candidates.slice(0, 3).map(c => ({ placeId: c.place.id, reason: templateReason(c), candidate: c, fromModel: false }));
    try {
      const result = await withTimeout(
        this.llm.json<Picks>(
          {
            tag: 'recommend',
            maxTokens: 400,
            temperature: 0.5,
            messages: [
              { role: 'system', content: prompts.recommend(this.index.destination.name) },
              { role: 'user', content: this.context(trip, sit, candidates) },
            ],
          },
          picksSchema(candidates),
        ),
        this.timeoutMs,
      );
      const byId = new Map(candidates.map(c => [c.place.id, c]));
      const seen = new Set<string>();
      const recs: Recommendation[] = [];
      for (const p of result.picks ?? []) {
        const c = byId.get(p.place_id);
        if (!c || seen.has(c.place.id)) continue; // never trust an ID the code did not offer
        seen.add(c.place.id);
        const reason = p.reason?.trim();
        recs.push({ placeId: c.place.id, reason: reason || templateReason(c), candidate: c, fromModel: !!reason });
      }
      return recs.length ? recs : fallback();
    } catch {
      return fallback();
    }
  }

  private context(trip: Trip | undefined, sit: Situation, candidates: Candidate[]): string {
    const dest = this.index.destination;
    const sun = sunTimes(sit.clock.date, dest.center, dest.utcOffsetMinutes);
    const weather = this.index.forecastAt(sit.clock);
    const next = trip ? nextFixedStop(trip, sit.clock) : undefined;
    const lines = [
      `Now: ${formatClock(sit.clock)}, near ${sit.locationLabel}.`,
      weather ? `Weather: ${Math.round(weather.temperatureC)}°C, ${weather.precipitationChance}% chance of rain this hour.` : '',
      sun.sunset !== undefined ? `Sunset: ${formatHHMM(sun.sunset)}.` : '',
      trip?.interests.length ? `They like: ${trip.interests.join(', ')}.` : '',
      next ? `Next booking: ${next.stop.title} at ${next.stop.start} (in ${next.minutesUntil} min).` : '',
      '',
      'Candidates:',
      ...candidates.map(c => `- id=${c.place.id} | ${c.place.name} (${c.place.category}) | ${c.notes.join('; ')}`),
    ];
    return lines.filter(l => l !== '').join('\n');
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms);
    p.then(
      v => {
        clearTimeout(t);
        resolve(v);
      },
      e => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** What the companion says aloud for "what should I do now?". */
export function spokenSummary(recs: Recommendation[]): string {
  if (recs.length === 0) return "Nothing nearby fits right now. Try moving the clock or your location.";
  const [top, ...rest] = recs;
  const alsoNames = rest.map(r => r.candidate.place.name);
  const also = alsoNames.length ? ` Or try ${alsoNames.join(' or ')}.` : '';
  return `${top.candidate.place.name}. ${top.reason}${also}`;
}
