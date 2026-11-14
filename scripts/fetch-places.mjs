#!/usr/bin/env node
// Looks places up in OpenStreetMap (Overpass API) inside the destination's
// bounds and prints what the pack needs from them: name, Spanish name,
// coordinates and opening hours, converted to the pack's format. Run while
// online; review the output and hand-write tags, summary and visit length.
//
//   node scripts/fetch-places.mjs "Eslava" "Casa Morales" "Torre de los Perdigones"
//   node scripts/fetch-places.mjs --dest seville --file names.txt
//
// Hours OSM does not state, or that this converter cannot read, come out as
// null with the raw OSM value alongside: fill those in by hand.
// Data © OpenStreetMap contributors (ODbL).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const argv = process.argv.slice(2);
const opt = name => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv.splice(i, 2)[1] : undefined;
};
const destId = opt('dest') ?? 'seville';
const file = opt('file');
const compact = argv.includes('--compact');
if (compact) argv.splice(argv.indexOf('--compact'), 1);
const names = file ? readFileSync(file, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean) : argv;
if (!names.length) {
  console.error('Usage: node scripts/fetch-places.mjs [--dest seville] [--file names.txt] "Place name" ...');
  process.exit(1);
}
const dest = JSON.parse(readFileSync(join(app, `src/pack/${destId}/destination.json`), 'utf8'));
const [west, south, east, north] = dest.bounds;
const bbox = `${south},${west},${north},${east}`;

const escape = s => s.replace(/[\\"]/g, '\\$&').replace(/[.*+?^${}()|[\]]/g, '\\\\$&');
const query = `[out:json][timeout:60];
(
${names.map(n => `  nwr["name"~"${escape(n)}",i](${bbox});`).join('\n')}
);
out center tags;`;

// Overpass sheds load with 429/502/503/504 and asks for exponential backoff.
let res;
for (let attempt = 0, wait = 5; ; attempt++, wait *= 2) {
  res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': 'travel-buddy-pack-builder' },
    body: 'data=' + encodeURIComponent(query),
  });
  if (res.ok || ![429, 502, 503, 504].includes(res.status) || attempt === 4) break;
  console.error(`Overpass busy (${res.status}); retrying in ${wait} s…`);
  await new Promise(r => setTimeout(r, wait * 1000));
}
if (!res.ok) {
  console.error(`Overpass returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const { elements } = await res.json();

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

const slug = s =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// Transport stops, bike docks and the like share names with real places.
const NOISE = new Set(['bicycle_rental', 'bus_stop', 'platform', 'parking', 'taxi', 'atm', 'guest_house', 'hotel', 'hostel', 'apartment']);
const useful = e => {
  const t = e.tags ?? {};
  if (t.public_transport || t.highway || t.railway || t.route) return false;
  const kind = t.tourism ?? t.amenity ?? t.leisure ?? t.historic ?? t.shop ?? t.building ?? t.man_made ?? t.place;
  return !!kind && !NOISE.has(kind);
};

const found = elements.filter(useful).map(e => {
  const t = e.tags ?? {};
  const lat = e.lat ?? e.center?.lat;
  const lon = e.lon ?? e.center?.lon;
  return {
    id: slug(t['name:en'] ?? t.name),
    name: t['name:en'] ?? t.name,
    localName: t['name:es'] ?? (t['name:en'] ? t.name : undefined),
    point: { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 },
    hours: convertHours(t.opening_hours) ?? null,
    osm: {
      ref: `${e.type}/${e.id}`,
      opening_hours: t.opening_hours,
      kind: t.tourism ?? t.amenity ?? t.leisure ?? t.historic ?? t.shop ?? t.building ?? t.man_made ?? t.place,
      website: t.website,
    },
  };
});

for (const n of names) {
  const hits = found.filter(f => [f.name, f.localName].some(x => x && x.toLowerCase().includes(n.toLowerCase())));
  if (!hits.length) console.error(`not found: ${n}`);
}
console.log(compact ? found.map(f => JSON.stringify(f)).join('\n') : JSON.stringify(found, null, 1));
