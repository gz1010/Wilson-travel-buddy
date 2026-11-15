import { sunTimes } from './sun';
import type { Clock, Destination, Place, TimeOfDay } from './types';

// Plain-code decisions for the Dusk design: which city photo fits the clock,
// how big a place name is drawn, and which drawn scene a place without a
// photo gets. The model is never involved in any of this.

export const TIMES_OF_DAY: TimeOfDay[] = ['midday', 'afternoon', 'dusk', 'night'];

export const TIME_OF_DAY_LABEL: Record<TimeOfDay, string> = {
  midday: 'Midday',
  afternoon: 'Afternoon',
  dusk: 'Dusk',
  night: 'Night',
};

/** Dusk is the hour around sunset: 45 min before to 30 min after. */
const DUSK_BEFORE = 45;
const DUSK_AFTER = 30;

/** Which of the four looks the clock is in, from the on-device sunrise and sunset. */
export function timeOfDay(clock: Clock, dest: Destination): TimeOfDay {
  const sun = sunTimes(clock.date, dest.center, dest.utcOffsetMinutes);
  const sunrise = sun.sunrise ?? 7 * 60;
  const sunset = sun.sunset ?? 19 * 60;
  const m = clock.minute;
  if (m < sunrise || m >= sunset + DUSK_AFTER) return 'night';
  if (m >= sunset - DUSK_BEFORE) return 'dusk';
  if (m >= 14 * 60) return 'afternoon';
  return 'midday';
}

/** The time a time-of-day chip sets the clock to on the clock's date. */
export function clockFor(tod: TimeOfDay, clock: Clock, dest: Destination): Clock {
  const sun = sunTimes(clock.date, dest.center, dest.utcOffsetMinutes);
  const sunset = Math.round(sun.sunset ?? 19 * 60);
  const minute = {
    midday: 12 * 60,
    afternoon: Math.min(15 * 60 + 30, sunset - DUSK_BEFORE - 30),
    // Rounded to the quarter hour so the clock reads naturally.
    dusk: Math.round((sunset - 20) / 15) * 15,
    night: Math.max(21 * 60, sunset + DUSK_AFTER + 30),
  }[tod];
  return { date: clock.date, minute };
}

/** Place names are drawn huge and cut off by the card edge: 62, 54 or 46 px by length. */
export function placeNameSize(name: string): 62 | 54 | 46 {
  return name.length > 16 ? 46 : name.length > 13 ? 54 : 62;
}

export type Scene = 'arches' | 'awnings' | 'cup' | 'tower' | 'river';

const RIVER = /\b(triana|guadalquivir|betis|puente|bridge|river|r[ií]o|torre del oro)\b/i;

/** The drawn scene tile for a place without a photo. */
export function sceneFor(place: Place): Scene {
  if (RIVER.test(`${place.name} ${place.localName ?? ''} ${place.neighborhood ?? ''}`) && (place.tags.includes('views') || place.category === 'viewpoint')) {
    return 'river';
  }
  switch (place.category) {
    case 'market':
    case 'bar':
    case 'tapas-bar':
    case 'restaurant':
    case 'flamenco':
      return 'awnings';
    case 'cafe':
      return 'cup';
    case 'church':
    case 'museum':
      return 'tower';
    case 'viewpoint':
      return 'river';
    default:
      return 'arches'; // landmarks, plazas, palaces, parks, neighbourhoods
  }
}
