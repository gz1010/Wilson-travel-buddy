import { bearingDegrees, formatDistance, walkingMinutes } from '../../core/geo';
import type { GeoPoint, PlaceCategory } from '../../core/types';

// Words the Dusk screens share for places: how far, which way, what kind.

/** Closer than this, a place reads "Here" instead of a distance and direction. */
export const HERE_METERS = 20;

const COMPASS_WORDS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

/** The compass word for a bearing, as the design reads it ("350 m north"). */
export function compassWord(bearing: number): string {
  return COMPASS_WORDS[Math.round(bearing / 45) % 8];
}

/** Distance, direction and walking time from one point to another. */
export function directions(from: GeoPoint, to: GeoPoint, meters: number) {
  const bearing = bearingDegrees(from, to);
  return {
    here: meters < HERE_METERS,
    bearing,
    distance: formatDistance(meters),
    word: compassWord(bearing),
    walk: walkingMinutes(meters),
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Welcome's line about the offline pack: "Seville guide prepared Nov 14 · 60 places · 97 facts ·
 * 52 photos", or how to prepare it when it never was.
 */
export function preparedLine(
  city: string,
  p: { preparedAt: string | null; places: number; facts: number; photos: number } | undefined,
): string {
  if (!p?.preparedAt) return 'Not prepared yet: run node scripts/prepare-pack.mjs while online';
  const d = new Date(p.preparedAt);
  const when = Number.isNaN(d.getTime()) ? '' : ` ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return `${city} guide prepared${when} · ${p.places} places · ${p.facts} facts · ${p.photos} photos`;
}

export const CATEGORY_LABEL: Record<PlaceCategory, string> = {
  landmark: 'Landmark',
  museum: 'Museum',
  church: 'Church',
  park: 'Park',
  viewpoint: 'Viewpoint',
  market: 'Market',
  restaurant: 'Restaurant',
  'tapas-bar': 'Tapas bar',
  cafe: 'Café',
  bar: 'Bar',
  flamenco: 'Flamenco',
  shop: 'Shop',
  neighborhood: 'Neighbourhood',
  hotel: 'Hotel',
};
