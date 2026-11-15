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
