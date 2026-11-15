#!/usr/bin/env node
// Downloads one photo per place and four time-of-day city photos into the pack, from Wikimedia
// Commons, keeping only reusable licences. Run once per city while online (scripts/prepare-pack.mjs
// runs it for you, after fetch-facts.mjs):
//
//   node scripts/build-photos.mjs                       # Seville: places 1200 px wide, heroes 1600
//   node scripts/build-photos.mjs --width 1000 --hero-width 1400
//   node scripts/build-photos.mjs --only catedral,alcazar   # redo some places (heroes untouched)
//   node scripts/build-photos.mjs --prune               # also delete photos nothing uses any more
//
// A place's photo is the main image of the Wikipedia article fetch-facts.mjs matched to it (the
// "wiki-<id>" fact's source), so it went through the same wrong-article checks. Places with no
// article fall back to a Commons search, and a hit must name the place and be in the city.
// To replace a bad pick, put the Commons file name in app/src/pack/<dest>/photos/overrides.json,
// e.g. { "catedral": "File:Catedral de Sevilla.jpg" }, and run again with --only catedral.
//
// The city heroes are picked from the place photos (HERO_PLACES below), at hero width; set
// "heroes": { "night": "File:…" } in overrides.json to choose another. The old Commons searches
// are only a fallback when none of those places has a photo.
//
// Commons serves thumbnails in fixed steps (1280, 1920 …), so each photo is fetched at the next
// step up and scaled to the width here with macOS `sips` (JPEG quality 82). Narrower originals
// are kept at their own size.
//
// Writes: photos/<id>.jpg and photos/hero-<time>.jpg, a `photo` record (file, credit, licence,
// source) on each place in places.json, `heroes` in destination.json, and photos/index.ts (the
// static require() list the app bundles). Requests go one at a time with a gap; see
// fetch-facts.mjs about WIKIMEDIA_CONTACT and Wikimedia's rate limits.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const opt = name => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const destId = opt('dest') ?? 'seville';
const WIDTH = Number(opt('width') ?? 1200);
const HERO_WIDTH = Number(opt('hero-width') ?? 1600);
const only = opt('only') ? new Set(opt('only').split(',')) : undefined;
const prune = flag('prune');
const cacheDir = opt('cache'); // optional: keep API responses on disk while tuning

const packDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'app/src/pack', destId);
const photoDir = join(packDir, 'photos');
const places = JSON.parse(readFileSync(join(packDir, 'places.json'), 'utf8'));
const dest = JSON.parse(readFileSync(join(packDir, 'destination.json'), 'utf8'));
const facts = existsSync(join(packDir, 'facts.json')) ? JSON.parse(readFileSync(join(packDir, 'facts.json'), 'utf8')) : [];
const overridesPath = join(photoDir, 'overrides.json');
const overrides = existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, 'utf8')) : {};
const city = dest.name;
const localCity = { Seville: 'Sevilla' }[city] ?? city;

// Which place photos become the time-of-day heroes, first one with a photo wins.
const HERO_PLACES = {
  seville: {
    midday: ['plaza-espana'],
    afternoon: ['catedral'],
    dusk: ['torre-oro', 'puente-triana'],
    night: ['setas'],
  },
}[destId] ?? {};
// Fallback only, when none of those places has a photo.
const HERO_SEARCHES = {
  midday: `${localCity} plaza día`,
  afternoon: `${localCity} calle tarde`,
  dusk: `${localCity} atardecer`,
  night: `${localCity} noche`,
};

// Wikimedia asks automated clients to identify themselves; this names the tool, not a person.
const contact = process.env.WIKIMEDIA_CONTACT?.trim();
const HEADERS = { 'User-Agent': `travel-buddy-prepare/1.0 (offline travel guide pack builder${contact ? `; ${contact}` : ''})` };
const ALLOWED = /^(cc0|public domain|pd|cc by(-sa)? \d)/i;
const MAX_KM = 3;

// ---------------------------------------------------------------------------
// Polite HTTP: one request at a time, a gap between them, Retry-After honoured. API calls are
// paced to Wikimedia's limit for clients without contact details unless WIKIMEDIA_CONTACT is set.

const sleep = ms => new Promise(r => setTimeout(r, ms));
let apiGap = contact ? 200 : 6500;
const FILE_GAP = 1000;
let last = 0;
let apiCalls = 0;
let downloads = 0;
let answered = 0;
let networkErrors = 0;

async function politeFetch(url, gap) {
  for (let attempt = 0; ; attempt++) {
    const wait = last + gap() - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    let res;
    try {
      res = await fetch(url, { headers: HEADERS });
    } catch (e) {
      // No answer at all: offline. Give up early, before anything is written.
      if (++networkErrors >= 3 && answered === 0) {
        console.log(`Cannot reach Wikimedia (${e.cause?.code ?? e.message}). Nothing changed; run this again while online.`);
        process.exit(1);
      }
      throw e;
    }
    answered++;
    if (res.ok) return res;
    if (attempt >= 4 || !(res.status === 429 || res.status >= 500)) throw new Error(`${res.status} from ${new URL(url).host}`);
    const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt * 5;
    if (res.status === 429) {
      apiGap = Math.max(apiGap, 6500);
      console.log(`    Wikimedia asked to slow down; waiting ${retryAfter} s`);
    }
    await sleep(retryAfter * 1000);
  }
}

async function api(host, params) {
  const url = `https://${host}/w/api.php?` + new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  const cached = cacheDir && join(cacheDir, createHash('sha1').update(url).digest('hex') + '.json');
  if (cached && existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
  apiCalls++;
  const body = await (await politeFetch(url, () => apiGap)).json();
  if (cached) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cached, JSON.stringify(body));
  }
  return body;
}

/** Maps each asked-for title to the page the API answered with, through normalisation and redirects. */
function pagesByTitle(j, titles) {
  const pages = new Map((j?.query?.pages ?? []).map(p => [p.title, p]));
  const hop = new Map([...(j?.query?.normalized ?? []), ...(j?.query?.redirects ?? [])].map(x => [x.from, x.to]));
  const out = new Map();
  for (const t of titles) {
    let cur = t;
    for (let i = 0; i < 3 && !pages.has(cur) && hop.has(cur); i++) cur = hop.get(cur);
    if (pages.has(cur)) out.set(t, pages.get(cur));
  }
  return out;
}

const chunks = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

// ---------------------------------------------------------------------------
// Finding files

const fold = s =>
  (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
const words = s => fold(s).split(/[^a-z0-9]+/).filter(Boolean);
const strip = s => (s ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const STOP = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'the', 'of', 'and', 'a', 'al', 'en', 'jpg', 'jpeg', 'png', 'file', 'spain', 'espana', ...words(city), ...words(localCity)]);
const GENERIC = new Set(
  words(`church iglesia parroquia basilica capilla chapel museum museo centre center centro house casa palace palacio real royal
    plaza square calle street barrio quarter park parque garden gardens jardin jardines market mercado bridge puente gate puerta
    tower torre castle castillo bar tapas bodega bodeguita restaurant freiduria cafe confiteria heladeria tablao flamenco san santa`),
);

function km(a, b) {
  const rad = x => (x * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Licence, author, size and a thumbnail at least `width` wide (when the original is) for Commons files. */
async function fileInfos(titles, width) {
  const out = new Map();
  for (const batch of chunks([...new Set(titles)], 40)) {
    const j = await api('commons.wikimedia.org', {
      action: 'query',
      titles: batch.join('|'),
      prop: 'imageinfo',
      iiprop: 'url|extmetadata|mime|size',
      iiurlwidth: String(width),
      iiextmetadatafilter: 'LicenseShortName|Artist|ImageDescription|GPSLatitude|GPSLongitude',
      iiextmetadatalanguage: 'en',
    });
    for (const [asked, page] of pagesByTitle(j, batch)) {
      const ii = page.imageinfo?.[0];
      if (!ii) continue;
      const meta = ii.extmetadata ?? {};
      const lat = Number(meta.GPSLatitude?.value);
      const lon = Number(meta.GPSLongitude?.value);
      out.set(asked, {
        title: page.title,
        ok: /jpeg|png/.test(ii.mime) && ALLOWED.test(strip(meta.LicenseShortName?.value)),
        thumb: ii.thumburl ?? ii.url,
        thumbWidth: ii.thumbwidth ?? ii.width,
        width: ii.width,
        height: ii.height,
        license: strip(meta.LicenseShortName?.value),
        credit: strip(meta.Artist?.value) || 'Unknown author',
        description: strip(meta.ImageDescription?.value),
        point: Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : undefined,
        source: ii.descriptionurl,
      });
    }
  }
  return out;
}

/** The main image of each Wikipedia article, batched per language. Keys are "lang:Title". */
async function articleImages(articles) {
  const out = new Map();
  const byLang = new Map();
  for (const a of articles) byLang.set(a.lang, [...(byLang.get(a.lang) ?? []), a.title]);
  for (const [lang, titles] of byLang) {
    for (const batch of chunks([...new Set(titles)], 40)) {
      const j = await api(`${lang}.wikipedia.org`, { action: 'query', titles: batch.join('|'), prop: 'pageimages', piprop: 'name', redirects: '1' });
      for (const [asked, page] of pagesByTitle(j, batch)) if (page.pageimage) out.set(`${lang}:${asked}`, `File:${page.pageimage}`);
    }
  }
  return out;
}

/** The old search, for a place fetch-facts has not matched: the top Wikipedia hit's main image. */
async function searchedArticleImage(lang, query) {
  const j = await api(`${lang}.wikipedia.org`, { action: 'query', generator: 'search', gsrsearch: query, gsrlimit: '1', prop: 'pageimages', piprop: 'name' });
  const name = j.query?.pages?.[0]?.pageimage;
  return name ? `File:${name}` : undefined;
}

async function commonsSearch(query) {
  const j = await api('commons.wikimedia.org', {
    action: 'query', list: 'search', srsearch: `${query} filetype:bitmap`, srnamespace: '6', srlimit: '6',
  });
  return (j.query?.search ?? []).map(r => r.title);
}

// A search hit must show the place itself, not an object in it or about it.
const OBJECTS = new Set(
  words(`busto bust estatua statue escultura sculpture maqueta model retablo altarpiece cuadro painting pintura grabado
    engraving plano map mapa detalle detail sello stamp moneda coin placa plaque rotulo azulejo lapida vitrina`),
);
// For a bar, café or restaurant a search hit must also name it as a phrase ("El Comercio", not
// "Lonja de Comercio") and must not show some other thing that shares the name: a convent, a
// street sign, a plaque to a namesake.
const VENUES = new Set(['tapas-bar', 'bar', 'cafe', 'restaurant', 'flamenco', 'shop']);
const VENUE_WORDS = new Set(words('bar tablao confiteria heladeria cafe restaurante restaurant taberna'));
const OTHER_THINGS = new Set(
  words(`convento convent monasterio iglesia church basilica capilla parroquia catedral ermita hermandad calle street avenida
    plaza barrio museo museum teatro palacio hospital castillo torre puerta puente camara lonja nino jesus virgen cristo`),
);

/** A Commons search hit must name the place and be in the city (by its GPS tag or its words). */
function plausibleFor(place, info) {
  if (info.width < 800) return false; // a search hit is only worth it as a real photo
  const titleWords = words(info.title);
  const t = new Set(words(`${info.title} ${info.description}`));
  const names = [place.name, place.localName, ...(place.aliases ?? [])].filter(Boolean);
  const own = new Set(names.flatMap(words));
  if (titleWords.some(w => OBJECTS.has(w) && !own.has(w))) return false;
  if (VENUES.has(place.category)) {
    if (titleWords.some(w => OTHER_THINGS.has(w) && !own.has(w))) return false;
    // The name as a phrase, also without a leading kind word ("Tablao El Arenal" → "el arenal";
    // not "Casa Morales" → "morales", where "Casa" is part of the name).
    const title = ` ${titleWords.join(' ')} `;
    const phrases = names.flatMap(n => {
      const w = words(n);
      return VENUE_WORDS.has(w[0]) && w.length > 1 ? [w, w.slice(1)] : [w];
    });
    if (!phrases.some(w => w.length > 0 && title.includes(` ${w.join(' ')} `))) return false;
  } else {
    const distinctive = [...own].filter(w => !STOP.has(w) && !GENERIC.has(w));
    if (distinctive.length && !distinctive.some(w => titleWords.includes(w))) return false;
  }
  if (info.point) return km(place.point, info.point) <= MAX_KM;
  return [...words(city), ...words(localCity)].some(w => t.has(w));
}

/** "File:…" from a Commons file page URL. */
function commonsTitle(url) {
  const m = /\/wiki\/(File:.+)$/.exec(url ?? '');
  return m ? decodeURIComponent(m[1]).replace(/_/g, ' ') : undefined;
}

/** Article from a fact's source URL, e.g. https://en.wikipedia.org/wiki/Torre_del_Oro. */
function articleOf(url) {
  const m = /^https?:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/(.+)$/.exec(url ?? '');
  return m ? { lang: m[1], title: decodeURIComponent(m[2]).replace(/_/g, ' ') } : undefined;
}

// ---------------------------------------------------------------------------
// Downloading and scaling

const haveSips = (() => {
  try {
    execFileSync('sips', ['--help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const pixels = path => {
  const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], { encoding: 'utf8' });
  return { width: Number(/pixelWidth: (\d+)/.exec(out)?.[1]), height: Number(/pixelHeight: (\d+)/.exec(out)?.[1]) };
};

async function download(info, file, width) {
  downloads++;
  const res = await politeFetch(info.thumb, () => FILE_GAP);
  const bytes = Buffer.from(await res.arrayBuffer());
  const final = join(photoDir, file);
  const tmp = `${final}.download`;
  writeFileSync(tmp, bytes);
  let size = { width: info.thumbWidth, height: Math.round((info.height * info.thumbWidth) / info.width) };
  if (haveSips) {
    // JPEG at the target width (narrower originals keep their size), quality 82. Commons hands
    // out the next fixed step up (1280 for 1200), so measure what came rather than trust the API.
    const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82'];
    if (pixels(tmp).width > width) args.push('--resampleWidth', String(width));
    execFileSync('sips', [...args, tmp, '--out', final], { stdio: 'ignore' });
    unlinkSync(tmp);
    size = pixels(final);
  } else {
    renameSync(tmp, final);
  }
  return { record: { file, credit: info.credit, license: info.license, source: info.source }, size };
}

// ---------------------------------------------------------------------------

mkdirSync(photoDir, { recursive: true });
const todo = places.filter(p => !only || only.has(p.id));
const wikiSource = new Map(facts.filter(f => String(f.id).startsWith('wiki-') && f.placeId).map(f => [f.placeId, f.source]));
const factsRan = wikiSource.size > 0;
console.log(
  `Photos for ${todo.length} places in ${city} (${WIDTH} px; heroes ${HERO_WIDTH} px)` +
    (factsRan ? '' : '\n  (no Wikipedia facts yet: run fetch-facts.mjs first for better matches; using the old search)') +
    (haveSips ? '' : '\n  (sips not found: keeping Commons thumbnails at their own size)'),
);

// 1. First choice per place: the override, else its article's main image.
const first = new Map();
const articles = new Map();
for (const p of todo) {
  if (overrides[p.id]) first.set(p.id, overrides[p.id]);
  else if (articleOf(wikiSource.get(p.id))) articles.set(p.id, articleOf(wikiSource.get(p.id)));
}
const images = await articleImages([...articles.values()]).catch(e => (console.log(`  error article images: ${e.message}`), new Map()));
for (const [id, a] of articles) if (images.get(`${a.lang}:${a.title}`)) first.set(id, images.get(`${a.lang}:${a.title}`));
if (!factsRan) {
  for (const p of todo) {
    if (first.has(p.id)) continue;
    const name = p.localName ?? p.name;
    const file =
      (await searchedArticleImage('es', `${name} ${localCity}`).catch(() => undefined)) ??
      (await searchedArticleImage('en', `${p.name} ${city}`).catch(() => undefined));
    if (file) first.set(p.id, file);
  }
}

// 2. Licences for all first choices at once; a Commons search for the rest.
let infos;
try {
  infos = await fileInfos([...first.values()], WIDTH);
} catch (e) {
  // Without Commons nothing can be checked: leave the pack as it is.
  console.log(`  error Commons file info: ${e.message}. Nothing changed.`);
  process.exit(1);
}
const chosen = new Map(); // place id → file info
const unsure = new Set(); // places whose search failed: keep what they had
for (const p of todo) {
  const info = infos.get(first.get(p.id));
  if (info?.ok) chosen.set(p.id, { ...info, how: overrides[p.id] ? 'override' : 'article image' });
  if (overrides[p.id]) {
    if (!info?.ok) console.log(`  -     ${p.id}: override ${overrides[p.id]} is ${info ? `not reusable (${info.license || info.title})` : 'not on Commons'}`);
    continue;
  }
  // An article image well under the photo width (an old print, a small upload): look for a
  // sharper one, and keep the article's if there is none.
  if (info?.ok && info.width >= WIDTH * 0.66) continue;
  try {
    const hits = await commonsSearch(`${p.localName ?? p.name} ${localCity}`);
    const hitInfos = hits.length ? await fileInfos(hits, WIDTH) : new Map();
    const fits = hits.map(h => hitInfos.get(h)).filter(i => i?.ok && plausibleFor(p, i));
    const pick = info?.ok ? fits.find(i => i.width >= WIDTH) : fits[0];
    if (pick) chosen.set(p.id, { ...pick, how: info?.ok ? `Commons search, sharper than the article's ${info.width} px` : 'Commons search' });
  } catch (e) {
    unsure.add(p.id);
    console.log(`  error ${p.id}: Commons search: ${e.message}${p.photo ? ' (keeping the previous photo)' : ''}`);
  }
}

// 3. Download and scale, one at a time.
const sizes = [];
for (const p of todo) {
  const info = chosen.get(p.id);
  if (!info && unsure.has(p.id)) continue;
  if (!info) {
    delete p.photo;
    console.log(`  -     ${p.id}: no reusable photo (scene tile instead)`);
    continue;
  }
  try {
    const { record, size } = await download(info, `${p.id}.jpg`, WIDTH);
    p.photo = record;
    sizes.push(size.width);
    console.log(`  ok    ${p.id}: ${info.title} (${info.how}; ${size.width}×${size.height} from ${info.width}×${info.height}; ${info.license}, ${info.credit.slice(0, 60)})`);
  } catch (e) {
    console.log(`  error ${p.id}: ${e.message}${p.photo ? ' (keeping the previous photo)' : ''}`);
  }
}

// 4. Heroes, from the place photos at hero width.
if (!only) {
  dest.heroes = dest.heroes ?? {};
  const heroFile = {};
  for (const tod of Object.keys(HERO_SEARCHES)) {
    const fromPlace = (HERO_PLACES[tod] ?? []).map(id => places.find(x => x.id === id)).find(x => x?.photo);
    const placeFile = fromPlace && (chosen.get(fromPlace.id)?.title ?? commonsTitle(fromPlace.photo.source));
    const file = overrides.heroes?.[tod] ?? placeFile;
    if (file) heroFile[tod] = { file, how: overrides.heroes?.[tod] ? 'override' : `photo of ${fromPlace.id}` };
  }
  const heroInfos = await fileInfos(Object.values(heroFile).map(h => h.file), HERO_WIDTH).catch(e => (console.log(`  error hero info: ${e.message}`), new Map()));
  for (const tod of Object.keys(HERO_SEARCHES)) {
    let info = heroFile[tod] && heroInfos.get(heroFile[tod].file);
    let how = heroFile[tod]?.how;
    if (!info?.ok) {
      // Fallback: the old time-of-day Commons search.
      const hits = await commonsSearch(HERO_SEARCHES[tod]).catch(() => []);
      const hitInfos = hits.length ? await fileInfos(hits, HERO_WIDTH).catch(() => new Map()) : new Map();
      info = hits.map(h => hitInfos.get(h)).find(i => i?.ok);
      how = 'Commons search';
    }
    if (!info?.ok) {
      console.log(`  -     hero ${tod}: none found; set heroes.${tod} in overrides.json`);
      continue;
    }
    try {
      const { record, size } = await download(info, `hero-${tod}.jpg`, HERO_WIDTH);
      dest.heroes[tod] = record;
      console.log(`  ok    hero ${tod}: ${info.title} (${how}; ${size.width}×${size.height}; ${info.license})`);
    } catch (e) {
      console.log(`  error hero ${tod}: ${e.message}`);
    }
  }
}

writeFileSync(join(packDir, 'places.json'), JSON.stringify(places, null, 1));
writeFileSync(join(packDir, 'destination.json'), JSON.stringify(dest, null, 1));

// React Native bundles images only through static require(), so list them in code.
const placeLines = places.filter(p => p.photo && existsSync(join(photoDir, p.photo.file))).map(p => `  ${JSON.stringify(p.id)}: require('./${p.photo.file}'),`);
const heroLines = Object.entries(dest.heroes ?? {})
  .filter(([, h]) => existsSync(join(photoDir, h.file)))
  .map(([tod, h]) => `  ${tod}: require('./${h.file}'),`);
writeFileSync(
  join(photoDir, 'index.ts'),
  `// Generated by scripts/build-photos.mjs. Do not edit; run the script again instead.\n` +
    `import type { TimeOfDay } from '../../../core/types';\n\n` +
    `export const placePhotos: Record<string, number> = {\n${placeLines.join('\n')}\n};\n\n` +
    `export const heroPhotos: Partial<Record<TimeOfDay, number>> = {\n${heroLines.join('\n')}\n};\n`,
);

// Photos left from an earlier run that nothing uses now.
const usedFiles = new Set([...places.filter(p => p.photo).map(p => p.photo.file), ...Object.values(dest.heroes ?? {}).map(h => h.file)]);
const stale = readdirSync(photoDir).filter(f => /\.(jpe?g|png)$/i.test(f) && !usedFiles.has(f));
if (stale.length) {
  if (prune) for (const f of stale) unlinkSync(join(photoDir, f));
  console.log(`\n${prune ? 'Deleted' : 'Not used any more (run with --prune to delete)'}: ${stale.join(', ')}`);
}

const narrow = sizes.filter(w => w < WIDTH).length;
console.log(
  `\n${placeLines.length} place photos, ${heroLines.length} heroes${narrow ? `; ${narrow} originals narrower than ${WIDTH} px kept at their size` : ''}. ` +
    `${apiCalls} API requests, ${downloads} downloads. Credits are in places.json and destination.json.`,
);
