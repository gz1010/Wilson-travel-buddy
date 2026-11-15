#!/usr/bin/env node
// Looks places up in OpenStreetMap inside the destination's bounds and prints what the pack needs
// from them, in the pack's format: names, coordinates and opening hours, plus a first guess from
// OSM's tags at category, interest tags, indoor, visit length and summary. Run while online.
//
//   node scripts/fetch-places.mjs "Eslava" "Casa Morales" "Torre de los Perdigones"
//   node scripts/fetch-places.mjs --dest seville --file names.txt
//   node scripts/fetch-places.mjs --match "Iglesia de San Marcos" "Giralda"
//
// By default it prints every useful element whose name (or name:en, the local-language name,
// alt_name or official_name) contains one of the names, ignoring accents and case: review them and
// copy what you want into places.json. With --match it picks the best element for each name and
// prints JSON on stdout, [{ name, place: <draft place> | null, via }], with progress on stderr:
// scripts/prepare-pack.mjs --itinerary uses that. A name Overpass does not find is tried on
// Nominatim's search, bounded to the destination (at most 15 names a run).
//
// Hours OSM does not state, or that this converter cannot read, come out as null with the raw OSM
// value alongside (osm.opening_hours): fill those in by hand.
//
// OpenStreetMap's usage policies: one Overpass query for all the names, retried with backoff when
// the server is busy; Nominatim one request at a time, at most one a second; both with a
// User-Agent that names this tool and nothing about who runs it.
// Data © OpenStreetMap contributors (ODbL).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fold, NON_NAME, slug, words } from './itinerary.mjs';

const app = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const argv = process.argv.slice(2);
const opt = name => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv.splice(i, 2)[1] : undefined;
};
const flag = name => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) argv.splice(i, 1);
  return i >= 0;
};
const destId = opt('dest') ?? 'seville';
const file = opt('file');
const compact = flag('compact');
const match = flag('match');
const names = (file ? readFileSync(file, 'utf8').split(/\r?\n/) : argv).map(s => s.trim()).filter(Boolean);
if (!names.length) {
  console.error('Usage: node scripts/fetch-places.mjs [--dest seville] [--match] [--compact] [--file names.txt] "Place name" ...');
  process.exit(1);
}
const dest = JSON.parse(readFileSync(join(app, `src/pack/${destId}/destination.json`), 'utf8'));
const [west, south, east, north] = dest.bounds;
const bbox = `${south},${west},${north},${east}`;
const localKey = `name:${dest.language ?? 'es'}`;
const NAME_KEYS = ['name', 'name:en', localKey, 'alt_name', 'official_name'];
const UA = 'travel-buddy-pack-builder/1.0 (offline travel guide pack builder)';
const log = (...a) => console.error(...a); // stderr: with --match, stdout is only the JSON
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Overpass: every element in the bounds whose name contains one of the names

const ACCENTS = { a: 'aáàâäAÁÀÂÄ', e: 'eéèêëEÉÈÊË', i: 'iíìîïIÍÌÎÏ', o: 'oóòôöOÓÒÔÖ', u: 'uúùûüUÚÙÛÜ', n: 'nñNÑ', c: 'cçCÇ' };
/** A POSIX regex for a name that ignores accents ("Alcazar" finds "Alcázar"), hyphens and apostrophes. */
function looseRegex(name) {
  let out = '';
  for (const ch of fold(name).replace(/\s+/g, ' ').trim()) {
    if (ACCENTS[ch]) out += `(${[...ACCENTS[ch]].join('|')})`;
    else if (ch === ' ' || ch === '-') out += '[- ]';
    else if (ch === "'" || ch === '’') out += "('|’)?";
    else if (/[.*+?^${}()|[\]\\]/.test(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return out;
}
const ql = s => s.replace(/[\\"]/g, '\\$&'); // inside an Overpass QL "string"
const query = `[out:json][timeout:60];
(
${names.map(n => `  nwr[~"^(${NAME_KEYS.join('|')})$"~"${ql(looseRegex(n))}",i](${bbox});`).join('\n')}
);
out center tags;`;

async function overpass() {
  // Overpass sheds load with 429/502/503/504 and asks for exponential backoff.
  for (let attempt = 0, wait = 5; ; attempt++, wait *= 2) {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': UA },
      body: 'data=' + encodeURIComponent(query),
    });
    if (res.ok) return (await res.json()).elements ?? [];
    if (![429, 502, 503, 504].includes(res.status) || attempt === 4) throw new Error(`Overpass returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    log(`Overpass busy (${res.status}); retrying in ${wait} s…`);
    await sleep(wait * 1000);
  }
}

// ---------------------------------------------------------------------------
// Nominatim: a fallback for names Overpass does not find (other word order, a missing word)

let lastNominatim = 0;
async function nominatim(q) {
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
  const url =
    'https://nominatim.openstreetmap.org/search?' +
    new URLSearchParams({ q, format: 'jsonv2', viewbox: `${west},${north},${east},${south}`, bounded: '1', limit: '5', extratags: '1', namedetails: '1' });
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);
  return (await res.json()).map(r => ({
    type: r.osm_type,
    id: r.osm_id,
    lat: Number(r.lat),
    lon: Number(r.lon),
    tags: { ...(r.extratags ?? {}), ...(r.namedetails ?? {}), ...(r.category && r.type ? { [r.category]: r.type } : {}) },
  }));
}

// ---------------------------------------------------------------------------
// OSM opening_hours → pack hours, for the common simple forms:
// "Mo-Fr 09:00-17:00; Sa 10:00-14:00; Su off", "Mo-Su 10:00-14:00,17:00-20:00", "24/7".

const OSM_DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const PACK_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function expandDays(spec) {
  const out = new Set();
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-');
    const i = OSM_DAYS.indexOf(a);
    const j = b ? OSM_DAYS.indexOf(b) : i;
    if (i < 0 || j < 0) return undefined;
    for (let k = i; ; k = (k + 1) % 7) {
      out.add(k);
      if (k === j) break;
    }
  }
  return [...out];
}

export function convertHours(osm) {
  if (!osm) return undefined;
  const s = osm.trim();
  if (s === '24/7') return { daily: '24h' };
  const hours = {};
  for (const rule of s.split(';').map(r => r.trim()).filter(Boolean)) {
    const m = /^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:,(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)?\s*(.*)$/.exec(rule);
    if (!m) return undefined;
    const days = m[1] ? expandDays(m[1]) : [0, 1, 2, 3, 4, 5, 6];
    const times = m[2].trim().replace(/\s*,\s*/g, ',');
    if (!days) return undefined;
    let value;
    if (times === 'off' || times === 'closed') value = 'closed';
    else if (/^\d{2}:\d{2}-\d{2}:\d{2}(,\d{2}:\d{2}-\d{2}:\d{2})*$/.test(times)) value = times.replace(/24:00/g, '00:00');
    else return undefined; // PH, months, "sunset", comments…: do it by hand
    for (const d of days) hours[PACK_DAYS[d]] = value;
  }
  // In OSM a day no rule mentions is closed; in the pack a missing day means
  // "unknown" and is treated as open, so spell the closed days out.
  for (const d of PACK_DAYS) hours[d] ??= 'closed';
  const values = PACK_DAYS.map(d => hours[d]);
  if (values.every(v => v && v === values[0])) return { daily: values[0] };
  return hours;
}

// ---------------------------------------------------------------------------
// OSM tags → a draft pack place

// Transport stops, bike docks and the like share names with real places, and so do the pharmacy,
// school or hairdresser named after the church on their street ("Farmacia Santa Paula"): with
// --match, one of those could otherwise be picked as the place.
const NOISE = new Set([
  ...['bicycle_rental', 'bus_stop', 'platform', 'parking', 'taxi', 'atm', 'guest_house', 'hotel', 'hostel', 'apartment', 'house'],
  ...['pharmacy', 'bank', 'bureau_de_change', 'school', 'kindergarten', 'dentist', 'doctors', 'clinic', 'veterinary', 'post_office', 'police'],
  ...['fuel', 'car_wash', 'car_rental', 'charging_station', 'parking_entrance', 'parking_space', 'bicycle_parking', 'motorcycle_parking'],
  ...['toilets', 'bench', 'waste_basket', 'recycling', 'vending_machine', 'post_box', 'telephone', 'drinking_water'],
  ...['supermarket', 'convenience', 'hairdresser', 'beauty', 'optician', 'mobile_phone', 'laundry', 'dry_cleaning', 'estate_agent', 'car_repair'],
  ...['apartments', 'residential', 'office', 'commercial', 'garage', 'garages'],
]);
const kindOf = t => t.tourism ?? t.amenity ?? t.leisure ?? t.historic ?? t.shop ?? t.building ?? t.man_made ?? t.place;
const useful = e => {
  const t = e.tags ?? {};
  if (t.public_transport || t.highway || t.railway || t.route) return false;
  const kind = kindOf(t);
  return !!kind && !NOISE.has(kind) && !!t.name;
};
const pointOf = e => ({ lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon });
// Strictly inside: a long way's centre can fall outside the bounds it crosses.
const inBounds = e => {
  const p = pointOf(e);
  return p.lat > south && p.lat < north && p.lon > west && p.lon < east;
};
const namesOf = t => NAME_KEYS.flatMap(k => (t[k] ?? '').split(';')).map(s => s.trim()).filter(Boolean);

function categoryOf(t) {
  const name = fold([t.name, t['name:en']].filter(Boolean).join(' '));
  const cuisine = fold(t.cuisine ?? '');
  if (['museum', 'gallery'].includes(t.tourism) || t.amenity === 'arts_centre') return 'museum';
  if (/flamenco/.test(fold(t['theatre:genre'] ?? '')) || (/\b(tablao|flamenco)\b/.test(name) && ['bar', 'pub', 'restaurant', 'theatre', 'nightclub', 'cafe'].includes(t.amenity))) return 'flamenco';
  if (
    ['place_of_worship', 'monastery'].includes(t.amenity) ||
    ['church', 'cathedral', 'chapel', 'basilica', 'convent', 'monastery'].includes(t.building) ||
    ['church', 'chapel', 'monastery', 'convent'].includes(t.historic)
  )
    return 'church';
  if (t.amenity === 'marketplace' || t.shop === 'marketplace') return 'market';
  const tapas = /tapas/.test(cuisine) || /\b(bodega|bodeguita|taberna|tasca|cerveceria|tapas)\b/.test(name);
  if (['bar', 'pub', 'biergarten'].includes(t.amenity)) return tapas || /spanish|regional/.test(cuisine) ? 'tapas-bar' : 'bar';
  if (t.amenity === 'restaurant') return tapas ? 'tapas-bar' : 'restaurant';
  if (['cafe', 'ice_cream'].includes(t.amenity) || ['pastry', 'confectionery', 'bakery', 'ice_cream', 'coffee', 'chocolate'].includes(t.shop)) return 'cafe';
  if (t.tourism === 'viewpoint') return 'viewpoint';
  if (['park', 'garden', 'nature_reserve'].includes(t.leisure)) return 'park';
  if (['neighbourhood', 'quarter', 'suburb'].includes(t.place)) return 'neighborhood';
  if (t.shop) return 'shop';
  if (['hotel', 'hostel', 'guest_house', 'apartment', 'motel'].includes(t.tourism)) return 'hotel';
  return 'landmark';
}

const BASE_TAGS = {
  museum: ['museums', 'history'],
  church: ['religion', 'architecture', 'history'],
  landmark: ['architecture', 'history'],
  park: ['nature', 'quiet'],
  viewpoint: ['views'],
  market: ['markets', 'food', 'local-life'],
  restaurant: ['food', 'local-life'],
  'tapas-bar': ['food', 'tapas', 'local-life'],
  bar: ['nightlife', 'local-life'],
  cafe: ['food', 'local-life'],
  flamenco: ['flamenco', 'music', 'nightlife'],
  shop: ['shopping', 'local-life'],
  neighborhood: ['local-life', 'architecture'],
  hotel: ['quiet'],
};
function interestsOf(category, t) {
  const tags = new Set(BASE_TAGS[category]);
  const name = fold([t.name, t['name:en']].filter(Boolean).join(' '));
  if (category === 'museum' && (t.tourism === 'gallery' || /art/.test(t.museum ?? '') || /\b(arte|artes|art|arts|bellas|pintura|painting)\b/.test(name))) tags.add('art');
  if (t.historic && category !== 'park') tags.add('history');
  if (t.tourism === 'viewpoint' || t['tower:type'] === 'observation') tags.add('views');
  if (['science', 'children'].includes(t.museum)) tags.add('family');
  if (['concert_hall', 'theatre'].includes(t.amenity)) tags.add('music');
  return [...tags];
}

function indoorOf(category, t) {
  if (['park', 'viewpoint', 'neighborhood'].includes(category)) return false;
  if (category === 'landmark') return (!!t.building && !['no', 'roof'].includes(t.building)) || ['townhall', 'theatre', 'library', 'courthouse'].includes(t.amenity);
  return true;
}

const VISIT_MINUTES = { museum: 60, church: 30, landmark: 30, park: 30, viewpoint: 30, market: 45, restaurant: 75, 'tapas-bar': 45, bar: 45, cafe: 30, flamenco: 75, shop: 20, neighborhood: 60, hotel: 15 };

const LABELS = { townhall: 'town hall', arts_centre: 'arts centre', marketplace: 'market', attraction: 'sight', yes: '', building: 'historic building', ice_cream: 'ice cream shop' };
/** OSM's own description, else a plain line from its tags ("Church in Seville, on Calle San Luis."). The facts step replaces it. */
function summaryOf(category, t) {
  const desc = (t['description:en'] ?? t.description ?? '').trim();
  if (desc.length >= 20 && desc.length <= 240) return /[.!?]$/.test(desc) ? desc : `${desc}.`;
  let label;
  if (t.amenity === 'place_of_worship') label = ['cathedral', 'chapel', 'basilica', 'convent', 'monastery'].includes(t.building) ? t.building : t.religion && t.religion !== 'christian' ? 'place of worship' : 'church';
  else {
    const kind = (t.amenity && t.amenity !== 'yes' ? t.amenity : undefined) ?? t.historic ?? kindOf(t);
    label = LABELS[kind] ?? (kind ?? '').replace(/_/g, ' ');
  }
  label ||= category.replace('-', ' ');
  const cuisine = t.cuisine ? ` (${t.cuisine.replace(/_/g, ' ').replace(/;/g, ', ')})` : '';
  const street = t['addr:street'] ? `, on ${t['addr:street']}` : '';
  return `${label[0].toUpperCase()}${label.slice(1)}${cuisine} in ${dest.name}${street}.`;
}

function draft(e) {
  const t = e.tags ?? {};
  const p = pointOf(e);
  const name = t['name:en'] ?? t.name;
  const local = t[localKey] ?? (t['name:en'] ? t.name : undefined);
  const category = categoryOf(t);
  return {
    id: slug(name),
    name,
    localName: local && words(local).join(' ') !== words(name).join(' ') ? local : undefined,
    category,
    point: { lat: Math.round(p.lat * 1e5) / 1e5, lon: Math.round(p.lon * 1e5) / 1e5 },
    tags: interestsOf(category, t),
    indoor: indoorOf(category, t),
    visitMinutes: VISIT_MINUTES[category],
    hours: convertHours(t.opening_hours) ?? null,
    price: t.fee === 'no' ? 0 : undefined,
    summary: summaryOf(category, t),
    osm: {
      ref: `${e.type}/${e.id}`,
      kind: kindOf(t),
      opening_hours: t.opening_hours,
      website: t.website ?? t['contact:website'],
      wikipedia: t.wikipedia,
      wikidata: t.wikidata,
    },
  };
}

/**
 * How well an element's names fit a looked-up name: 3 the same, about 2 when the name is a phrase
 * of the element's ("Giralda" in "La Giralda"), about 1.5 the other way round ("Eslava" in
 * "Restaurante Eslava"), 1 when it has every distinctive word, else 0. A Wikipedia link and being
 * a sight break ties.
 */
function score(name, e) {
  const q = words(name).join(' ');
  const distinctive = words(name).filter(w => w.length >= 3 && !NON_NAME.has(w));
  let best = 0;
  for (const n of namesOf(e.tags ?? {})) {
    const nw = words(n);
    const f = nw.join(' ');
    if (!f) continue;
    let s = 0;
    if (f === q) s = 3;
    else if (` ${f} `.includes(` ${q} `)) s = 2 + (0.5 * q.length) / f.length;
    else if (` ${q} `.includes(` ${f} `) && nw.some(w => w.length >= 3 && !NON_NAME.has(w))) s = 1.5 + (0.5 * f.length) / q.length;
    else if (distinctive.length && distinctive.every(w => nw.includes(w))) s = 1;
    best = Math.max(best, s);
  }
  if (!best) return 0;
  const t = e.tags;
  return best + (t.wikipedia || t.wikidata ? 0.3 : 0) + (t.tourism || t.historic || t.amenity === 'place_of_worship' ? 0.1 : 0);
}

const bestFor = (name, elements) =>
  elements
    .filter(e => useful(e) && inBounds(e))
    .map(e => ({ e, s: score(name, e) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)[0]?.e;

// ---------------------------------------------------------------------------

if (match) {
  let elements = [];
  let overpassOk = false;
  try {
    elements = await overpass();
    overpassOk = true;
  } catch (e) {
    log(`Overpass failed (${e.cause?.code ?? e.message}); trying Nominatim for each name instead.`);
  }
  let nominatimLeft = 15;
  let nominatimFailures = 0;
  let reached = overpassOk;
  const results = [];
  for (const name of names) {
    let best = bestFor(name, elements);
    let via = 'overpass';
    let searched = overpassOk;
    if (!best && nominatimLeft > 0) {
      nominatimLeft--;
      try {
        best = bestFor(name, await nominatim(name));
        via = 'nominatim';
        searched = reached = true;
      } catch (e) {
        log(`  Nominatim: ${e.cause?.code ?? e.message}`);
        if (++nominatimFailures >= 2) nominatimLeft = 0; // offline or refused: stop asking
      }
    }
    if (best) {
      results.push({ name, place: draft(best), via });
      log(`  found ${name}: ${best.tags.name} (${best.type}/${best.id}, ${via})`);
    } else {
      // unsure: nothing could be asked about it, so "not found" would be wrong
      results.push({ name, place: null, ...(searched ? {} : { unsure: true }) });
      log(`  ${searched ? 'not found' : 'not looked up'}: ${name}`);
    }
  }
  if (!reached) {
    log('Cannot reach OpenStreetMap (Overpass or Nominatim). Run this again while online.');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(results, null, 1) + '\n');
} else {
  let elements;
  try {
    elements = await overpass();
  } catch (e) {
    log(e.cause?.code ?? e.message);
    process.exit(1);
  }
  const kept = elements.filter(e => useful(e) && inBounds(e));
  for (const n of names) {
    const q = words(n).join(' ');
    if (!kept.some(e => namesOf(e.tags).some(x => words(x).join(' ').includes(q)))) log(`not found: ${n}`);
  }
  const found = kept.map(draft);
  console.log(compact ? found.map(f => JSON.stringify(f)).join('\n') : JSON.stringify(found, null, 1));
}
