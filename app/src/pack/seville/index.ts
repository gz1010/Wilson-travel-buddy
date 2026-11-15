import type { NearbyFile } from '../../core/nearby';
import type { Destination, Fact, Forecast, Pack, Phrase, Place } from '../../core/types';

// Seed data, written by hand from general knowledge: coordinates are
// approximate and opening hours unverified. Replace places with data pulled
// from OpenStreetMap (scripts/fetch-places.mjs) and check hours before the demo.
export const seville: Pack = {
  destination: require('./destination.json') as Destination,
  places: require('./places.json') as Place[],
  facts: require('./facts.json') as Fact[],
  phrases: require('./phrases.json') as Phrase[],
  forecast: require('./forecast.json') as Forecast,
  // Made by scripts/build-nearby.mjs from the map tiles (OpenStreetMap): "find a pharmacy near me".
  nearby: require('./nearby.json') as NearbyFile,
};
