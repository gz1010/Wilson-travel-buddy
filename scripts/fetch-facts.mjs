#!/usr/bin/env node
// Adds one Wikipedia summary per place to the pack's facts, so the guide and the Place screen
// have something to say about every place. Run once while online (prepare-pack.mjs runs it):
//
//   node scripts/fetch-facts.mjs                  # Seville
//   node scripts/fetch-facts.mjs --dest seville --dry-run   # print matches, write nothing
//   node scripts/fetch-facts.mjs --only catedral,alcazar
//
// For each place it searches English Wikipedia, then Spanish (following the Spanish article's
// link to English when there is one), skips disambiguation pages and titles that share no
// significant word with the place or aren't about the city, and keeps the article summary cut at a sentence end.
// Fix a wrong or missing match in app/src/pack/<dest>/wiki-overrides.json.
// Hand-written facts are kept; earlier "wiki-*" facts are replaced.
// Text: Wikipedia contributors, CC BY-SA 4.0; each fact records its article URL.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = name => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const destId = opt('dest') ?? 'seville';
const dryRun = argv.includes('--dry-run');
const only = opt('only') ? new Set(opt('only').split(',')) : undefined;
const MAX_CHARS = 600;

const packDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'app/src/pack', destId);
const places = JSON.parse(readFileSync(join(packDir, 'places.json'), 'utf8'));
const facts = JSON.parse(readFileSync(join(packDir, 'facts.json'), 'utf8'));
const dest = JSON.parse(readFileSync(join(packDir, 'destination.json'), 'utf8'));
const city = dest.name;
const localCity = { Seville: 'Sevilla' }[city] ?? city;

// Wikimedia asks automated clients to identify themselves; this names the tool, not a person.
const HEADERS = { 'User-Agent': 'TravelBuddyPackBuilder/1.0 (offline travel app; pack build script)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Wikipedia rate-limits anonymous clients: pause between requests, and back off on 429.
const GAP_MS = Number(opt('gap') ?? 1000);
async function get(url) {
  await sleep(GAP_MS);
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: HEADERS });
    if (res.ok) return res.json();
    if (res.status === 404) return undefined;
    const wait = Number(res.headers.get('retry-after')) * 1000 || 5000 * 2 ** attempt;
    await sleep(Math.min(wait, 60000));
  }
  throw new Error(`${new URL(url).host} failed`);
}

const api = (lang, params) =>
  get(`https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({ format: 'json', formatversion: '2', ...params }));

const summary = (lang, title) =>
  get(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);

// Words that say nothing about which place an article is about.
const STOP = new Set(
  `the of and in de del la las el los y en a san santa santo real casa palacio museo museum
   church iglesia plaza square park parque garden gardens jardin jardines torre tower
   puerta gate mercado market bar restaurant quarter barrio`.split(/\s+/),
);
STOP.add(city.toLowerCase());
STOP.add(localCity.toLowerCase());

const words = s =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && !STOP.has(w));

/**
 * Whether an article title names this place: every significant word of the place's name (or of
 * its local name) is in the title, and the title adds at most one word of its own (none for a
 * one-word name), so "El Comercio" doesn't match "Cámara de comercio".
 */
function namesPlace(title, place) {
  const t = new Set(words(title));
  const variants = [place.name, place.localName].filter(Boolean).map(words).filter(v => v.length);
  const known = new Set(variants.flat());
  const extras = [...t].filter(w => !known.has(w)).length;
  return variants.some(v => v.every(w => t.has(w)) && extras <= (v.length >= 2 ? 1 : 0));
}

const mentionsCity = text => [city, localCity].some(c => text.toLowerCase().includes(c.toLowerCase()));

/** Cut to at most MAX_CHARS, at the last sentence end that fits. */
function trim(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_CHARS) return clean;
  const cut = clean.slice(0, MAX_CHARS);
  const end = Math.max(...['. ', '! ', '? '].map(p => cut.lastIndexOf(p)));
  return end > 80 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…';
}

async function search(lang, query) {
  const j = await api(lang, { action: 'query', list: 'search', srsearch: query, srlimit: '5' });
  return (j?.query?.search ?? []).map(r => r.title);
}

async function englishLink(esTitle) {
  const j = await api('es', { action: 'query', titles: esTitle, prop: 'langlinks', lllang: 'en' });
  return j?.query?.pages?.[0]?.langlinks?.[0]?.title;
}

/** The first usable summary among the search hits, as { lang, s }. */
async function firstSummary(lang, titles, place) {
  for (const title of titles) {
    if (!namesPlace(title, place)) continue;
    let useLang = lang;
    let useTitle = title;
    if (lang === 'es') {
      const en = await englishLink(title).catch(() => undefined);
      if (en && namesPlace(en, place)) [useLang, useTitle] = ['en', en];
    }
    const s = await summary(useLang, useTitle).catch(() => undefined);
    if (!s || s.type === 'disambiguation' || !s.extract || s.extract.length < 60) continue;
    // "Alfalfa" is a plant, not Plaza de la Alfalfa: the article has to be about this city.
    if (!mentionsCity(`${s.extract} ${s.description ?? ''}`)) continue;
    return { lang: useLang, s };
  }
  return undefined;
}

// Hand fixes: { "<placeId>": "en:Article title" } to name the article, or null to skip a place.
const overridesPath = join(packDir, 'wiki-overrides.json');
const overrides = existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, 'utf8')) : {};

async function articleFor(place) {
  if (place.id in overrides) {
    if (!overrides[place.id]) return undefined;
    const [lang, ...rest] = overrides[place.id].split(':');
    const s = await summary(lang, rest.join(':'));
    return s?.extract ? { lang, s } : undefined;
  }
  const en = await firstSummary('en', await search('en', `${place.name} ${city}`), place);
  if (en) return en;
  const name = place.localName ?? place.name;
  return firstSummary('es', await search('es', `${name} ${localCity}`), place);
}

const kept = facts.filter(f => !f.id.startsWith('wiki-') || (only && !only.has(f.placeId)));
const added = [];
for (const place of places) {
  if (only && !only.has(place.id)) continue;
  try {
    const hit = await articleFor(place);
    if (!hit) {
      console.log(`  -     ${place.id}: no matching article`);
      continue;
    }
    const { lang, s } = hit;
    added.push({
      id: `wiki-${place.id}`,
      placeId: place.id,
      title: s.title,
      body: trim(s.extract),
      tags: place.tags,
      source: s.content_urls?.desktop?.page ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(s.title)}`,
      license: 'CC BY-SA 4.0',
    });
    console.log(`  ok    ${place.id}: ${lang}:${s.title}`);
  } catch (e) {
    console.log(`  error ${place.id}: ${e.message}`);
  }
}

const out = [...kept, ...added];
console.log(`\n${added.length} Wikipedia facts; ${out.length} facts in all.`);
if (dryRun) console.log('Dry run: facts.json not written.');
else writeFileSync(join(packDir, 'facts.json'), JSON.stringify(out, null, 1) + '\n');
