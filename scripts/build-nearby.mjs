#!/usr/bin/env node
// Builds the "nearby" index Wilson searches when someone asks for a cinema, a pharmacy, a cash
// machine or a supermarket: everything the city's offline map knows, not only the guide's places.
//
//   node scripts/build-nearby.mjs                 # Seville, with opening hours from OpenStreetMap
//   node scripts/build-nearby.mjs --no-osm        # offline: only what the map tiles hold
//   node scripts/build-nearby.mjs --dest seville --cache /tmp/osm
//
// It reads the map tiles scripts/build-tiles.mjs made (app/src/map/generated/tiles.js), keeps
// every named point of interest inside the destination's bounds (plus unnamed cash machines,
// toilets and drinking water), and writes app/src/pack/<dest>/nearby.json. Unless --no-osm, one
// Overpass query then adds opening hours (converted like fetch-places.mjs does) and cuisine to the
// places it can match by name and position, and adds the toilets and cash machines the tiles leave
// out. Run while online; the app only reads the result and never goes online.
//
// OpenStreetMap's usage policy: one Overpass query, retried with backoff when the server is busy,
// with a User-Agent that names this tool and nothing about who runs it.
// Data © OpenStreetMap contributors (ODbL), map tiles via Protomaps.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertHours } from './osmHours.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'app', 'package.json'));
const { VectorTile } = require('@mapbox/vector-tile');
const PbfModule = require('pbf');
const Pbf = PbfModule.default ?? PbfModule;

const argv = process.argv.slice(2);
const opt = name => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const destId = opt('dest') ?? 'seville';
const useOsm = !argv.includes('--no-osm');
const cacheDir = opt('cache');
const packDir = join(root, 'app/src/pack', destId);
const tilesPath = join(root, 'app/src/map/generated/tiles.js');
const outPath = join(packDir, 'nearby.json');
const UA = 'travel-buddy-pack-builder/1.0 (offline travel guide pack builder)';
const log = (...a) => console.error(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!existsSync(tilesPath)) {
  log('No map tiles yet: run node scripts/build-tiles.mjs first (the index is made from them).');
  process.exit(1);
}
const dest = JSON.parse(readFileSync(join(packDir, 'destination.json'), 'utf8'));
const places = JSON.parse(readFileSync(join(packDir, 'places.json'), 'utf8'));
const [west, south, east, north] = dest.bounds;
const inBounds = (lat, lon) => lat >= south && lat <= north && lon >= west && lon <= east;

// Kinds that are not places anyone goes to (or that only make noise in answers).
const SKIP = new Set(
  `pedestrian footway living_street residential administrative apartment building buiding yes industrial commercial
   construction vacant other tree tree_stump grass scrub farmyard greenfield allotments crossing traffic_signals
   bench waste_basket waste_disposal platform platform_exit service primary secondary tertiary yard low_emission_zone
   bleachers depot military window_construction builder plumber electrician hvac carpenter metal_construction rigger
   parquet_layer carpet_layer glaziery upholsterer stonemason storage_rental post_depot trade kindergarten childcare
   prep_school school driving_school dormitory nursing_home social_facility company office parking_entrance stop
   halt heliport water recycling vending_machine telephone`.split(/\s+/),
);
// Kept even without a name: what a traveller looks for, not by name.
const UNNAMED_OK = new Set(['atm', 'toilets', 'drinking_water', 'bureau_de_change', 'luggage_locker', 'left_luggage', 'taxi']);

const fold = s =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const metres = (a, b) => {
  const r = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
};
const round = x => Math.round(x * 1e5) / 1e5;

// ---------------------------------------------------------------------------
// 1. Points of interest from the offline map tiles

const { tiles, maxzoom } = require(tilesPath);
const items = [];
const byKey = new Map(); // folded name + kind → items, to merge the same place seen in two tiles
let read = 0;
for (const [key, b64] of Object.entries(tiles)) {
  const [z, x, y] = key.split('/').map(Number);
  if (z !== maxzoom) continue;
  const layer = new VectorTile(new Pbf(Buffer.from(b64, 'base64'))).layers.pois;
  if (!layer) continue;
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    const p = f.properties;
    read++;
    const kind = String(p.kind ?? '');
    if (!kind || SKIP.has(kind)) continue;
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (!name && !UNNAMED_OK.has(kind)) continue;
    const g = f.toGeoJSON(x, y, z).geometry;
    if (g.type !== 'Point') continue;
    const [lon, lat] = g.coordinates;
    if (!inBounds(lat, lon)) continue;
    const point = { lat: round(lat), lon: round(lon) };
    const k = `${fold(name)}|${kind}`;
    const same = (byKey.get(k) ?? []).find(o => metres(o.point, point) < 60);
    if (same) continue;
    const item = { name, kind, point };
    if (typeof p['name:en'] === 'string' && fold(p['name:en']) !== fold(name)) item.nameEn = p['name:en'];
    items.push(item);
    byKey.set(k, [...(byKey.get(k) ?? []), item]);
  }
}
log(`Map tiles: ${read} points read, ${items.length} kept (${new Set(items.map(i => i.kind)).size} kinds).`);

// ---------------------------------------------------------------------------
// 2. Opening hours and cuisine from OpenStreetMap (online)

async function overpass() {
  const query = `[out:json][timeout:120];
(
  nwr["name"]["opening_hours"](${south},${west},${north},${east});
  nwr["name"]["cuisine"](${south},${west},${north},${east});
  nwr["amenity"~"^(toilets|atm|drinking_water|bureau_de_change)$"](${south},${west},${north},${east});
);
out center tags;`;
  const cached = cacheDir ? join(cacheDir, `nearby-${destId}.json`) : undefined;
  if (cached && existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
  for (let attempt = 0, wait = 5; ; attempt++, wait *= 2) {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': UA },
      body: 'data=' + encodeURIComponent(query),
    });
    if (res.ok) {
      const elements = (await res.json()).elements ?? [];
      if (cached) {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(cached, JSON.stringify(elements));
      }
      return elements;
    }
    if (![429, 502, 503, 504].includes(res.status) || attempt === 4) throw new Error(`Overpass returned ${res.status}`);
    log(`Overpass busy (${res.status}); retrying in ${wait} s…`);
    await sleep(wait * 1000);
  }
}

let osmNote = 'no OpenStreetMap pass (--no-osm)';
if (useOsm) {
  try {
    const elements = await overpass();
    let hours = 0;
    let cuisine = 0;
    let added = 0;
    for (const e of elements) {
      const t = e.tags ?? {};
      const lat = e.lat ?? e.center?.lat;
      const lon = e.lon ?? e.center?.lon;
      if (lat === undefined || lon === undefined || !inBounds(lat, lon)) continue;
      const point = { lat: round(lat), lon: round(lon) };
      const name = fold(t.name);
      let item = name ? items.find(i => fold(i.name) === name && metres(i.point, point) < 80) : undefined;
      const utility = ['toilets', 'atm', 'drinking_water', 'bureau_de_change'].find(a => t.amenity === a);
      if (!item && utility) {
        // The tiles leave most toilets and cash machines out: add them (one per 25 m).
        if (items.some(i => i.kind === utility && metres(i.point, point) < 25)) continue;
        item = { name: (t.name ?? (utility === 'atm' && t.operator ? `${t.operator} cash machine` : '')).trim(), kind: utility, point };
        items.push(item);
        added++;
      }
      if (!item) continue;
      const h = convertHours(t.opening_hours);
      if (h && !item.hours) {
        item.hours = h;
        hours++;
      }
      if (t.cuisine && !item.cuisine) {
        item.cuisine = t.cuisine.split(';').slice(0, 3).join(';');
        cuisine++;
      }
      if (t.fee === 'yes' && utility === 'toilets') item.fee = true;
    }
    osmNote = `OpenStreetMap: ${elements.length} elements, opening hours for ${hours} places, cuisine for ${cuisine}, ${added} toilets/cash machines added`;
  } catch (e) {
    osmNote = `OpenStreetMap not reached (${e.cause?.code ?? e.message}): no opening hours added`;
    process.exitCode = 1;
  }
}
log(osmNote);

// ---------------------------------------------------------------------------
// 3. Link to the guide's own places, so Wilson can open their page

// Only when the map's kind fits the guide's category: "Plaza Nueva" the bar, bike dock or tram stop
// is not the square, and "El Salvador" the café is not the church.
const SIGHT = ['attraction', 'monument', 'memorial', 'artwork', 'fountain', 'viewpoint', 'castle', 'ruins', 'city_gate', 'tower', 'gallery', 'arts_centre', 'museum', 'heritage', 'heritage_building', 'manor', 'place_of_worship', 'monastery', 'theatre', 'marketplace', 'park', 'garden'];
const FITS = {
  museum: ['museum', 'gallery', 'arts_centre', 'attraction', 'castle', 'tower', 'viewpoint', 'heritage', 'heritage_building', 'manor', 'monastery'],
  landmark: SIGHT,
  church: ['place_of_worship', 'monastery', 'attraction', 'heritage', 'heritage_building'],
  'tapas-bar': ['bar', 'pub', 'restaurant', 'cafe'],
  bar: ['bar', 'pub', 'nightclub', 'restaurant', 'cafe'],
  restaurant: ['restaurant', 'bar', 'fast_food', 'seafood'],
  cafe: ['cafe', 'ice_cream', 'pastry', 'confectionery', 'bakery', 'coffee'],
  park: ['park', 'garden', 'attraction', 'viewpoint'],
  neighborhood: ['attraction', 'marketplace'],
  flamenco: ['theatre', 'arts_centre', 'dance', 'events_venue', 'attraction', 'museum', 'bar', 'nightclub'],
  market: ['marketplace', 'attraction', 'mall'],
  viewpoint: ['viewpoint', 'attraction', 'tower', 'park'],
};
for (const pl of places) {
  const names = [pl.name, pl.localName].filter(Boolean).map(fold);
  const kinds = new Set(FITS[pl.category] ?? SIGHT);
  for (const it of items) {
    if (!it.name || it.placeId || !kinds.has(it.kind)) continue;
    const n = fold(it.name);
    if (names.some(x => x === n || (x.length > 8 && n.includes(x)) || (n.length > 8 && x.includes(n))) && metres(it.point, pl.point) < 150) it.placeId = pl.id;
  }
}

// ---------------------------------------------------------------------------

items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
const out = {
  source: 'OpenStreetMap contributors (ODbL), via Protomaps map tiles and Overpass',
  builtAt: new Date().toISOString().slice(0, 10),
  bounds: dest.bounds,
  // Compact rows: [name, kind, lat, lon, extras?]; extras holds hours, cuisine, nameEn, placeId, fee.
  items: items.map(i => {
    const extra = {};
    for (const k of ['hours', 'cuisine', 'nameEn', 'placeId', 'fee']) if (i[k] !== undefined) extra[k] = i[k];
    return Object.keys(extra).length ? [i.name, i.kind, i.point.lat, i.point.lon, extra] : [i.name, i.kind, i.point.lat, i.point.lon];
  }),
};
const json = JSON.stringify(out).replace(/\],\[/g, '],\n[');
writeFileSync(outPath, json + '\n');
const counts = ['cinema', 'theatre', 'pharmacy', 'supermarket', 'atm', 'toilets', 'hospital', 'restaurant', 'cafe'].map(k => `${k} ${items.filter(i => i.kind === k).length}`);
console.log(`Wrote app/src/pack/${destId}/nearby.json: ${items.length} places, ${(json.length / 1024).toFixed(0)} KB (${counts.join(', ')}).`);
