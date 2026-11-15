#!/usr/bin/env node
// Reads a trip itinerary, an iCalendar file (.ics, as Google Calendar and Apple Calendar export
// it) or plain text, and lists the places it names: which are already in the city pack and which
// scripts/prepare-pack.mjs --itinerary should look up in OpenStreetMap. Plain parsing, no model
// and no network, so it is safe to run offline as a dry run:
//
//   node scripts/itinerary.mjs trip.ics                  # against the Seville pack
//   node scripts/itinerary.mjs notes.txt --dest seville
//
// .ics: each VEVENT (cancelled ones and flights, trains and transfers skipped) gives, in this
// order, Apple's place title (X-APPLE-STRUCTURED-LOCATION), the first part of LOCATION unless it
// is a street address, and SUMMARY without the activity ("Lunch at Eslava" -> "Eslava", "Dinner
// with Ana" -> nothing). DESCRIPTION is never read: it tends to hold booking codes and people.
// Text: each line without bullets, day headings ("Day 2", "Monday 17 Nov"), times, dates and links,
// cut at commas, semicolons, arrows, " - " and "then"; travel ("Train to Cordoba") is skipped too.
//
// A name is in the pack when it contains one of a place's names (name, localName, aliases, and
// those without "de", "la", "the", "real" or the city), as the app's PackIndex.findPlace does, or
// when it is a distinctive part of exactly one place's name ("Pilatos"). For an event, its most
// precise name decides, so "Ayuntamiento de Sevilla, Plaza Nueva, 1" is looked up rather than
// taken for the pack's Plaza Nueva.
//
// The app's own importer (app/src/core/itineraryImport.ts) turns the same files into the trip;
// this one only needs the names, and runs in plain Node with no build step.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Words

export const fold = s =>
  (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
export const words = s => fold(s).split(/[^a-z0-9]+/).filter(Boolean);
export const slug = s =>
  fold(s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * Words that never make a name on their own: what you do, when, where in general, and the kinds of
 * place ("museum", "iglesia"). A name to look up needs at least one word that is not here.
 */
export const NON_NAME = new Set(
  words(`
    a an the of and y e de del la las el los lo en at in on to into with from by for about around near
    visit visita visiting see tour tours guided walking walk stroll wander explore climb trip day days
    lunch dinner breakfast brunch coffee drinks drink tapas snack snacks meal food churros ice cream show
    concert mass ticket tickets entry entrance booking booked reservation reserved confirmed check checkin
    checkout out free time rest siesta nap sleep shopping souvenirs meet meeting call pickup pick up
    flight flights train trains bus taxi uber cab transfer airport station terminal hotel hostel airbnb
    apartment room arrival arrive arrives departure depart leave return back home pack packing
    morning afternoon evening night noon midday tonight today tomorrow early late am pm
    monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun
    lunes martes miercoles jueves viernes sabado domingo
    january february march april may june july august september october november december
    jan feb mar apr jun jul aug sep sept oct nov dec
    enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre
    manana tarde noche dia
    seville sevilla spain espana andalusia andalucia city ciudad town old new casco antiguo centre center centro
    church iglesia parroquia cathedral catedral basilica chapel capilla convent convento monastery monasterio
    museum museo gallery palace palacio castle castillo tower torre bridge puente gate puerta walls murallas
    market mercado square plaza street calle avenue avenida park parque garden gardens jardin jardines
    river rio bar bars restaurant restaurante cafe cafeteria taberna bodega tablao flamenco
    quarter barrio neighbourhood neighborhood district area hall
    sweets cake cakes pastries dessert wine beer cocktail cocktails picnic photo photos sightseeing
    somewhere anywhere nearby crawl
  `),
);

/** Whether some text is worth looking up as a place name. */
export function isPlaceName(s) {
  const w = words(s);
  return w.length > 0 && w.length <= 8 && w.some(x => x.length >= 3 && !NON_NAME.has(x) && !/^\d+$/.test(x));
}

/** Trims quotes, brackets and stray punctuation off a candidate name. */
function tidy(s) {
  return (s ?? '')
    .replace(/[“”"«»]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:;,.!?*•·'’]+|[\s\-–—:;,.!?*•·]+$/g, '')
    .replace(/^the\s+/i, '')
    .trim()
    .slice(0, 80);
}

// ---------------------------------------------------------------------------
// Phrases: "10:00 Lunch with Ana at Eslava (booked)" -> ["Eslava"]

const TIME = /\b(?:from\s+|at\s+|@\s*)?\d{1,2}(?:[:.h]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|h|hrs?)?(?:\s*(?:-|–|—|to|until|til)\s*\d{1,2}(?:[:.h]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|h|hrs?)?)?(?=$|[\s,;:)])/gi;
const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre';
const DAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo';
const DATE = new RegExp(
  `\\b(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[/.]\\d{1,2}(?:[/.]\\d{2,4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})\\.?(?:\\s+\\d{4})?|(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?)\\b`,
  'gi',
);
/** A heading at the start of a line: "Day 2:", "Monday 17 Nov -", "17/11", "Morning:". */
const HEADING = new RegExp(
  `^(?:(?:day|d[ií]a)\\s*\\d+\\b|(?:${DAYS})\\b\\.?|(?:the\\s+)?(?:morning|afternoon|evening|night|noon|midday|ma[nñ]ana|tarde|noche)\\b|${DATE.source})[\\s:,.)\\-–—]*`,
  'i',
);
/** What people do at a place, at the start of a phrase, with the preposition after it. */
const LEAD = new RegExp(
  `^(?:${[
    'visit(?:ing)?', 'visita(?:r)?', 'see(?:ing)?', 'explore', 'exploring', 'discover', 'guided tour(?: of)?', 'walking tour(?: of)?',
    'tour(?: of)?', 'walk(?:ing)?', 'stroll', 'wander', 'climb', 'lunch', 'dinner', 'breakfast', 'brunch', 'coffee', 'drinks?',
    'tapas', 'snacks?', 'ice cream', 'churros', 'flamenco show', 'show', 'concert', 'mass', 'tickets?', 'entry', 'entrance',
    'booking', 'booked', 'reservation', 'check[- ]?in', 'check[- ]?out', 'go', 'going', 'head', 'back', 'return', 'meet(?:ing)?',
    'sunset', 'sunrise', 'views?', 'free time', 'rest', 'siesta', 'then', 'and', 'also', 'maybe', 'optional', 'quick', 'early',
    'late', 'first', 'last', 'stop', 'time', 'we', "we'll", 'i', "i'll", 'will', 'our', 'my', 'some',
    'a', 'an', 'the', 'to', 'at', 'in', 'on', 'into', 'around', 'through', 'along', 'across', 'over', 'from', 'of', 'for', 'inside', 'up', '@',
  ].join('|')})(?=$|[\\s:,.!\\-])[\\s:,.!\\-]*`,
  'i',
);
const TRAIL = /\s+(?:visit|tour|tickets?|entry|lunch|dinner|drinks|show|booked|reservation|reserved|confirmed|paid)$/i;
/** Events that are travel, not a place to go. */
const TRAVEL = /\b(flight|vuelo|train|tren|ave|bus|coach|ferry|transfer|taxi|uber|cab|car rental|rental car|drive to|airport)\b/i;

function stripLead(s) {
  let t = s.trim();
  for (let i = 0; i < 12; i++) {
    const next = t.replace(LEAD, '').replace(TRAIL, '').trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

/** Capitalised runs in a sentence ("we wander round Barrio de Santa Cruz" -> "Barrio de Santa Cruz"). */
function capitalRuns(s) {
  const CONNECT = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'of', 'the', 'di', 'da', 'dos', 'du']);
  const runs = [];
  let run = [];
  const flush = () => {
    while (run.length && CONNECT.has(run.at(-1).toLowerCase())) run.pop();
    if (run.length) runs.push(run.join(' '));
    run = [];
  };
  for (const tok of s.split(/\s+/)) {
    const bare = tok.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    if (/^\p{Lu}/u.test(bare)) run.push(bare);
    else if (run.length && CONNECT.has(bare.toLowerCase())) run.push(bare);
    else flush();
    if (/[.,;:!?]$/.test(tok)) flush();
  }
  flush();
  return runs;
}

/** One phrase of an itinerary ("Lunch with Ana at Eslava") -> the place names in it. */
function segmentNames(seg) {
  let s = seg.replace(DATE, ' ').replace(TIME, ' ');
  s = s.replace(/\bwith\s+.+?(?=\s+(?:at|@)\s|$)/i, ' '); // "with Ana": people, not places
  s = stripLead(s.replace(/\s+/g, ' '));
  const at = /(?:^|\s)(?:at|@)\s+(.+)$/i.exec(s); // "Flamenco show at Casa de la Guitarra"
  if (at) s = stripLead(at[1]);
  s = tidy(s);
  if (!s) return [];
  return words(s).length > 5 ? capitalRuns(s).map(tidy) : [s];
}

/** Links and e-mail addresses: never a place name ("Tickets: https://…", a Meet link as LOCATION). */
const LINK = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|\S+@\S+\.\S+/gi;

/** Every place name in a phrase or line, in order. */
export function phraseNames(text) {
  const t = (text ?? '').replace(LINK, ' ').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  return t
    .split(/\s*(?:->|=>|[;|+→⇒>]|,|\s[-–—]\s|\b(?:and then|then|followed by|after that|afterwards)\b)\s*/i)
    // "Murillo Gardens and the Alcázar": two places when each side has a capitalised word.
    .flatMap(seg => {
      const parts = seg.split(/\s+(?:and|&)\s+/i);
      return parts.length > 1 && parts.every(p => /(?:^|\s)\p{Lu}/u.test(p)) ? parts : [seg];
    })
    .flatMap(segmentNames)
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// iCalendar (RFC 5545)

/**
 * An itinerary file as text. An iCalendar file is unfolded before it is decoded: RFC 5545 folds
 * at 75 octets, and a simple writer may fold inside a multi-byte UTF-8 character ("Alc\r\n ázar"
 * split in the "á"), which decoding first would turn into two replacement characters.
 */
export function readItinerary(path) {
  const raw = readFileSync(path).toString('latin1'); // one char per byte, so nothing is lost yet
  const bytes = /BEGIN:VCALENDAR/i.test(raw) ? raw.replace(/\r?\n[ \t]/g, '') : raw;
  return Buffer.from(bytes, 'latin1').toString('utf8');
}

/** Content lines with folding undone (a line starting with a space or tab continues the last). */
function contentLines(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function splitUnquoted(s, sep) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const c of s) {
    if (c === '"') quoted = !quoted;
    if (c === sep && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** "NAME;PARAM=VALUE;PARAM=\"quoted: value\":value" -> { name, params, value }. */
function parseProperty(line) {
  let quoted = false;
  let i = 0;
  for (; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) break;
  }
  if (i >= line.length) return undefined;
  const [name, ...rawParams] = splitUnquoted(line.slice(0, i), ';');
  const params = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

/** TEXT values: \\ \; \, and \n escapes. */
export const unescapeText = v => v.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

/** DTSTART for display and order: "2026-11-17 10:00", "2026-11-17 09:00 UTC" or "2026-11-17". */
function icsWhen(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{0,2}(Z)?)?/.exec(value.trim());
  if (!m) return undefined;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4] || params.VALUE === 'DATE') return date;
  return `${date} ${m[4]}:${m[5]}${m[6] ? ' UTC' : params.TZID ? ` ${params.TZID}` : ''}`;
}

/** The VEVENTs of a calendar (alarms and other nested parts ignored), cancelled ones left out. */
export function parseIcs(text) {
  const events = [];
  const stack = [];
  let cur;
  for (const line of contentLines(text)) {
    if (!line.trim()) continue;
    const p = parseProperty(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      stack.push(p.value.trim().toUpperCase());
      if (stack.at(-1) === 'VEVENT') cur = {};
      continue;
    }
    if (p.name === 'END') {
      if (stack.pop() === 'VEVENT' && cur) events.push(cur);
      if (!stack.includes('VEVENT')) cur = undefined;
      continue;
    }
    if (!cur || stack.at(-1) !== 'VEVENT') continue;
    if (p.name === 'SUMMARY') cur.summary = unescapeText(p.value).trim();
    else if (p.name === 'LOCATION') cur.location = unescapeText(p.value).trim();
    else if (p.name === 'STATUS') cur.status = p.value.trim().toUpperCase();
    else if (p.name === 'DTSTART') cur.when = icsWhen(p.value, p.params);
    else if (p.name === 'X-APPLE-STRUCTURED-LOCATION' && p.params['X-TITLE']) cur.placeTitle = unescapeText(p.params['X-TITLE']).split('\n')[0].trim();
  }
  return events.filter(e => e.status !== 'CANCELLED');
}

/** The place in a LOCATION (or Apple's place title): its first part, unless that is a street address or a link. */
function locationName(location) {
  const first = location.replace(LINK, ' ').split('\n').map(s => s.trim()).find(Boolean) ?? '';
  const parts = first.split(/\s*,\s*/).map(tidy);
  const name = parts[0] ?? '';
  const street = /^(c\/|calle|c\.|avda\.?|avenida|av\.|paseo|pasaje|ronda|carretera|ctra\.?|street|st\.|road|rd\.|carrer|r[uú]a)(\s|$)/i;
  if (!name || /\d/.test(name) || street.test(name)) return undefined;
  if (/^(\d+[a-z]?|s\/n)$/i.test(parts[1] ?? '')) return undefined; // "Plaza de San Marcos, 10": an address
  return name.replace(/\([^)]*\)/g, '').trim();
}

/** Candidate names for one event, most precise first. */
function eventCandidates(ev) {
  const out = [];
  if (ev.placeTitle) out.push(locationName(ev.placeTitle)); // an address-only pin has the street as its title
  if (ev.location) out.push(locationName(ev.location));
  if (ev.summary) out.push(...phraseNames(ev.summary));
  return out.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Text

function stripHeading(line) {
  let t = line.replace(/^(?:[-*•·▪◦>]+|\d{1,2}[.)])\s+/, '').trim();
  for (let i = 0; i < 6; i++) {
    const next = t.replace(HEADING, '').trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

// ---------------------------------------------------------------------------
// The pack

/**
 * text -> the pack place it names, or undefined. Mirrors the exact-name step of the app's
 * PackIndex.findPlace (the longest place name inside the text), plus a distinctive fragment of
 * exactly one place's name.
 */
export function packMatcher(places, cityNames = []) {
  const cities = ['sevilla', 'seville', ...cityNames.flatMap(words)];
  const drop = new RegExp(`\\b(de|del|la|el|los|las|of|the|real|${[...new Set(cities)].join('|')})\\b`, 'g');
  const index = places.map(place => ({
    place,
    names: [place.name, place.localName, ...(place.aliases ?? [])]
      .filter(Boolean)
      .flatMap(n => {
        const f = fold(n);
        const short = f.replace(drop, ' ').replace(/\s+/g, ' ').trim();
        return short && short !== f && short.length >= 4 ? [f, short] : [f];
      }),
  }));
  return text => {
    const t = fold(text);
    if (!t.trim()) return undefined;
    let best;
    for (const { place, names } of index) for (const n of names) if (t.includes(n) && (!best || n.length > best.len)) best = { place, len: n.length };
    if (best) return best.place;
    const tw = words(text);
    if (!tw.some(w => w.length >= 5 && !NON_NAME.has(w))) return undefined;
    const phrase = ` ${tw.join(' ')} `;
    const hits = index.filter(({ names }) => names.some(n => ` ${words(n).join(' ')} `.includes(phrase)));
    return hits.length === 1 ? hits[0].place : undefined;
  };
}

/**
 * What an itinerary names. Each entry is one event (.ics) or one phrase (text) with its candidate
 * names, most precise first: `known` when it is in the pack, `skipped` when it is travel or has no
 * name worth looking up. `lookups` are the distinct names to look up, at most `maxLookups`.
 */
export function itineraryPlaces(text, places, { cityNames = [], maxLookups = 40 } = {}) {
  const kind = /BEGIN:VCALENDAR/i.test(text) ? 'ics' : 'text';
  const inPack = packMatcher(places, cityNames);
  const entries = [];
  if (kind === 'ics') {
    const events = parseIcs(text).sort((a, b) => (a.when ?? '').localeCompare(b.when ?? ''));
    for (const ev of events) {
      const label = ev.summary || ev.location || '(no title)';
      if (TRAVEL.test(ev.summary ?? '')) {
        entries.push({ label, when: ev.when, candidates: [], skipped: 'travel' });
        continue;
      }
      // The most precise name decides: "Ayuntamiento de Sevilla, Plaza Nueva, 1" is the city hall
      // (to look up), not the pack's Plaza Nueva. Later names are fallbacks for the lookup. Only an
      // event with no name at all is matched on its whole LOCATION or SUMMARY ("Calle Betis 12").
      let known;
      const lookup = [];
      for (const c of eventCandidates(ev)) {
        const p = inPack(c);
        if (p && !lookup.length) {
          known = p;
          break;
        }
        if (!p && isPlaceName(c) && !lookup.some(x => words(x).join(' ') === words(c).join(' '))) lookup.push(c);
      }
      if (!known && !lookup.length) known = [ev.location, ev.summary].filter(Boolean).map(inPack).find(Boolean);
      entries.push({ label, when: ev.when, candidates: known ? [] : lookup.slice(0, 3), known: known?.id });
    }
  } else {
    for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
      const line = stripHeading(raw.trim());
      if (!line) continue;
      for (const name of phraseNames(line)) {
        // "Flight IB3107 Madrid to Seville", "Train to Cordoba": travel, as in a calendar.
        if (TRAVEL.test(name)) {
          entries.push({ label: raw.trim(), candidates: [], skipped: 'travel' });
          continue;
        }
        const known = inPack(name);
        // "Tapas in Triana: Casa Cuesta": the place follows the colon. The whole phrase is matched
        // against the pack first, so "Alcázar: gardens" stays the Alcázar.
        const after = tidy(name.split(/:\s+/).at(-1));
        const lookup = !known && after !== name && isPlaceName(after) ? after : name;
        entries.push({ label: raw.trim(), candidates: isPlaceName(lookup) ? [lookup] : [], known: (known ?? (lookup !== name ? inPack(lookup) : undefined))?.id });
      }
    }
  }
  for (const e of entries) if (!e.known && !e.skipped && !e.candidates.length) e.skipped = 'no place name';
  const seen = new Set();
  const lookups = [];
  for (const e of entries) {
    if (e.known || e.skipped) continue;
    for (const c of e.candidates) {
      const key = words(c).join(' ');
      if (seen.has(key)) continue;
      seen.add(key);
      lookups.push(c);
    }
  }
  return { kind, entries, lookups: lookups.slice(0, maxLookups), dropped: Math.max(0, lookups.length - maxLookups) };
}

// ---------------------------------------------------------------------------
// Merging what OpenStreetMap found (scripts/fetch-places.mjs --match) into places.json

function km(a, b) {
  const rad = x => (x * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function addAlias(place, name) {
  const own = [place.name, place.localName, ...(place.aliases ?? [])].map(n => words(n).join(' '));
  if (own.includes(words(name).join(' '))) return false;
  place.aliases = [...(place.aliases ?? []), name];
  return true;
}

/**
 * Adds the places found for an itinerary's entries to `places` (in place). `found` maps each
 * looked-up name to fetch-places' draft or null. Per entry the first candidate found wins; a
 * draft that is a pack place under another name (its OpenStreetMap name matches and it is within
 * 150 m) only gives that place the itinerary's wording as an alias. New places get the wording as
 * an alias when it differs from their names, the neighbourhood of the nearest pack place within
 * 300 m, hours {} when OpenStreetMap's could not be read, and needsReview: true.
 */
export function mergeFound(places, entries, found, { cityNames = [] } = {}) {
  const original = [...places];
  const inPack = packMatcher(original, cityNames);
  const ids = new Set(places.map(p => p.id));
  const byRef = new Map(); // OSM element -> place added this run
  const added = [];
  const aliased = [];
  const notFound = [];
  for (const e of entries) {
    if (e.known || e.skipped) continue;
    const hit = e.candidates.map(c => ({ name: c, draft: found.get(words(c).join(' ')) })).find(x => x.draft);
    if (!hit) {
      if (e.candidates.length && !notFound.includes(e.candidates[0])) notFound.push(e.candidates[0]);
      continue;
    }
    const { name, draft } = hit;
    const ref = draft.osm?.ref;
    if (ref && byRef.has(ref)) {
      addAlias(byRef.get(ref), name);
      continue;
    }
    const existing = [draft.name, draft.localName].filter(Boolean).map(inPack).find(p => p && km(p.point, draft.point) <= 0.15);
    if (existing) {
      if (addAlias(existing, name)) aliased.push({ name, placeId: existing.id });
      continue;
    }
    const base = draft.id || slug(draft.name) || slug(ref ?? '') || 'place'; // a name in another script slugs to ""
    let id = base;
    for (let i = 2; ids.has(id); i++) id = `${base}-${i}`;
    ids.add(id);
    const near = original
      .filter(p => p.neighborhood)
      .map(p => ({ p, d: km(p.point, draft.point) }))
      .sort((a, b) => a.d - b.d)[0];
    const own = [draft.name, draft.localName].filter(Boolean).map(n => words(n).join(' '));
    const place = {
      id,
      name: draft.name,
      ...(draft.localName ? { localName: draft.localName } : {}),
      ...(own.includes(words(name).join(' ')) ? {} : { aliases: [name] }),
      category: draft.category,
      point: draft.point,
      ...(near && near.d <= 0.3 ? { neighborhood: near.p.neighborhood } : {}),
      tags: draft.tags,
      indoor: draft.indoor,
      visitMinutes: draft.visitMinutes,
      hours: draft.hours ?? {},
      ...(draft.price !== undefined ? { price: draft.price } : {}),
      summary: draft.summary,
      needsReview: true,
      osm: draft.osm,
    };
    places.push(place);
    byRef.set(ref, place);
    added.push(id);
  }
  return { added, aliased, notFound };
}

/** A place summary from its Wikipedia fact: the lead's first sentence or two, at most `max` characters. */
export function summaryFromFact(body, max = 240) {
  const text = (body ?? '')
    .replace(/\s*\((?:Spanish|in Spanish|Spanish pronunciation|lit\.|Arabic|Latin)[^()]*(?:\([^()]*\)[^()]*)*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z0-9¿¡"“(])/);
  let out = sentences[0] ?? '';
  for (const s of sentences.slice(1)) {
    if (out.length >= 90 || `${out} ${s}`.length > max) break;
    out = `${out} ${s}`;
  }
  if (out.length <= max) return out;
  const space = out.lastIndexOf(' ', max - 1);
  return `${out.slice(0, space > 0 ? space : max - 1).replace(/[,;:]$/, '')}…`;
}

// ---------------------------------------------------------------------------
// Command line: a dry run, offline

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--dest');
  const destId = at >= 0 ? argv.splice(at, 2)[1] : 'seville';
  const file = argv[0];
  if (!file) {
    console.error('Usage: node scripts/itinerary.mjs <trip.ics | itinerary.txt> [--dest seville]');
    process.exit(1);
  }
  const packDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'app/src/pack', destId);
  const places = JSON.parse(readFileSync(join(packDir, 'places.json'), 'utf8'));
  const dest = JSON.parse(readFileSync(join(packDir, 'destination.json'), 'utf8'));
  const r = itineraryPlaces(readItinerary(file), places, { cityNames: [dest.name] });
  console.log(`${file}: ${r.kind === 'ics' ? 'iCalendar' : 'text'}, ${r.entries.length} ${r.kind === 'ics' ? 'event' : 'phrase'}${r.entries.length === 1 ? '' : 's'}`);
  for (const e of r.entries) {
    const what = e.known ? `in the pack: ${e.known}` : e.skipped ? `skipped (${e.skipped})` : `to look up: ${e.candidates.map(c => `"${c}"`).join(' or ')}`;
    console.log(`  ${(e.when ?? '').padEnd(22)} ${e.label.slice(0, 48).padEnd(48)} ${what}`);
  }
  console.log(`\n${r.lookups.length} name${r.lookups.length === 1 ? '' : 's'} to look up${r.dropped ? ` (${r.dropped} more left out)` : ''}: ${r.lookups.join('; ') || 'none'}`);
}
