import { distanceMeters, walkingMinutes } from './geo';
import type { PackIndex } from './pack';
import { sunTimes } from './sun';
import { formatHHMM, openState } from './time';
import { nextFixedStop } from './trip';
import type { Candidate, Interest, Place, Situation, Trip } from './types';

// Ranking happens here, in code, never in the model: small models get
// distances, opening hours and arithmetic wrong. The model only chooses
// among the top candidates and explains the choice (see recommend.ts).

/** How each part of the score is weighted. Tune these, not the model prompt. */
export const WEIGHTS = {
  interest: 1.0,
  distance: 0.8,
  weather: 1.0,
  timeOfDay: 0.6,
  fixedStop: 0.8,
};

const MEAL_CATEGORIES = new Set(['restaurant', 'tapas-bar']);
const EVENING_CATEGORIES = new Set(['bar', 'flamenco']);
/** Chance of rain, in percent, from which plans should change. */
export const RAIN_THRESHOLD = 50;

export interface ScoreOptions {
  /** Ignore places further than this many minutes' walk. */
  maxWalkMinutes?: number;
  limit?: number;
}

export function scoreCandidates(index: PackIndex, trip: Trip | undefined, sit: Situation, opts: ScoreOptions = {}): Candidate[] {
  const { maxWalkMinutes = 40, limit = 8 } = opts;
  const dest = index.destination;
  const sun = sunTimes(sit.clock.date, dest.center, dest.utcOffsetMinutes);
  const ahead = index.forecastAhead(sit.clock, 3);
  const rainSoon = ahead.find(h => h.precipitationChance >= RAIN_THRESHOLD);
  const now = ahead[0];
  const next = trip ? nextFixedStop(trip, sit.clock) : undefined;
  const nextPlace = next?.stop.placeId ? index.place(next.stop.placeId) : undefined;
  const interests = new Set<Interest>(trip?.interests ?? []);
  const visited = new Set(sit.visited);
  const fixedToday = new Set(trip?.stops.filter(s => s.fixed && s.placeId).map(s => s.placeId!));

  const out: Candidate[] = [];
  for (const place of index.pack.places) {
    if (visited.has(place.id) || place.category === 'hotel' || fixedToday.has(place.id)) continue;

    const meters = distanceMeters(sit.location, place.point);
    const walk = walkingMinutes(meters);
    if (walk > maxWalkMinutes) continue;

    const arrival = sit.clock.minute + walk;
    const open = openState(place.hours, { date: sit.clock.date, minute: Math.min(arrival, 1439) });
    if (!open.open) continue;
    const timeThere = Math.min(place.visitMinutes, 45);
    if (open.minutesLeft !== undefined && open.minutesLeft < timeThere) continue;

    const notes: string[] = [`${walk} min walk`];
    if (open.closesAt) notes.push(`closes ${open.closesAt}`);

    // Interests
    const matched = place.tags.filter(t => interests.has(t));
    let interestScore = interests.size ? matched.length / Math.min(3, interests.size) : 0.3;
    interestScore = Math.min(1, interestScore);
    if (matched.length) notes.push(`matches: ${matched.join(', ')}`);

    // Distance: close is better; nothing beyond maxWalkMinutes gets here.
    const distanceScore = 1 - walk / maxWalkMinutes;

    // Weather
    let weatherScore = 0;
    if (rainSoon) {
      const hour = rainSoon.time.slice(11);
      if (place.indoor) {
        weatherScore += 0.5;
        notes.push(`indoor; rain ${rainSoon.precipitationChance}% from ${hour}`);
      } else {
        weatherScore -= 0.8;
        notes.push(`outdoor; rain ${rainSoon.precipitationChance}% from ${hour}`);
      }
    }
    if (now && now.temperatureC >= 32 && !place.indoor && arrival > 12 * 60 && arrival < 18 * 60) {
      weatherScore -= 0.4;
      notes.push(`hot: ${Math.round(now.temperatureC)}°C`);
    }

    // Time of day
    let timeScore = 0;
    if (sun.sunset !== undefined) {
      const toSunset = sun.sunset - arrival;
      if (place.tags.includes('views') && !place.indoor && toSunset > 0 && toSunset <= 90) {
        timeScore += 0.8;
        notes.push(`sunset ${formatHHMM(sun.sunset)}`);
      }
      const dark = toSunset < -20 || (sun.sunrise !== undefined && arrival < sun.sunrise);
      if (!place.indoor && dark && !EVENING_CATEGORIES.has(place.category) && place.category !== 'neighborhood') {
        timeScore -= 0.6;
        notes.push('after dark');
      }
    }
    const lunch = arrival >= 13 * 60 + 30 && arrival <= 16 * 60;
    const dinner = arrival >= 20 * 60 + 30 && arrival <= 23 * 60 + 30;
    if (MEAL_CATEGORIES.has(place.category)) {
      timeScore += lunch || dinner ? 0.6 : -0.3;
      if (lunch) notes.push('lunch time');
      if (dinner) notes.push('dinner time');
    }
    if (EVENING_CATEGORIES.has(place.category)) timeScore += arrival >= 20 * 60 ? 0.6 : -0.5;

    // The next fixed stop: prefer places that fit before it, near it.
    let fixedScore = 0;
    if (next && next.minutesUntil > 0) {
      const backWalk = nextPlace ? walkingMinutes(distanceMeters(place.point, nextPlace.point)) : 0;
      const needed = walk + timeThere + backWalk;
      if (needed <= next.minutesUntil) {
        fixedScore += 0.3 + (nextPlace && backWalk <= 15 ? 0.4 : 0);
        notes.push(
          nextPlace
            ? `${backWalk} min from your ${next.stop.start} ${next.stop.title}`
            : `fits before your ${next.stop.start} ${next.stop.title}`,
        );
      } else {
        fixedScore -= 0.8;
        notes.push(`tight before your ${next.stop.start} ${next.stop.title}`);
      }
    }

    const score =
      WEIGHTS.interest * interestScore +
      WEIGHTS.distance * distanceScore +
      WEIGHTS.weather * weatherScore +
      WEIGHTS.timeOfDay * timeScore +
      WEIGHTS.fixedStop * fixedScore;

    out.push({
      place,
      score: Math.round(score * 1000) / 1000,
      walkMinutes: walk,
      closesAt: open.closesAt,
      matchedInterests: matched,
      notes,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** A reason written by code, used until (or instead of) the model's. */
export function templateReason(c: Candidate): string {
  const bits = [`${c.walkMinutes} min walk`];
  const fit = c.notes.find(n => n.includes('from your') || n.startsWith('fits before'));
  if (fit) bits.push(fit);
  const weather = c.notes.find(n => n.startsWith('indoor; rain'));
  if (weather) bits.push(`indoors, and ${weather.replace('indoor; ', '')}`);
  const sunset = c.notes.find(n => n.startsWith('sunset'));
  if (sunset) bits.push(`good light before ${sunset}`);
  if (c.matchedInterests.length) bits.push(`you like ${c.matchedInterests.slice(0, 2).join(' and ')}`);
  if (c.closesAt) bits.push(`open until ${c.closesAt}`);
  const s = bits.slice(0, 3).join('; ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

export function describePlace(p: Place): string {
  return `${p.name}${p.neighborhood ? `, ${p.neighborhood}` : ''}: ${p.summary}`;
}
