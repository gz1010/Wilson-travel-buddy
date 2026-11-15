#!/usr/bin/env node
// Finds each pack place's Wikipedia article and saves its lead as a fact, so the guide can answer
// with Wi-Fi off. Run while online (scripts/prepare-pack.mjs runs it for you):
//
//   node scripts/fetch-facts.mjs                      # Seville
//   node scripts/fetch-facts.mjs --dry-run            # print the matches, write nothing
//   node scripts/fetch-facts.mjs --only catedral,alcazar
//   node scripts/fetch-facts.mjs --dest seville
//
// For each place in places.json it searches English Wikipedia, then Spanish, with the place's
// names plus the city. A Spanish article is swapped for its English one when a language link
// exists. A candidate must share a distinctive word with the place's names, must not be a
// disambiguation page, must lie within a few km of the place when the article has coordinates,
// and for bars, churches, parks and markets must say it is one. The article's summary (from
// /api/rest_v1/page/summary) becomes the fact "wiki-<placeId>", at most ~600 characters cut at a
// sentence end, with the article URL as `source` and "CC BY-SA 4.0" as `license`.
//
// Writes app/src/pack/<dest>/facts.json: the hand-written facts stay as they are, and every old
// "wiki-*" fact is replaced (with --only, just those places'). Text from Wikipedia, CC BY-SA 4.0.
//
// Requests go one at a time, at least 200 ms apart. Wikimedia allows clients whose User-Agent
// carries no contact details 10 API requests a minute, so without one this paces itself to that
// (about 15 minutes for Seville). Set WIKIMEDIA_CONTACT to an email or URL to be allowed 200 a
// minute; it is sent only to Wikimedia, in the User-Agent.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const opt = name => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const destId = opt('dest') ?? 'seville';
const dryRun = flag('dry-run');
const only = opt('only') ? new Set(opt('only').split(',')) : undefined;
const cacheDir = opt('cache'); // optional: keep responses on disk while tuning the matcher

const packDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'app/src/pack', destId);
const places = JSON.parse(readFileSync(join(packDir, 'places.json'), 'utf8'));
const dest = JSON.parse(readFileSync(join(packDir, 'destination.json'), 'utf8'));
const factsPath = join(packDir, 'facts.json');
const facts = JSON.parse(readFileSync(factsPath, 'utf8'));
const city = dest.name;
const localCity = { Seville: 'Sevilla' }[city] ?? city;
const localLang = dest.language ?? 'es';

// Wikimedia asks automated clients to identify themselves; this names the tool, not a person.
const contact = process.env.WIKIMEDIA_CONTACT?.trim();
const HEADERS = {
  'User-Agent': `travel-buddy-prepare/1.0 (offline travel guide pack builder${contact ? `; ${contact}` : ''})`,
  Accept: 'application/json',
};
const MAX_BODY = 600;
const MAX_KM = 3; // an article's coordinates must be this close to the place
const LICENSE = 'CC BY-SA 4.0';

// ---------------------------------------------------------------------------
// Polite HTTP: one request at a time, a gap between them, Retry-After honoured.

const sleep = ms => new Promise(r => setTimeout(r, ms));
let gapMs = contact ? 200 : 6500;
let lastRequest = 0;
let requests = 0;
let answered = 0;
let networkErrors = 0;

async function getJson(url) {
  const cached = cacheDir && join(cacheDir, createHash('sha1').update(url).digest('hex') + '.json');
  if (cached && existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequest + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    requests++;
    let res;
    try {
      res = await fetch(url, { headers: HEADERS });
    } catch (e) {
      // No answer at all: offline. Give up early, before anything is written.
      if (++networkErrors >= 3 && answered === 0) {
        console.log(`Cannot reach Wikipedia (${e.cause?.code ?? e.message}). Nothing changed; run this again while online.`);
        process.exit(1);
      }
      throw e;
    }
    answered++;
    if (res.ok || res.status === 404) {
      const body = res.ok ? await res.json() : null;
      if (cached) {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(cached, JSON.stringify(body));
      }
      return body ?? undefined;
    }
    if (attempt >= 4 || !(res.status === 429 || res.status >= 500)) throw new Error(`${res.status} from ${new URL(url).host}`);
    const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt * 5;
    if (res.status === 429) {
      gapMs = Math.max(gapMs, 6500);
      console.log(`    Wikimedia asked to slow down; waiting ${retryAfter} s, then one request every ${(gapMs / 1000).toFixed(1)} s`);
    }
    await sleep(retryAfter * 1000);
  }
}

const api = (lang, params) =>
  getJson(`https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({ format: 'json', formatversion: '2', ...params }));

/**
 * Up to five search hits with everything the checks need, in one request: coordinates,
 * disambiguation flag, short description, lead text, URL and the English language link.
 */
async function search(lang, query) {
  const j = await api(lang, {
    action: 'query',
    generator: 'search',
    gsrsearch: query,
    gsrlimit: '5',
    gsrnamespace: '0',
    redirects: '1',
    prop: 'coordinates|pageprops|description|info|extracts|langlinks',
    coprimary: 'primary',
    colimit: 'max',
    ppprop: 'disambiguation',
    inprop: 'url',
    exintro: '1',
    explaintext: '1',
    exlimit: 'max',
    lllang: 'en',
    lllimit: 'max',
  });
  return (j?.query?.pages ?? [])
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map(p => ({
      lang,
      title: p.title,
      type: p.pageprops && 'disambiguation' in p.pageprops ? 'disambiguation' : 'standard',
      description: p.description,
      extract: p.extract,
      coordinates: p.coordinates?.[0] ? { lat: p.coordinates[0].lat, lon: p.coordinates[0].lon } : undefined,
      url: p.fullurl,
      en: lang === 'en' ? undefined : p.langlinks?.find(l => l.lang === 'en')?.title,
    }));
}

const summary = (lang, title) =>
  getJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);

// ---------------------------------------------------------------------------
// Matching

const fold = s =>
  (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
const words = s => fold(s).split(/[^a-z0-9]+/).filter(Boolean);

// Ignored entirely: articles, prepositions and the city itself.
const STOP = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'lo', 'y', 'e', 'i', 'ii', 'the', 'of', 'and', 'a', 'al', 'en', 'on', 'spain', 'espana', ...words(city), ...words(localCity)]);
// Words that say what kind of place it is. They count towards a match, but a title sharing only
// these with the place ("Casa de la Memoria" for "Casa de la Guitarra") is not a match.
const GENERIC = new Set(
  words(
    `church iglesia parroquia parish basilica capilla chapel cathedral catedral convent convento monastery monasterio
     museum museo gallery centre center centro house casa palace palacio real royal hospital archive archivo general
     plaza square calle street avenue barrio quarter neighbourhood park parque garden gardens jardin jardines
     market mercado food lonja bridge puente gate puerta walls murallas tower torre castle castillo factory fabrica
     bar bars tapas bodega bodeguita taberna restaurant freiduria cafe confiteria heladeria ice cream tablao flamenco
     dance baile art arte arts artes fine bellas contemporary contemporaneo andalusian andaluz ceramics ceramica
     pavilion pabellon san santa santo old town casco antiguo jewish`,
  ),
);

/** How well a title matches the place: the best share of one name's words found in the title. */
function coverage(place, title) {
  const t = new Set(words(title));
  let best = 0;
  for (const name of [place.name, place.localName, ...(place.aliases ?? [])]) {
    const w = [...new Set(words(name))].filter(x => !STOP.has(x));
    if (!w.length) continue;
    const distinctive = w.filter(x => !GENERIC.has(x));
    // A name with distinctive words needs one of them in the title; an all-generic name
    // ("Museo de Bellas Artes") needs at least two of its words.
    const hits = w.filter(x => t.has(x));
    const ok = distinctive.length ? distinctive.some(x => t.has(x)) : hits.length >= Math.min(2, w.length);
    if (ok) best = Math.max(best, hits.length / w.length);
  }
  return best;
}

// What the article must say it is, for kinds of place whose names are easily shared.
const KIND_WORDS = {
  church: /\b(church|iglesia|basilica|chapel|capilla|parish|parroquia|temple|templo|cathedral|catedral|convent|brotherhood|hermandad)/,
  park: /\b(park|parque|garden|jardin|square|plaza)/,
  market: /\b(market|mercado|lonja)/,
  'tapas-bar': /\b(bar|bares|tapas|tavern|taberna|bodega|restaurant|restaurante)\b/,
  bar: /\b(bar|bares|tavern|taberna|pub|restaurant|restaurante|flamenco|locales?)\b|espacio cultural/,
  cafe: /\b(cafe|cafeteria|confiteria|pastry|pastries|pasteleria|ice cream|heladeria|bakery|churros?)\b/,
  restaurant: /\b(restaurant|restaurante|freiduria|fried|bar|tapas)\b/,
  flamenco: /\b(flamenco|tablao)\b/,
  shop: /\b(shop|tienda|store|workshop|taller)\b/,
};

// A bar, café or shop is never a convent, a street or a museum: a title naming another kind of
// place ("Convento de las Teresas" for the bar Las Teresas) is the wrong article, unless the
// place's own name says it ("Casa de la Guitarra" may be a "casa").
const VENUES = new Set(['tapas-bar', 'bar', 'cafe', 'restaurant', 'flamenco', 'shop']);
const OTHER_KINDS = new Set(
  words(`convento convent monasterio monastery iglesia church basilica capilla chapel parroquia cathedral catedral ermita
    hermandad calle street avenida avenue plaza square barrio district museo museum teatro theatre theater palacio palace
    hospital castillo castle torre tower puerta gate puente bridge camara`),
);
function otherKindInTitle(place, title) {
  if (!VENUES.has(place.category)) return undefined;
  const own = new Set([place.name, place.localName, ...(place.aliases ?? [])].flatMap(words));
  return words(title).find(w => OTHER_KINDS.has(w) && !own.has(w));
}

function km(a, b) {
  const rad = x => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Why an article does not describe this place, or undefined when it does. */
function reject(place, a, cov) {
  if (!a) return 'no article';
  if (a.type === 'disambiguation') return 'disambiguation page';
  if (!a.extract || a.extract.length < 60) return 'no usable text';
  const text = fold(`${a.description ?? ''} ${a.extract}`);
  if (a.coordinates) {
    const d = km(place.point, a.coordinates);
    if (d > MAX_KM) return `${d.toFixed(1)} km away`;
  } else {
    // Without coordinates it could be a person or a painting: be strict.
    if (cov < 1) return 'no coordinates and only a partial name match';
    if (!new RegExp(`\\b(${[...words(city), ...words(localCity)].join('|')})\\b`).test(text)) return `no coordinates and no mention of ${city}`;
  }
  const kind = KIND_WORDS[place.category];
  if (kind && !kind.test(text)) return `does not read like a ${place.category}`;
  return undefined;
}

/** Plain text of at most MAX_BODY characters, cut after the last full sentence that fits. */
function trimBody(text) {
  const t = text
    .replace(/\s+/g, ' ')
    .replace(/\[(cita requerida|citation needed|nota \d+|\d+)\]/gi, '') // editors' markers
    .replace(/\s+([,.;:])/g, '$1') // the gap a removed pronunciation leaves: "Hércules , or"
    .trim();
  if (t.length <= MAX_BODY) return t;
  const head = t.slice(0, MAX_BODY + 1);
  let cut = -1;
  for (const m of head.matchAll(/[.!?](?=\s+[A-Z0-9¿¡"“(])/g)) if (m.index + 1 <= MAX_BODY) cut = m.index + 1;
  if (cut > MAX_BODY / 3) return t.slice(0, cut);
  const space = t.lastIndexOf(' ', MAX_BODY - 1);
  return `${t.slice(0, space > 0 ? space : MAX_BODY - 1).replace(/[,;:]$/, '')}…`;
}

const used = new Map(); // article URL → place id, so two places never share one article

async function findArticle(place) {
  const local = place.localName ?? place.name;
  const searches = [
    ['en', `${place.name} ${city}`],
    [localLang, `${local} ${localCity}`],
  ];
  const tried = [];
  const candidates = [];
  let errored = false;
  for (const [lang, q] of searches) {
    const hits = await search(lang, q).catch(e => ((errored = true), tried.push(`search ${lang}: ${e.message}`), []));
    for (const hit of hits) {
      if (candidates.some(c => c.url === hit.url)) continue;
      const cov = coverage(place, hit.title);
      if (cov === 0) continue;
      const other = otherKindInTitle(place, hit.title);
      const why =
        (other ? `a ${other}, not a ${place.category}` : undefined) ??
        reject(place, hit, cov) ??
        (used.has(hit.url) && used.get(hit.url) !== place.id ? `already used for ${used.get(hit.url)}` : undefined);
      if (why) tried.push(`${hit.lang}:${hit.title}: ${why}`);
      else candidates.push({ ...hit, cov, order: candidates.length });
    }
    // English first: a full name match there needs no Spanish search.
    if (lang === 'en' && candidates.some(c => c.cov === 1)) break;
  }
  // Best name match first; English before Spanish, then search order, on ties.
  candidates.sort((a, b) => b.cov - a.cov || (a.lang === 'en' ? 0 : 1) - (b.lang === 'en' ? 0 : 1) || a.order - b.order);
  const best = candidates[0];
  if (!best) return { tried, errored };

  // Read it in English when the Spanish article has an English one, else as it is.
  const reads = best.en ? [['en', best.en], [best.lang, best.title]] : [[best.lang, best.title]];
  for (const [lang, title] of reads) {
    const s = await summary(lang, title).catch(e => ((errored = true), tried.push(`${title}: ${e.message}`), undefined));
    if (!s?.extract) continue;
    if (s.type === 'disambiguation') {
      tried.push(`${lang}:${s.title}: disambiguation page`);
      continue;
    }
    if (s.coordinates && km(place.point, s.coordinates) > MAX_KM) {
      tried.push(`${lang}:${s.title}: ${km(place.point, s.coordinates).toFixed(1)} km away`);
      continue;
    }
    const url = s.content_urls?.desktop?.page ?? best.url;
    used.set(url, place.id);
    used.set(best.url, place.id);
    // A one-line summary says little: then take the article's whole lead, when it is that article.
    const lead = lang === best.lang && title === best.title ? best.extract : undefined;
    const extract = s.extract.length < 200 && lead && lead.length > s.extract.length ? lead : s.extract;
    return { lang, title: s.title, description: s.description, extract, url, via: lang !== best.lang ? `${best.lang}:${best.title}` : undefined };
  }
  return { tried, errored };
}

// ---------------------------------------------------------------------------

const isWiki = f => String(f.id).startsWith('wiki-');
const previous = new Map(facts.filter(isWiki).map(f => [f.placeId, f]));
const kept = facts.filter(f => !isWiki(f) || (only && !only.has(f.placeId)));
for (const f of kept) if (isWiki(f) && f.source) used.set(f.source, f.placeId);
const fresh = [];
const misses = [];
const failed = [];
const todo = places.filter(p => !only || only.has(p.id));
const started = Date.now();
console.log(
  `Wikipedia facts for ${todo.length} places in ${city}${dryRun ? ' (dry run: nothing is written)' : ''}` +
    (contact ? '' : `\n  (no WIKIMEDIA_CONTACT: pacing to Wikimedia's 10 requests a minute, about ${Math.ceil((todo.length * 2.6 * gapMs) / 60000)} min)`),
);

for (const place of todo) {
  try {
    const a = await findArticle(place);
    if (!a.url && a.errored && previous.has(place.id)) {
      // Wikipedia did not answer: keep what an earlier run found rather than lose it.
      fresh.push(previous.get(place.id));
      failed.push(place.id);
      console.log(`  error ${place.id}: ${a.tried.join('; ')} (keeping the previous fact)`);
      continue;
    }
    if (!a.url) {
      (a.errored ? failed : misses).push(place.id);
      console.log(`  ${a.errored ? 'error' : '-    '} ${place.id}: no article${a.tried.length ? ` (${a.tried.join('; ')})` : ''}`);
      continue;
    }
    const fact = {
      id: `wiki-${place.id}`,
      placeId: place.id,
      title: a.title,
      body: trimBody(a.extract),
      tags: place.tags,
      source: a.url,
      license: LICENSE,
    };
    fresh.push(fact);
    console.log(`  ok    ${place.id}: ${a.lang}:${a.title}${a.via ? ` (from ${a.via})` : ''}, ${fact.body.length} chars${a.description ? ` · ${a.description}` : ''}`);
  } catch (e) {
    failed.push(place.id);
    if (previous.has(place.id)) fresh.push(previous.get(place.id));
    console.log(`  error ${place.id}: ${e.message}${previous.has(place.id) ? ' (keeping the previous fact)' : ''}`);
  }
}

// Hand-written facts first, as they were; then one Wikipedia fact per place, in places.json order.
const order = new Map(places.map((p, i) => [p.id, i]));
const wiki = [...kept.filter(isWiki), ...fresh].sort((a, b) => (order.get(a.placeId) ?? 1e9) - (order.get(b.placeId) ?? 1e9));
const out = [...kept.filter(f => !isWiki(f)), ...wiki];
const english = fresh.filter(f => f.source.includes('//en.')).length;
// Nothing answered at all (offline): leave facts.json exactly as it was.
const offline = todo.length > 0 && failed.length === todo.length;

if (!dryRun && !offline) writeFileSync(factsPath, JSON.stringify(out, null, 1) + '\n');
console.log(
  `\n${fresh.length} Wikipedia facts (${english} English, ${fresh.length - english} ${localLang}), ${misses.length} places without one, ` +
    `${out.length - wiki.length} hand-written kept: ${out.length} facts in all. ${requests} requests in ${Math.round((Date.now() - started) / 1000)} s.` +
    (dryRun ? ' Dry run: facts.json not written.' : offline ? ' Wikipedia did not answer: facts.json left as it was.' : ` Wrote ${factsPath.replace(/.*\/app\//, 'app/')}.`) +
    (failed.length && !offline ? ` ${failed.length} lookups failed (${failed.join(', ')}); run again to retry them.` : ''),
);
if (failed.length) process.exitCode = 1;
