import { bearingDegrees, distanceMeters, formatDistance, walkingMinutes } from './geo';
import { openState, type OpenState } from './time';
import type { Clock, GeoPoint, OpeningHours } from './types';

/**
 * "Find a cinema near me": everything the city's offline map knows, not only the guide's places.
 * scripts/build-nearby.mjs makes src/pack/<city>/nearby.json from the map tiles (OpenStreetMap,
 * with opening hours added while online). Code finds and ranks the places; Wilson only says them,
 * so he never invents a cinema. No network: the index ships with the pack.
 */

export interface NearbyExtra {
  hours?: OpeningHours;
  cuisine?: string;
  nameEn?: string;
  /** The guide's own place, when this is one of them (its page can open). */
  placeId?: string;
  /** Toilets that charge. */
  fee?: boolean;
}
/** One row of nearby.json: [name, kind, lat, lon, extras?]. Name is '' for unnamed cash machines and toilets. */
export type NearbyRow = [string, string, number, number] | [string, string, number, number, NearbyExtra];
export interface NearbyFile {
  source: string;
  builtAt: string;
  /** [west, south, east, north], the area the index covers. */
  bounds: [number, number, number, number];
  items: NearbyRow[];
}

export interface NearbyPlace extends NearbyExtra {
  name: string;
  kind: string;
  point: GeoPoint;
}

export interface NearbyCategory {
  id: string;
  /** "a cinema", for answers. */
  one: string;
  /** OpenStreetMap kinds (as the map tiles name them). */
  kinds: string[];
  /** What people say, in English and Spanish, folded (no accents, lower case). Longest match wins. */
  words: string[];
  /** The guide already curates these (museums, bars…): only answered here when the question is plainly "the nearest". */
  guide?: boolean;
}

export const NEARBY_CATEGORIES: NearbyCategory[] = [
  { id: 'cinema', one: 'cinema', kinds: ['cinema'], words: ['cinema', 'movie theatre', 'movie theater', 'movies', 'movie', 'film', 'films', 'pictures', 'cine', 'cines'] },
  { id: 'theatre', one: 'theatre', kinds: ['theatre', 'arts_centre'], words: ['theatre', 'theater', 'play', 'concert hall', 'teatro', 'auditorio'] },
  { id: 'pharmacy', one: 'pharmacy', kinds: ['pharmacy'], words: ['pharmacy', 'chemist', 'drugstore', 'farmacia', 'medicine', 'paracetamol', 'ibuprofen', 'plasters'] },
  { id: 'supermarket', one: 'supermarket', kinds: ['supermarket', 'convenience', 'greengrocer', 'grocery', 'general', 'deli'], words: ['supermarket', 'grocery', 'groceries', 'grocery store', 'food shop', 'corner shop', 'convenience store', 'supermercado', 'tienda', 'alimentacion'] },
  { id: 'atm', one: 'cash machine', kinds: ['atm', 'bank'], words: ['atm', 'cash machine', 'cashpoint', 'cash', 'bank machine', 'cajero', 'cajero automatico', 'withdraw money'] },
  { id: 'bank', one: 'bank', kinds: ['bank'], words: ['bank', 'banco'] },
  { id: 'exchange', one: 'currency exchange', kinds: ['bureau_de_change', 'money_transfer'], words: ['currency exchange', 'exchange money', 'change money', 'bureau de change', 'cambio', 'casa de cambio'] },
  { id: 'toilets', one: 'public toilet', kinds: ['toilets'], words: ['toilet', 'toilets', 'restroom', 'restrooms', 'bathroom', 'loo', 'wc', 'aseo', 'aseos', 'bano', 'banos', 'servicios'] },
  { id: 'water', one: 'drinking fountain', kinds: ['drinking_water'], words: ['drinking water', 'water fountain', 'drinking fountain', 'fill my bottle', 'fuente de agua'] },
  { id: 'hospital', one: 'hospital', kinds: ['hospital'], words: ['hospital', 'emergency room', 'a and e', 'urgencias', 'emergencias'] },
  { id: 'doctor', one: 'doctor or clinic', kinds: ['clinic', 'doctors', 'hospital'], words: ['doctor', 'doctors', 'clinic', 'medical centre', 'medical center', 'gp', 'medico', 'clinica', 'centro de salud'] },
  { id: 'dentist', one: 'dentist', kinds: ['dentist'], words: ['dentist', 'dentista'] },
  { id: 'police', one: 'police station', kinds: ['police'], words: ['police', 'police station', 'policia', 'comisaria'] },
  { id: 'post', one: 'post office', kinds: ['post_office'], words: ['post office', 'stamps', 'correos'] },
  { id: 'laundry', one: 'laundry', kinds: ['laundry', 'dry_cleaning'], words: ['laundry', 'laundrette', 'laundromat', 'launderette', 'washing machine', 'lavanderia'] },
  { id: 'hairdresser', one: 'hairdresser', kinds: ['hairdresser'], words: ['hairdresser', 'barber', 'haircut', 'peluqueria', 'barberia'] },
  { id: 'bookshop', one: 'bookshop', kinds: ['books'], words: ['bookshop', 'bookstore', 'books', 'libreria'] },
  { id: 'phone', one: 'phone shop', kinds: ['mobile_phone', 'telecommunication', 'electronics'], words: ['sim card', 'sim', 'phone shop', 'phone charger', 'charger', 'electronics', 'movil'] },
  { id: 'optician', one: 'optician', kinds: ['optician'], words: ['optician', 'glasses', 'optica'] },
  { id: 'souvenir', one: 'gift shop', kinds: ['gift', 'handicraft', 'pottery', 'art'], words: ['souvenir', 'souvenirs', 'gift shop', 'gifts', 'recuerdos'] },
  { id: 'mall', one: 'shopping centre', kinds: ['mall', 'department_store'], words: ['mall', 'shopping centre', 'shopping center', 'department store', 'centro comercial', 'el corte ingles'] },
  { id: 'bakery', one: 'bakery', kinds: ['bakery', 'pastry', 'confectionery'], words: ['bakery', 'bread', 'pastry shop', 'cake shop', 'panaderia', 'pasteleria', 'confiteria'] },
  { id: 'icecream', one: 'ice-cream shop', kinds: ['ice_cream'], words: ['ice cream', 'gelato', 'helado', 'helados', 'heladeria'] },
  { id: 'gym', one: 'gym', kinds: ['fitness_centre', 'sports_centre'], words: ['gym', 'fitness', 'gimnasio'] },
  { id: 'bike', one: 'bike rental', kinds: ['bicycle_rental', 'bicycle'], words: ['bike rental', 'rent a bike', 'bike hire', 'bicycle', 'bike', 'sevici', 'bici', 'bicicleta'] },
  { id: 'taxi', one: 'taxi rank', kinds: ['taxi'], words: ['taxi', 'taxi rank', 'cab', 'parada de taxi'] },
  { id: 'bus', one: 'bus stop', kinds: ['bus_stop', 'bus_station'], words: ['bus stop', 'bus', 'bus station', 'parada de autobus', 'autobus'] },
  { id: 'tram', one: 'tram stop', kinds: ['tram_stop'], words: ['tram', 'tram stop', 'tranvia', 'metrocentro'] },
  { id: 'metro', one: 'metro entrance', kinds: ['subway_entrance', 'station'], words: ['metro', 'subway', 'underground', 'train station', 'station', 'estacion'] },
  { id: 'parking', one: 'car park', kinds: ['parking'], words: ['parking', 'car park', 'parking lot', 'aparcamiento'] },
  { id: 'fuel', one: 'petrol station', kinds: ['fuel'], words: ['petrol station', 'gas station', 'fuel', 'gasolinera'] },
  { id: 'luggage', one: 'luggage storage', kinds: ['luggage_locker', 'left_luggage'], words: ['luggage storage', 'left luggage', 'luggage locker', 'store my bags', 'consigna'] },
  { id: 'hotel', one: 'hotel', kinds: ['hotel', 'hostel', 'guest_house', 'motel'], words: ['hotel', 'hostel', 'guest house', 'place to stay', 'hostal'] },
  { id: 'nightclub', one: 'nightclub', kinds: ['nightclub'], words: ['nightclub', 'club', 'disco', 'discoteca', 'dancing'] },
  { id: 'playground', one: 'playground', kinds: ['playground'], words: ['playground', 'parque infantil'] },
  // The guide curates these; here only for "the nearest …".
  { id: 'restaurant', one: 'restaurant', kinds: ['restaurant', 'seafood', 'fast_food'], words: ['restaurant', 'somewhere to eat', 'place to eat', 'food', 'restaurante'], guide: true },
  { id: 'cafe', one: 'café', kinds: ['cafe', 'coffee'], words: ['cafe', 'coffee', 'coffee shop', 'cafeteria'], guide: true },
  { id: 'bar', one: 'bar', kinds: ['bar', 'pub'], words: ['bar', 'pub', 'drink', 'beer', 'cerveza', 'tapas'], guide: true },
  { id: 'church', one: 'church', kinds: ['place_of_worship'], words: ['church', 'iglesia', 'mass', 'misa'], guide: true },
  { id: 'museum', one: 'museum', kinds: ['museum', 'gallery'], words: ['museum', 'gallery', 'museo'], guide: true },
  { id: 'park', one: 'park', kinds: ['park', 'garden'], words: ['park', 'garden', 'parque', 'jardin'], guide: true },
  { id: 'market', one: 'market', kinds: ['marketplace'], words: ['market', 'mercado'], guide: true },
];

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// "Find", "where is", "the nearest", "is there…", "I need…", in English and Spanish.
const LOCATOR = /\b(find|nearest|closest|near|nearby|around here|around me|close by|close to|where (is|are|can|do|would)|wheres|any|is there|are there|look(ing)? for|i need|need a|need an|need to|get some|buy|open now|still open|cerca|donde|hay|busco|necesito)\b/;
// Only these make a curated category ("restaurant", "museum") a nearby question.
const STRONG = /\b(nearest|closest|near me|nearby|around here|around me|close by|closest|mas cercano|mas cercana|cerca de aqui)\b/;
// Advice questions belong to the guide and the planner ("which museum should I see?").
const ADVICE = /\b(recommend|suggest|should|worth|best|good|favourite|favorite|must see|what to see|tell me about|history|why|recomienda)\b/;
const OPEN_NOW = /\b(open now|still open|open late|open right now|open at this hour|abierto|abierta|abiertos|24 ?h|24 hours|all night)\b/;

export interface NearbyQuery {
  category: NearbyCategory;
  /** Only places open now ("a pharmacy open now"). */
  openNow: boolean;
}

/** The category a "find X near me" question asks for, or undefined when it is not one. */
export function nearbyQuery(text: string): NearbyQuery | undefined {
  const t = fold(text);
  if (!t) return undefined;
  let best: { category: NearbyCategory; length: number } | undefined;
  for (const category of NEARBY_CATEGORIES) {
    for (const w of category.words) {
      if (best && w.length <= best.length) continue;
      if (new RegExp(`\\b${w.replace(/ /g, '\\s+')}(s|es)?\\b`).test(t)) best = { category, length: w.length };
    }
  }
  if (!best) return undefined;
  const words = t.split(' ').length;
  const strong = STRONG.test(t);
  if (best.category.guide && !strong) return undefined;
  if (ADVICE.test(t) && !strong) return undefined;
  if (!LOCATOR.test(t) && words > 4) return undefined;
  return { category: best.category, openNow: OPEN_NOW.test(t) };
}

export interface NearbyResult {
  place: NearbyPlace;
  meters: number;
  minutes: number;
  /** "north-west" */
  direction: string;
  /** From the place's opening hours; undefined when OpenStreetMap has none. */
  open?: OpenState;
}

const DIRECTIONS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

export class NearbyIndex {
  readonly places: NearbyPlace[];
  readonly bounds: [number, number, number, number];

  constructor(file: NearbyFile) {
    this.bounds = file.bounds;
    this.places = file.items.map(([name, kind, lat, lon, extra]) => ({ name, kind, point: { lat, lon }, ...(extra ?? {}) }));
  }

  /** True when `p` is on (or within about a kilometre of) the area the index covers. */
  covers(p: GeoPoint): boolean {
    const [w, s, e, n] = this.bounds;
    const pad = 0.01;
    return p.lat >= s - pad && p.lat <= n + pad && p.lon >= w - pad && p.lon <= e + pad;
  }

  /**
   * The nearest places of a category from `from`. Places known to be closed at `clock` go after
   * open ones (or are left out with openNow); places without hours count as open.
   */
  search(query: NearbyQuery, from: GeoPoint, clock?: Clock, limit = 3): NearbyResult[] {
    const kinds = new Set(query.category.kinds);
    const found = this.places
      .filter(p => kinds.has(p.kind))
      .map(place => {
        const meters = distanceMeters(from, place.point);
        const open = clock && place.hours ? openState(place.hours, clock) : undefined;
        return {
          place,
          meters,
          minutes: walkingMinutes(meters),
          direction: DIRECTIONS[Math.round(bearingDegrees(from, place.point) / 45) % 8],
          ...(open ? { open } : {}),
        };
      })
      .filter(r => !query.openNow || !r.open || r.open.open);
    const closed = (r: NearbyResult) => !!r.open && !r.open.open;
    // Prefer an open place unless the closed one is much nearer.
    found.sort((a, b) => a.meters + (closed(a) ? 800 : 0) - (b.meters + (closed(b) ? 800 : 0)));
    // One row per place: the map has a few places twice (a cinema as cinema and as arts centre).
    const seen = new Set<string>();
    return found
      .filter(r => {
        const key = r.place.name ? r.place.name.toLowerCase() : `${r.place.point.lat},${r.place.point.lon}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit);
  }
}

/** "Cines Avenida", or "a cash machine" for an unnamed one. */
export function nearbyName(r: NearbyResult, category: NearbyCategory): string {
  if (r.place.name) return r.place.name;
  return `a ${category.one}${r.place.fee ? ' (paid)' : ''}`;
}

function openWords(open: OpenState | undefined): string {
  if (!open) return '';
  if (open.open) return open.closesAt ? `, open until ${open.closesAt}` : ', open now';
  return open.opensAt ? `, closed now (opens at ${open.opensAt})` : ', closed now';
}

/**
 * Wilson's answer, in code: names, distances and hours come straight from the index, so nothing is
 * made up. Spoken as it is (or given to the model to say warmly, with these facts only).
 */
export function nearbyAnswer(query: NearbyQuery, results: NearbyResult[], opts: { city: string; covered: boolean }): string {
  const what = query.category.one;
  if (!opts.covered) return `My offline map of ${opts.city} only covers the city centre, and you seem to be outside it, so I can't say where the nearest ${what} is.`;
  if (!results.length) {
    return query.openNow
      ? `I can't find a ${what} that I know is open right now on my offline map of ${opts.city}.`
      : `I can't find a ${what} on my offline map of ${opts.city}.`;
  }
  const [first, ...rest] = results;
  const name = nearbyName(first, query.category);
  const lead = first.place.name ? `The nearest ${what} is ${name}` : `The nearest ${what} is`;
  const where = `${formatDistance(first.meters)} ${first.direction}, about ${first.minutes} min on foot`;
  let text = first.place.name ? `${lead}, ${where}${openWords(first.open)}.` : `${lead} ${where}${openWords(first.open)}.`;
  const named = rest.filter(r => r.place.name);
  if (named.length) text += ` Also close: ${named.map(r => `${r.place.name} (${formatDistance(r.meters)}${openWords(r.open)})`).join(' and ')}.`;
  if (query.openNow && !first.open) text += " I don't have its opening hours, so I can't promise it's open now.";
  if (query.category.id === 'cinema' || query.category.id === 'theatre') text += ' I have no showtimes offline, so check at the door.';
  return text;
}
