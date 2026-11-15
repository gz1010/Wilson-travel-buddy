#!/usr/bin/env node
// Downloads one photo per place and four time-of-day city photos into the pack, from Wikimedia
// Commons, keeping only reusable licences. Run once per city while online:
//
//   node scripts/build-photos.mjs                 # Seville
//   node scripts/build-photos.mjs --dest seville --width 1200 --hero-width 1600
//   node scripts/build-photos.mjs --only catedral,alcazar   # redo some places
//   node scripts/build-photos.mjs --only torre-oro --heroes # redo some places, then the city photos
//
// For each place it uses the main image of its Wikipedia article (Spanish, then English),
// otherwise the best Commons search hit. To replace a bad pick, put the Commons file name in
// app/src/pack/<dest>/photos/overrides.json, e.g. { "catedral": "File:Catedral de Sevilla.jpg" },
// and run again with --only catedral; null instead of a name means no photo (the drawn scene
// tile), for places where every search hit is wrong. The four city photos (heroes) reuse
// landmark place photos at a larger size (HERO_PLACES below), and "heroes" in overrides.json
// replaces one. A time of day with no landmark photo keeps its drawn sky: Commons searches for
// generic city views returned paintings and murals.
//
// Writes: photos/<id>.jpg, a `photo` record on each place in places.json, `heroes` in
// destination.json, and photos/index.ts (the static require() list the app bundles).
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const destId = args.dest ?? 'seville';
const WIDTH = Number(args.width ?? 1200);
const HERO_WIDTH = Number(args['hero-width'] ?? 1600);
const only = args.only ? new Set(args.only.split(',')) : undefined;
const packDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'app/src/pack', destId);
const photoDir = join(packDir, 'photos');
const places = JSON.parse(readFileSync(join(packDir, 'places.json'), 'utf8'));
const dest = JSON.parse(readFileSync(join(packDir, 'destination.json'), 'utf8'));
const overridesPath = join(photoDir, 'overrides.json');
const overrides = existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, 'utf8')) : {};
const city = dest.name;
const localCity = { Seville: 'Sevilla' }[city] ?? city;

// Wikimedia asks automated clients to identify themselves; this names the tool, not a person.
const HEADERS = { 'User-Agent': 'TravelBuddyPackBuilder/1.0 (offline travel app; pack build script)' };
const ALLOWED = /^(cc0|public domain|pd|cc by(-sa)? \d)/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Wikimedia rate-limits anonymous clients (429): back off, honouring Retry-After, rather than
// treating a refused request as "no photo".
async function getWithBackoff(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: HEADERS });
    if (res.ok) return res;
    if (res.status === 404) throw new Error('404');
    const wait = Number(res.headers.get('retry-after')) * 1000 || 4000 * 2 ** attempt;
    await sleep(Math.min(wait, 60000));
  }
  throw new Error(`${new URL(url).host} kept refusing (rate limit)`);
}

async function api(host, params) {
  const url = `https://${host}/w/api.php?` + new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params });
  await sleep(500);
  return (await getWithBackoff(url)).json();
}

const strip = s => (s ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

/** Licence, author and a WIDTH-px thumbnail for a Commons file, or undefined if not reusable. */
async function fileInfo(title, width = WIDTH) {
  const j = await api('commons.wikimedia.org', {
    action: 'query', titles: title, prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: String(width),
  });
  const page = j.query?.pages?.[0];
  const ii = page?.imageinfo?.[0];
  if (!ii || !/jpeg|png/.test(ii.mime)) return undefined;
  const meta = ii.extmetadata ?? {};
  const license = strip(meta.LicenseShortName?.value);
  if (!ALLOWED.test(license)) return undefined;
  return {
    title: page.title,
    thumb: ii.thumburl ?? ii.url,
    license,
    credit: strip(meta.Artist?.value) || 'Unknown author',
    source: ii.descriptionurl,
  };
}

/** The main image of a Wikipedia article found by search. */
async function wikipediaImage(lang, query) {
  const j = await api(`${lang}.wikipedia.org`, {
    action: 'query', generator: 'search', gsrsearch: query, gsrlimit: '1', prop: 'pageimages', piprop: 'name',
  });
  const name = j.query?.pages?.[0]?.pageimage;
  return name ? `File:${name}` : undefined;
}

/** Commons search: file pages only, photos first. */
async function commonsSearch(query) {
  const j = await api('commons.wikimedia.org', {
    action: 'query', list: 'search', srsearch: `${query} filetype:bitmap`, srnamespace: '6', srlimit: '5',
  });
  return (j.query?.search ?? []).map(r => r.title);
}

async function pick(candidates, width = WIDTH) {
  for (const title of candidates) {
    if (!title) continue;
    const info = await fileInfo(title, width).catch(() => undefined);
    if (info) return info;
  }
  return undefined;
}

async function download(info, file) {
  const res = await getWithBackoff(info.thumb);
  writeFileSync(join(photoDir, file), Buffer.from(await res.arrayBuffer()));
  return { file, credit: info.credit, license: info.license, source: info.source };
}

async function placePhoto(place) {
  if (place.id in overrides) return overrides[place.id] ? pick([overrides[place.id]]) : undefined;
  const name = place.localName ?? place.name;
  const candidates = [
    await wikipediaImage('es', `${name} ${localCity}`).catch(() => undefined),
    await wikipediaImage('en', `${place.name} ${city}`).catch(() => undefined),
    ...(await commonsSearch(`${name} ${localCity}`).catch(() => [])),
  ];
  return pick(candidates);
}

// City photos by time of day: a landmark that reads well at that hour. The first place with a
// photo wins; with none, that time of day keeps its drawn sky.
const HERO_PLACES = {
  midday: ['plaza-espana', 'alcazar', 'parque-maria-luisa'],
  afternoon: ['catedral', 'archivo-indias', 'plaza-nueva'],
  dusk: ['torre-oro', 'puente-triana', 'calle-betis'],
  night: ['setas', 'puente-triana', 'alfalfa'],
};

/** The Commons file title a place photo came from, from its record's description URL. */
function commonsTitle(photo) {
  const m = /\/wiki\/(File:.+)$/.exec(photo?.source ?? '');
  return m ? decodeURIComponent(m[1]).replace(/_/g, ' ') : undefined;
}

let found = 0;
for (const place of places) {
  if (only && !only.has(place.id)) continue;
  try {
    const info = await placePhoto(place);
    if (!info) {
      if (place.photo?.file && existsSync(join(photoDir, place.photo.file))) unlinkSync(join(photoDir, place.photo.file));
      delete place.photo;
      console.log(`  -     ${place.id}: no reusable photo (scene tile instead)`);
      continue;
    }
    place.photo = await download(info, `${place.id}.jpg`);
    found++;
    console.log(`  ok    ${place.id}: ${info.title} (${info.license}, ${info.credit})`);
  } catch (e) {
    console.log(`  error ${place.id}: ${e.message}`);
  }
  await sleep(1000);
}

if (!only || 'heroes' in args) {
  dest.heroes = dest.heroes ?? {};
  for (const tod of Object.keys(HERO_PLACES)) {
    const chosen = overrides.heroes?.[tod];
    const fromPlaces = HERO_PLACES[tod].map(id => commonsTitle(places.find(p => p.id === id)?.photo));
    const info = await pick(chosen ? [chosen] : fromPlaces, HERO_WIDTH);
    if (info) {
      dest.heroes[tod] = await download(info, `hero-${tod}.jpg`);
      console.log(`  ok    hero ${tod}: ${info.title} (${info.license})`);
    } else {
      // No landmark photo: the drawn sky, never a random search hit.
      if (dest.heroes[tod] && existsSync(join(photoDir, dest.heroes[tod].file))) unlinkSync(join(photoDir, dest.heroes[tod].file));
      delete dest.heroes[tod];
      console.log(`  -     hero ${tod}: no landmark photo; set heroes.${tod} in overrides.json`);
    }
    await sleep(1000);
  }
}

writeFileSync(join(packDir, 'places.json'), JSON.stringify(places, null, 1));
writeFileSync(join(packDir, 'destination.json'), JSON.stringify(dest, null, 1));

// React Native bundles images only through static require(), so list them in code.
const placeLines = places.filter(p => p.photo).map(p => `  ${JSON.stringify(p.id)}: require('./${p.photo.file}'),`);
const heroLines = Object.entries(dest.heroes ?? {}).map(([tod, h]) => `  ${tod}: require('./${h.file}'),`);
writeFileSync(
  join(photoDir, 'index.ts'),
  `// Generated by scripts/build-photos.mjs. Do not edit; run the script again instead.\n` +
    `import type { TimeOfDay } from '../../../core/types';\n\n` +
    `export const placePhotos: Record<string, number> = {\n${placeLines.join('\n')}\n};\n\n` +
    `export const heroPhotos: Partial<Record<TimeOfDay, number>> = {\n${heroLines.join('\n')}\n};\n`,
);
console.log(`\n${found} place photos, ${Object.keys(dest.heroes ?? {}).length} heroes. Credits are in places.json and destination.json.`);
