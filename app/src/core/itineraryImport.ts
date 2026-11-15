import { distanceMeters } from './geo';
import { fold, type PackIndex } from './pack';
import { addDays, daysBetween, WEEKDAY_NAMES, weekday } from './time';
import { sortStops, TripPlanner, type TripDraft } from './trip';
import type { ChatRequest, GeoPoint, Interest, JSONSchema, LLMClient, Place, Stop, Trip } from './types';

// Itinerary import: a calendar file (.ics) or pasted itinerary text becomes a Trip.
//
// A calendar file is read in plain code, no model: every event becomes a fixed stop, its place
// matched to the pack by name. Pasted text goes through the same path as trip setup by voice
// (TripPlanner.extract, then resolveDraft), one day at a time, so each call stays within the
// trip schema's 12 stops and 700 tokens. Names that match no pack place come back in
// `unmatched`, for `node scripts/prepare-pack.mjs --itinerary <file>` to add while online.

/** What every import returns. */
export interface ImportResult {
  trip: Trip;
  /** Place names from the itinerary that are not in the pack (for the prepare step). */
  unmatched: string[];
  /** Things the traveller should know: dropped events, converted time zones, failed days. */
  warnings: string[];
}

export type ItineraryKind = 'ics' | 'text';

/** 'ics' for an iCalendar file, else 'text'. */
export function detect(text: string): ItineraryKind {
  return /BEGIN:(VCALENDAR|VEVENT)\b/i.test(text) ? 'ics' : 'text';
}

/** The app plans up to 14 days (TRIP_SCHEMA's maximum). */
export const MAX_TRIP_DAYS = 14;

export interface IcsImportOptions {
  /** Destination date (YYYY-MM-DD) used as day 1 when the file has no events. Defaults to now at the destination. */
  today?: string;
  /** Interests for the trip; a calendar file says nothing about them. */
  interests?: Interest[];
  /** Shown in the trip's description ("Imported from trip.ics"). */
  fileName?: string;
}

export interface TextImportDeps {
  llm: LLMClient;
  index: PackIndex;
  /** Destination date (YYYY-MM-DD): day 1 when the text gives no dates, as in trip setup by voice. */
  today: string;
  /** Called before the first model call and after each one. */
  onProgress?: (done: number, total: number) => void;
  /** Stops between model calls when aborted (an AbortController's signal fits). */
  signal?: { readonly aborted: boolean };
}

/** detect(), then importIcs or importText. */
export async function importItinerary(
  text: string,
  deps: TextImportDeps & { fileName?: string; interests?: Interest[] },
): Promise<ImportResult> {
  if (detect(text) === 'ics') {
    deps.onProgress?.(0, 1);
    const result = importIcs(text, deps.index, { today: deps.today, interests: deps.interests, fileName: deps.fileName });
    deps.onProgress?.(1, 1);
    return result;
  }
  return importText(text, deps);
}

// ===========================================================================
// Names: matching to the pack, and which names are worth sending to the prepare step

// Words that never identify a place on their own, for the name checks below.
const FILLER = new Set('a an the of and y e de del la las el los en di du le real'.split(' '));

// Words that describe an activity or a kind of place rather than name one.
const GENERIC_WORDS = new Set(
  (
    'a an the my our some at to of and with for in on de la el los las del y en con ' +
    'museum museo ticket tickets visit tour booking reservation entry church gallery exhibition show concert ' +
    'dinner lunch breakfast brunch drinks coffee restaurant bar tapas market park palace garden gardens ' +
    'free time day morning afternoon evening night walk walking stroll explore exploring relax rest ' +
    'sightseeing shopping hotel check checkin checkout out guided meeting point ' +
    'airbnb apartment apartamento flat room hostel hostal accommodation'
  ).split(' '),
);

// Travel legs: a flight number is no place to fetch.
const TRANSPORT = /\b(flights?|vuelos?|fly|train|tren|renfe|ave|bus|autobus|coach|ferry|transfer|taxi|uber|cabify|car rental|rental car|airport|aeropuerto|departure|arrival|depart|arrive|landing|boarding)\b/;

// Where the traveller sleeps: becomes the trip's base.
const LODGING = /\b(hotel|hostal|hostel|airbnb|apartment|apartamento|accommodation|alojamiento|check[- ]?in|check[- ]?out|stay(ing)? at|b&b|bed and breakfast|guest ?house|posada|parador)\b/;

// Words a whole-trip event uses ("Seville trip 2026").
const TRIP_WORDS = new Set(
  'trip holiday holidays vacation vacations vacaciones viaje travel travelling weekend break getaway escapada visit to in a en de the my our city'.split(' '),
);

const STREET_START =
  /^(calle|c\/|avenida|avda|av|paseo|ronda|plaza|pza|pl|carrer|rua|rue|via|street|st|road|rd|avenue|ave|glorieta|pasaje|callejon|camino|carretera|cuesta|travesia)\b/;

function words(s: string): string[] {
  return fold(s)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** A street address, postcode or link ("Calle Betis 12", "41004 Sevilla", "s/n", a video-call URL), not a venue's name. */
function isAddress(s: string): boolean {
  const f = fold(s).trim();
  if (/^([a-z][a-z0-9+.-]*:\/\/|www\.|mailto:|tel:)/.test(f)) return true;
  if (/\bs\/n\b/.test(f) || /\b\d{5}\b/.test(f)) return true;
  return /\d/.test(f) && (/^\d/.test(f) || STREET_START.test(f));
}

function isGeneric(name: string): boolean {
  return words(name).every(w => GENERIC_WORDS.has(w) || /^\d+$/.test(w));
}

/** "Sevilla", "Seville", "Spain": the destination itself rather than a place in it. */
function isDestinationWord(word: string, index: PackIndex, cityOnly = false): boolean {
  // "Sevilla" is "Seville": same first four letters, about the same length.
  const near = (t: string) => t === word || (word.length >= 5 && t.length >= 5 && t.slice(0, 4) === word.slice(0, 4) && Math.abs(t.length - word.length) <= 2);
  return [...words(index.destination.name), ...(cityOnly ? [] : words(index.destination.country))].some(near);
}

/**
 * A full address in another town ("Mezquita-Catedral de Córdoba, …, 14003 Córdoba, Spain"; Google
 * exports no coordinates): a postcode town, and the destination named nowhere in it. Without this,
 * "Catedral" in a Córdoba address would find Seville's cathedral.
 */
function addressElsewhere(location: string, index: PackIndex): boolean {
  if (!/(?:^|[,\n])\s*\d{5}\s+[^\d,\n]{2,}/.test(location)) return false;
  return !words(location).some(w => isDestinationWord(w, index, true));
}

/** An event that is the trip itself ("Seville trip", "Holiday"): it spans days but is no stop. */
function isTripItself(summary: string, index: PackIndex): boolean {
  const all = words(summary);
  const rest = all.filter(w => !TRIP_WORDS.has(w) && !/^\d+$/.test(w));
  return all.length > 0 && rest.every(w => isDestinationWord(w, index));
}

/** A name worth looking up while online: specific, not a travel leg, not the city. */
function usableName(name: string | undefined, index: PackIndex): string | undefined {
  const n = name?.replace(/\s+/g, ' ').replace(/^[\s,.;:–—-]+|[\s,.;:–—-]+$/g, '');
  if (!n || n.length < 3 || n.length > 80 || isGeneric(n) || isAddress(n)) return undefined;
  const f = fold(n);
  if (TRANSPORT.test(f)) return undefined;
  if (words(n).every(w => isDestinationWord(w, index) || FILLER.has(w))) return undefined;
  return n;
}

/**
 * The place name in an event title: "Dinner at Casa Román" gives "Casa Román", "Tickets: Real
 * Alcázar" gives "Real Alcázar", "Mercado de Feria" stays. A title with no name in it ("Late
 * drinks": no capital after the first word) gives "". Bracketed notes and booking references go.
 */
export function nameInTitle(title: string): string {
  let t = title
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\s+[-–—|]\s+(ref|booking|confirmation|conf|reserva|localizador)\b.*$/i, '')
    .replace(/#\s*\w+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // People are no place: "Dinner at Casa Román with Ana", "Coffee with Juan".
  const withoutPeople = (s: string) => s.replace(/\s+(?:with|con)\s+.*$/i, '').trim();
  // "at"/"@"/"in"/"en" followed by a capitalised name.
  const at = /(?:^|\s)(?:at|@|in|en)\s+([A-ZÁÉÍÓÚÑÜ].*)$/.exec(t);
  if (at) return withoutPeople(at[1]);
  t = withoutPeople(t);
  // "Meet Ana", "Call with the hotel": a person or a call, not a place.
  if (/^(?:meet(?:ing)?|call|catch[- ]up|pick[- ]up|drop[- ]off)\b(?!\s+point\b)/i.test(t)) return '';
  const lead =
    /^(?:(?:guided\s+)?tour(?:\s+of)?|visit(?:ing)?(?:\s+to)?|tickets?(?:\s+(?:for|to))?|entry(?:\s+to)?|entrance(?:\s+to)?|booking(?:\s+(?:at|for))?|reservation(?:\s+(?:at|for))?|meet(?:ing)?\s+point|dinner|lunch|breakfast|brunch|drinks|tapas|flamenco\s+show|show|concert|mass|explore|walk(?:\s+(?:around|through|along))?)\b\s*[:\-–—]?\s*/i;
  const before = t;
  for (let i = 0; i < 3 && lead.test(t); i++) t = t.replace(lead, '');
  // "Concert in the Cathedral" leaves "in the Cathedral": the name is "Cathedral".
  t = t.replace(/^[\s:–—-]+/, '').replace(/^(?:at|in|en|@|to|of|for|on)\s+/i, '').replace(/^the\s+/i, '').trim();
  if (t !== before) return t;
  return /\s[A-ZÁÉÍÓÚÑÜ]/.test(t) ? t : '';
}

/** The lodging's own name in where they stay: "Hotel Casa 1800 in Santa Cruz" gives "Hotel Casa 1800". */
function lodgingName(where: string): string | undefined {
  if (!LODGING.test(fold(where))) return undefined;
  return where.split(/,|\s+(?:in|near|on|by|at|close to|next to|en|cerca de|junto a)\s+/i)[0].trim() || undefined;
}

/**
 * Fuzzy search finds near names, and some wrong ones ("Seville airport" lands on the cathedral).
 * A fuzzy hit counts only when one of the place's names is all in the text, or the text's words
 * (at least two) are all in one of its names.
 */
function confirmFuzzy(place: Place, text: string, index: PackIndex): boolean {
  const query = words(text).filter(w => !FILLER.has(w));
  const querySet = new Set(query);
  const namesOf = (p: Place) => [p.name, p.localName, ...(p.aliases ?? [])].filter((n): n is string => !!n);
  for (const name of namesOf(place)) {
    const own = words(name).filter(w => !FILLER.has(w) && !isDestinationWord(w, index));
    if (own.length && own.every(w => querySet.has(w))) return true;
    const ownSet = new Set(words(name));
    if (query.length >= 2 && query.every(w => ownSet.has(w))) return true;
    // One distinctive word ("Maestranza", "Las Setas"): only when no other place's name has it
    // ("Triana" is a market, a bridge and a ceramics centre).
    const [w] = query;
    if (query.length === 1 && w.length >= 5 && ownSet.has(w) && !GENERIC_WORDS.has(w) && !isDestinationWord(w, index)) {
      if (!index.pack.places.some(p => p.id !== place.id && namesOf(p).some(n => words(n).includes(w)))) return true;
    }
  }
  return false;
}

/** True when `text` really names `place`: one of its names is in it, or a fuzzy hit passes confirmFuzzy. */
function nameConfirms(place: Place, text: string, index: PackIndex): boolean {
  return index.findPlace(text, { fuzzy: false })?.id === place.id || confirmFuzzy(place, text, index);
}

/** Exact names first (index.findPlace without fuzzy, which also knows local names), then confirmed fuzzy hits. */
function matchPlace(index: PackIndex, candidates: { text?: string; fuzzy: boolean }[]): Place | undefined {
  const usable = candidates.filter((c): c is { text: string; fuzzy: boolean } => !!c.text && !!c.text.trim());
  for (const c of usable) {
    const p = index.findPlace(c.text, { fuzzy: false });
    if (p) return p;
  }
  for (const c of usable) {
    if (!c.fuzzy || isGeneric(c.text) || isAddress(c.text)) continue;
    const p = index.findPlace(c.text);
    if (p && confirmFuzzy(p, c.text, index)) return p;
  }
  return undefined;
}

function addName(list: string[], name: string | undefined): void {
  if (name && !list.some(n => fold(n) === fold(name))) list.push(name);
}

function destinationToday(index: PackIndex): string {
  return new Date(Date.now() + index.destination.utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

let idCounter = 0;
const newStopId = () => `import-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const m = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// ===========================================================================
// iCalendar (RFC 5545)

interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface IcsComponent {
  type: string;
  props: IcsProp[];
  children: IcsComponent[];
}

/** Undoes line folding: a line starting with a space or tab continues the one before. */
export function unfoldIcs(text: string): string[] {
  const out: string[] = [];
  let lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  // Pasted from an email or a quote, every line may carry the same indent: take it off first,
  // or the whole file would read as one folded line.
  const indent = /^([ \t]+)BEGIN:/i.exec(lines.find(l => l.trim()) ?? '')?.[1];
  if (indent) lines = lines.map(l => (l.startsWith(indent) ? l.slice(indent.length) : l));
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out.filter(l => l.trim() !== '');
}

/** TEXT values: "\," "\;" "\\" and "\n". */
export function unescapeIcsText(value: string): string {
  return value.replace(/\\(.)/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

function splitOutsideQuotes(s: string, sep: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  for (const c of s) {
    if (c === '"') quoted = !quoted;
    if (c === sep && !quoted) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  return parts;
}

function parseContentLine(line: string): IcsProp | undefined {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return undefined;
  const [rawName, ...rawParams] = splitOutsideQuotes(line.slice(0, colon), ';');
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  // Grouped names ("item1.X-ABLABEL") keep only the name.
  const name = rawName.trim().toUpperCase().replace(/^[^.]*\./, '');
  return { name, params, value: line.slice(colon + 1) };
}

function parseComponents(text: string): IcsComponent {
  const root: IcsComponent = { type: 'ROOT', props: [], children: [] };
  const stack = [root];
  for (const line of unfoldIcs(text)) {
    const prop = parseContentLine(line);
    if (!prop) continue;
    const top = stack[stack.length - 1];
    if (prop.name === 'BEGIN') {
      const c: IcsComponent = { type: prop.value.trim().toUpperCase(), props: [], children: [] };
      top.children.push(c);
      stack.push(c);
    } else if (prop.name === 'END') {
      const type = prop.value.trim().toUpperCase();
      const at = stack.map(c => c.type).lastIndexOf(type);
      if (at > 0) stack.length = at;
    } else top.props.push(prop);
  }
  return root;
}

function allOf(c: IcsComponent, type: string): IcsComponent[] {
  return c.children.flatMap(ch => (ch.type === type ? [ch] : allOf(ch, type)));
}

const prop = (c: IcsComponent, name: string) => c.props.find(p => p.name === name);
const textOf = (c: IcsComponent, name: string) => {
  const p = prop(c, name);
  return p ? unescapeIcsText(p.value).trim() : '';
};

/** A DATE or DATE-TIME value as written: wall time, UTC (Z) or in a named zone. */
interface IcsTime {
  date: string;
  /** Minutes since midnight; undefined for an all-day DATE. */
  minute?: number;
  utc?: boolean;
  tzid?: string;
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const isoDate = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;

function parseIcsTime(p: IcsProp | undefined): IcsTime | undefined {
  if (!p) return undefined;
  const v = p.value.trim();
  const m =
    /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(?:\d{2})?(Z)?)?$/i.exec(v) ??
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?(Z)?)?$/i.exec(v);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!validDate(y, mo, d)) return undefined;
  const date = isoDate(y, mo, d);
  if (m[4] === undefined || p.params.VALUE === 'DATE') return { date };
  const minute = Math.min(23, Number(m[4])) * 60 + Math.min(59, Number(m[5]));
  return m[6] ? { date, minute, utc: true } : { date, minute, tzid: p.params.TZID };
}

/** RFC 5545 DURATION ("PT1H30M", "P1D", "P2W") in minutes. */
export function parseIcsDuration(value: string): number | undefined {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value.trim());
  if (!m || value.trim().length <= 2) return undefined;
  const n = (i: number) => Number(m[i] ?? 0);
  const minutes = n(2) * 10080 + n(3) * 1440 + n(4) * 60 + n(5) + Math.floor(n(6) / 60);
  return m[1] === '-' ? -minutes : minutes;
}

const toEpochMinutes = (date: string, minute = 0) => Date.parse(`${date}T00:00:00Z`) / 60_000 + minute;
function fromEpochMinutes(epoch: number): { date: string; minute: number } {
  const d = new Date(epoch * 60_000);
  return { date: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

function parseOffset(v: string | undefined): number | undefined {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec((v ?? '').trim());
  if (!m) return undefined;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

// --- Time zones -------------------------------------------------------------

interface TzRule {
  from: number;
  to: number;
  /** DTSTART as wall minutes since 1970. */
  start: number;
  rrule?: Record<string, string>;
  rdates: number[];
}

function tzRules(vtz: IcsComponent): TzRule[] {
  const rules: TzRule[] = [];
  for (const sub of vtz.children) {
    if (sub.type !== 'STANDARD' && sub.type !== 'DAYLIGHT') continue;
    const to = parseOffset(prop(sub, 'TZOFFSETTO')?.value);
    const start = parseIcsTime(prop(sub, 'DTSTART'));
    if (to === undefined || !start) continue;
    const from = parseOffset(prop(sub, 'TZOFFSETFROM')?.value) ?? to;
    const rr = prop(sub, 'RRULE')?.value;
    const rrule = rr
      ? Object.fromEntries(rr.split(';').map(kv => kv.split('=') as [string, string]).map(([k, v]) => [k.toUpperCase(), v ?? '']))
      : undefined;
    const rdates = sub.props
      .filter(p => p.name === 'RDATE')
      .flatMap(p => p.value.split(',').map(v => parseIcsTime({ ...p, value: v })))
      .filter((t): t is IcsTime => !!t)
      .map(t => toEpochMinutes(t.date, t.minute));
    rules.push({ from, to, start: toEpochMinutes(start.date, start.minute), rrule, rdates });
  }
  return rules;
}

/** Day of the month of the n-th weekday (n < 0 counts from the end). */
function nthWeekday(year: number, month: number, n: number, wd: number): number {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
  }
  const lastWd = new Date(Date.UTC(year, month - 1, last)).getUTCDay();
  return last - ((lastWd - wd + 7) % 7) + (n + 1) * 7;
}

const RRULE_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** When a rule's offset starts in a year, as wall minutes (yearly rules as VTIMEZONEs write them). */
function onsetsIn(rule: TzRule, year: number): number[] {
  const startInfo = fromEpochMinutes(rule.start);
  const startYear = Number(startInfo.date.slice(0, 4));
  if (!rule.rrule || rule.rrule.FREQ !== 'YEARLY') return [rule.start, ...rule.rdates];
  if (year < startYear) return [];
  const until = rule.rrule.UNTIL ? parseIcsTime({ name: 'UNTIL', params: {}, value: rule.rrule.UNTIL }) : undefined;
  const months = rule.rrule.BYMONTH ? rule.rrule.BYMONTH.split(',').map(Number) : [Number(startInfo.date.slice(5, 7))];
  const monthDays = rule.rrule.BYMONTHDAY ? rule.rrule.BYMONTHDAY.split(',').map(Number) : [];
  const out: number[] = [];
  for (const month of months) {
    let day = Number(startInfo.date.slice(8, 10));
    const byday = /^([+-]?\d)?([A-Z]{2})$/.exec((rule.rrule.BYDAY ?? '').split(',')[0].toUpperCase());
    if (byday) {
      const wd = RRULE_DAYS.indexOf(byday[2]);
      if (byday[1]) day = nthWeekday(year, month, Number(byday[1]), wd);
      else {
        const candidates = monthDays.length ? monthDays : Array.from({ length: 31 }, (_, i) => i + 1);
        day = candidates.find(d => validDate(year, month, d) && new Date(Date.UTC(year, month - 1, d)).getUTCDay() === wd) ?? day;
      }
    } else if (monthDays.length) day = monthDays[0];
    if (!validDate(year, month, day)) continue;
    const onset = toEpochMinutes(isoDate(year, month, day), startInfo.minute);
    if (onset < rule.start) continue;
    if (until && onset > toEpochMinutes(until.date, until.minute ?? 1439)) continue;
    out.push(onset);
  }
  return out;
}

function offsetFromRules(rules: TzRule[], wall: number): number | undefined {
  if (!rules.length) return undefined;
  const year = Number(fromEpochMinutes(wall).date.slice(0, 4));
  let best: { at: number; to: number } | undefined;
  for (const rule of rules) {
    for (const at of [...onsetsIn(rule, year - 1), ...onsetsIn(rule, year)]) {
      if (at <= wall && (!best || at > best.at)) best = { at, to: rule.to };
    }
  }
  if (best) return best.to;
  // Before every rule began: the earliest rule's offset before it.
  return [...rules].sort((a, b) => a.start - b.start)[0].from;
}

let intlWorks: boolean | undefined;

/** Offset of an IANA zone at a UTC instant, through Intl; undefined where the engine lacks zone data. */
function intlOffset(tz: string, utcMinutes: number): number | undefined {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    const parts: Record<string, number> = {};
    for (const p of dtf.formatToParts(new Date(utcMinutes * 60_000))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
    const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute) / 60_000;
    const off = Math.round(wall - utcMinutes);
    return Number.isFinite(off) && Math.abs(off) <= 18 * 60 ? off : undefined;
  } catch {
    return undefined;
  }
}

/** True when Intl really applies time zones (an engine that ignores the option would give the Mac's own). */
function intlHasZones(): boolean {
  if (intlWorks === undefined) {
    const t = Date.UTC(2026, 0, 15) / 60_000;
    intlWorks = intlOffset('Asia/Kolkata', t) === 330 && intlOffset('UTC', t) === 0;
  }
  return intlWorks;
}

class Zones {
  private readonly rules = new Map<string, TzRule[]>();

  constructor(calendar: IcsComponent) {
    for (const vtz of allOf(calendar, 'VTIMEZONE')) {
      const id = textOf(vtz, 'TZID');
      if (id) this.rules.set(id, tzRules(vtz));
    }
  }

  /** Minutes east of UTC in zone `tzid` at a wall time there; undefined when unknown. */
  offsetAtWall(tzid: string, wall: number): number | undefined {
    const rules = this.rules.get(tzid);
    const fromFile = rules && offsetFromRules(rules, wall);
    if (fromFile !== undefined) return fromFile;
    if (/^(utc|gmt|z|etc\/(utc|gmt|zulu))$/i.test(tzid)) return 0;
    // "/mozilla.org/20050126_1/Europe/Madrid" → "Europe/Madrid".
    const iana = /([A-Za-z]+\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?)$/.exec(tzid)?.[1];
    if (iana && intlHasZones()) {
      const first = intlOffset(iana, wall);
      if (first !== undefined) return intlOffset(iana, wall - first) ?? first;
    }
    // "(UTC+01:00) Brussels, Copenhagen, Madrid, Paris": a fixed offset, the best we have.
    const fixed = /(?:UTC|GMT)\s*([+-])(\d{1,2})(?::?(\d{2}))?/i.exec(tzid);
    if (fixed) return (fixed[1] === '-' ? -1 : 1) * (Number(fixed[2]) * 60 + Number(fixed[3] ?? 0));
    return undefined;
  }
}

/** A raw calendar event. Exported for the prepare script and tests. */
export interface IcsEvent {
  uid?: string;
  summary: string;
  location: string;
  description: string;
  start: IcsTime;
  end?: IcsTime;
  /** From DURATION, when there is no DTEND. */
  durationMinutes?: number;
  /** From GEO or Apple's structured location. */
  geo?: GeoPoint;
  /** Apple's X-TITLE: the place's name. */
  placeTitle?: string;
  cancelled: boolean;
  repeats: boolean;
}

function geoOf(ev: IcsComponent): GeoPoint | undefined {
  const g = /^\s*(-?\d+(?:\.\d+)?)\s*[;,]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(prop(ev, 'GEO')?.value ?? '');
  if (g) return { lat: Number(g[1]), lon: Number(g[2]) };
  const apple = /geo:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i.exec(prop(ev, 'X-APPLE-STRUCTURED-LOCATION')?.value ?? '');
  if (apple) return { lat: Number(apple[1]), lon: Number(apple[2]) };
  return undefined;
}

/** The events of a calendar file, in file order. Events without a usable DTSTART are left out. */
export function parseIcsEvents(text: string): IcsEvent[] {
  return parseIcs(text).events;
}

function parseIcs(text: string): { events: IcsEvent[]; zones: Zones; calendarName: string; skipped: number } {
  const root = parseComponents(text);
  const calendar = allOf(root, 'VCALENDAR')[0] ?? root;
  const events: IcsEvent[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const ev of allOf(root, 'VEVENT')) {
    const start = parseIcsTime(prop(ev, 'DTSTART'));
    if (!start) {
      skipped++;
      continue;
    }
    const uid = textOf(ev, 'UID') || undefined;
    const key = `${uid ?? ''}|${prop(ev, 'DTSTART')?.value}|${textOf(ev, 'SUMMARY')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const durationProp = prop(ev, 'DURATION');
    const xTitle = prop(ev, 'X-APPLE-STRUCTURED-LOCATION')?.params['X-TITLE'];
    events.push({
      uid,
      summary: textOf(ev, 'SUMMARY'),
      location: textOf(ev, 'LOCATION'),
      description: textOf(ev, 'DESCRIPTION'),
      start,
      end: parseIcsTime(prop(ev, 'DTEND')),
      durationMinutes: durationProp ? parseIcsDuration(durationProp.value) : undefined,
      geo: geoOf(ev),
      placeTitle: xTitle ? unescapeIcsText(xTitle).trim() || undefined : undefined,
      cancelled: /^CANCELL?ED$/i.test(textOf(ev, 'STATUS')),
      repeats: !!prop(ev, 'RRULE') || !!prop(ev, 'RDATE'),
    });
  }
  return { events, zones: new Zones(calendar), calendarName: textOf(calendar, 'X-WR-CALNAME'), skipped };
}

/** Event descriptions as a short note: no HTML, no video-call boilerplate. */
function cleanNote(description: string): string | undefined {
  const t = description
    .split(/-::~:~::~|\n-{5,}/)[0]
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return undefined;
  return t.length > 240 ? `${t.slice(0, 237).trimEnd()}…` : t;
}

/** An event read against the pack, in destination time. */
interface PlannedEvent {
  ev: IcsEvent;
  date: string;
  minute?: number;
  /** Last destination date the event covers (its start date unless it spans days). */
  endDate: string;
  durationMinutes?: number;
  place?: Place;
  name?: string;
  outside: boolean;
  lodging: boolean;
  tripItself: boolean;
}

/**
 * Reads an iCalendar file into a trip, in plain code: each event is a fixed stop on its day, at
 * its time in destination time (UTC times use the pack's utcOffsetMinutes; TZID times go through
 * the file's VTIMEZONE, else Intl; floating times are taken as destination time). Places are
 * matched from LOCATION, then SUMMARY. Hotel stays become the trip's base. Events that match no
 * pack place give their names to `unmatched`, and a stop without a place when they have a time.
 */
export function importIcs(text: string, index: PackIndex, opts: IcsImportOptions = {}): ImportResult {
  const dest = index.destination;
  const destOffset = dest.utcOffsetMinutes;
  const warnings: string[] = [];
  const unmatched: string[] = [];
  const { events, zones, calendarName, skipped } = parseIcs(text);
  const zoneNotes = new Map<string, string>();
  const unknownZones = new Set<string>();

  /** An event time in destination wall time. */
  const toLocal = (t: IcsTime): { date: string; minute?: number; epoch?: number } => {
    if (t.minute === undefined) return { date: t.date };
    const wall = toEpochMinutes(t.date, t.minute);
    let utc: number;
    if (t.utc) utc = wall;
    else if (t.tzid) {
      const off = zones.offsetAtWall(t.tzid, wall);
      if (off === undefined) {
        unknownZones.add(t.tzid);
        return { date: t.date, minute: t.minute, epoch: wall };
      }
      if (off !== destOffset && !zoneNotes.has(t.tzid)) {
        zoneNotes.set(t.tzid, `Times in ${t.tzid} (${offsetLabel(off)} on ${t.date}) were converted to ${dest.name} time (${offsetLabel(destOffset)}).`);
      }
      utc = wall - off;
    } else return { date: t.date, minute: t.minute, epoch: wall };
    const local = utc + destOffset;
    return { ...fromEpochMinutes(local), epoch: local };
  };

  let cancelled = 0;
  let repeating = 0;
  const outsideNames: string[] = [];
  const planned: PlannedEvent[] = [];
  for (const ev of events) {
    if (ev.cancelled) {
      cancelled++;
      continue;
    }
    if (ev.repeats) repeating++;
    const start = toLocal(ev.start);
    let endDate = start.date;
    let durationMinutes: number | undefined;
    if (start.minute === undefined) {
      // All-day: DTEND is the day after the last day.
      const endExclusive = ev.end ? ev.end.date : ev.durationMinutes ? addDays(start.date, Math.ceil(ev.durationMinutes / 1440)) : undefined;
      if (endExclusive && daysBetween(start.date, endExclusive) > 1) endDate = addDays(endExclusive, -1);
    } else {
      const end = ev.end && ev.end.minute !== undefined ? toLocal(ev.end) : undefined;
      const minutes = end?.epoch !== undefined && start.epoch !== undefined ? end.epoch - start.epoch : ev.durationMinutes;
      if (minutes !== undefined && minutes > 0) {
        if (minutes <= 12 * 60) durationMinutes = minutes;
        else if (start.epoch !== undefined) endDate = fromEpochMinutes(start.epoch + minutes - 1).date;
      }
    }

    // A travel leg ("Flight IB 1234", at "Terminal 4") names no place to add, and starting
    // somewhere else is what it does: it is no event outside the destination.
    const travel = TRANSPORT.test(fold(ev.summary));
    const outside = !travel && (ev.geo ? distanceMeters(ev.geo, dest.center) > 50_000 : addressElsewhere(ev.location, index));
    const firstLine = ev.location.split('\n')[0] ?? '';
    const locParts = firstLine.split(',').map(s => s.trim());
    const locName = locParts[0] || ev.placeTitle || '';
    // "Plaza de los Venerables, 1, 41004 Sevilla": a street and its number is an address, not a
    // venue, so the title's venue ("Dinner at Casa Román") is the name (as scripts/itinerary.mjs reads it).
    const streetAndNumber = !!locParts[0] && /^((n[º°o]\.?|no\.?)\s*)?\d+[a-z]?$|^s\/n$/i.test(locParts[1] ?? '');
    const locIsName = !!locName && !streetAndNumber && !isAddress(locName);
    const titleName = nameInTitle(ev.summary);
    let place = outside
      ? undefined
      : matchPlace(index, [
          { text: locIsName ? locName : undefined, fuzzy: true },
          { text: ev.placeTitle, fuzzy: true },
          { text: ev.summary, fuzzy: false },
          { text: titleName, fuzzy: true },
        ]);
    // A neighbourhood as the location ("Santa Cruz") with a venue in the title ("Dinner at Casa
    // Román"): the venue wins when the pack has it, and its name is kept for the prepare step when not.
    let venueName: string | undefined;
    if (place?.category === 'neighborhood') {
      const venue = matchPlace(index, [
        { text: ev.summary, fuzzy: false },
        { text: titleName, fuzzy: true },
      ]);
      if (venue && venue.category !== 'neighborhood') place = venue;
      else if (!venue && !travel) venueName = usableName(titleName, index);
    }
    const tripItself = !place && isTripItself(ev.summary, index) && (!locName || isTripItself(locName, index));
    // "Dinner" at a hotel's restaurant is a meal, not where they sleep.
    const summaryFolded = fold(ev.summary);
    const meal =
      /\b(dinner|lunch|brunch|drinks|cocktails?|cena|comida|almuerzo|desayuno|aperitivo|spa|massage)\b/.test(summaryFolded) ||
      (/\bbreakfast\b/.test(summaryFolded) && !/\bbed (and|&) breakfast\b/.test(summaryFolded));
    const lodging = place?.category === 'hotel' || (LODGING.test(fold(`${ev.summary} ${locName}`)) && !(meal && start.minute !== undefined));
    const name = place
      ? venueName
      : travel
        ? undefined
        : usableName(locIsName ? locName : undefined, index) ?? usableName(ev.placeTitle, index) ?? usableName(titleName, index);
    planned.push({ ev, date: start.date, minute: start.minute, endDate, durationMinutes, place, name, outside, lodging, tripItself });
  }

  // The trip's days: from the first event to the last, at most 14. A longer file keeps the
  // 14 days with the most events (pack places count double).
  let startDate = opts.today ?? destinationToday(index);
  let lastDate = startDate;
  let kept = planned;
  if (planned.length) {
    const first = planned.reduce((a, p) => (p.date < a ? p.date : a), planned[0].date);
    const last = planned.reduce((a, p) => (p.endDate > a ? p.endDate : a), planned[0].endDate);
    startDate = first;
    lastDate = last;
    if (daysBetween(first, last) + 1 > MAX_TRIP_DAYS) {
      let best: { start: string; score: number } | undefined;
      for (const s of [...new Set(planned.map(p => p.date))].sort()) {
        const e = addDays(s, MAX_TRIP_DAYS - 1);
        const score = planned.filter(p => p.date <= e && p.endDate >= s).reduce((n, p) => n + (p.place ? 2 : 1), 0);
        if (!best || score > best.score) best = { start: s, score };
      }
      startDate = best!.start;
      const windowEnd = addDays(startDate, MAX_TRIP_DAYS - 1);
      kept = planned.filter(p => p.date <= windowEnd && p.endDate >= startDate && (p.date >= startDate || p.tripItself || p.lodging));
      lastDate = kept.reduce((a, p) => (p.endDate > a ? p.endDate : a), startDate);
      if (lastDate > windowEnd) lastDate = windowEnd;
      const dropped = planned.length - kept.length;
      if (dropped) {
        warnings.push(
          `Left out ${dropped} event${dropped === 1 ? '' : 's'} outside ${startDate} to ${windowEnd}: the app plans up to ${MAX_TRIP_DAYS} days.`,
        );
      }
    }
  }
  const days = Math.max(1, Math.min(MAX_TRIP_DAYS, daysBetween(startDate, lastDate) + 1));

  // Where they sleep: a stay over days (or all day) before a timed check-in.
  const stays = kept.filter(p => p.lodging && !p.tripItself);
  const stay = stays.find(p => p.endDate > p.date || p.minute === undefined) ?? stays[0];
  const base: Trip['base'] = stay
    ? {
        name: stay.place?.name ?? stay.name ?? (nameInTitle(stay.ev.summary) || stay.ev.summary),
        placeId: stay.place?.id,
        point: stay.place?.point ?? (stay.ev.geo && !stay.outside ? stay.ev.geo : undefined),
      }
    : undefined;
  const stops: Stop[] = [];
  for (const p of kept) {
    if (p.tripItself) continue;
    addName(unmatched, p.name);
    if (p.outside) addName(outsideNames, p.ev.summary || p.name);
    const spans = p.endDate > p.date;
    // A hotel stay is the base, not a stop.
    if (p.lodging && (spans || p.minute === undefined)) continue;
    // Without a pack place, only a timed event is worth a stop.
    if (!p.place && p.minute === undefined) continue;
    const day = Math.max(1, daysBetween(startDate, p.date) + 1);
    if (day > days) continue;
    const timed = p.minute !== undefined && p.date >= startDate;
    stops.push({
      id: newStopId(),
      title: p.ev.summary || p.place?.name || p.name || 'Event',
      placeId: p.place?.id,
      day,
      start: timed ? `${pad2(Math.floor(p.minute! / 60))}:${pad2(p.minute! % 60)}` : undefined,
      durationMinutes: p.durationMinutes ?? p.place?.visitMinutes,
      fixed: true,
      note: cleanNote(p.ev.description) ?? (p.place ? undefined : p.ev.location.replace(/\s*\n\s*/g, ', ') || undefined),
    });
  }

  if (!events.length) warnings.push('No events found in the calendar file.');
  if (skipped) warnings.push(`Skipped ${skipped} event${skipped === 1 ? '' : 's'} without a start date.`);
  if (cancelled) warnings.push(`Skipped ${cancelled} cancelled event${cancelled === 1 ? '' : 's'}.`);
  if (repeating) warnings.push(`${repeating} repeating event${repeating === 1 ? '' : 's'}: only the first date of each was imported.`);
  if (outsideNames.length) {
    warnings.push(`Outside ${dest.name}: ${outsideNames.slice(0, 3).map(n => `"${n}"`).join(', ')}${outsideNames.length > 3 ? ` and ${outsideNames.length - 3} more` : ''}.`);
  }
  for (const tz of unknownZones) warnings.push(`Unknown time zone ${tz}: its times were read as ${dest.name} time.`);
  warnings.push(...zoneNotes.values());

  const sorted = sortStops(stops);
  const source = opts.fileName ?? (calendarName || 'a calendar file');
  const lines = sorted.map(s => `Day ${s.day}${s.start ? ` ${s.start}` : ''}: ${s.title}`);
  return {
    trip: {
      startDate,
      days,
      base,
      interests: [...new Set(opts.interests ?? [])],
      stops: sorted,
      description: [`Imported from ${source}.`, ...lines].join('\n').slice(0, 2000),
    },
    unmatched,
    warnings,
  };
}

// ===========================================================================
// Pasted text

/** One model call's worth of lines: at most this many lines, estimated stops and characters. */
const CHUNK_MAX_LINES = 10;
const CHUNK_MAX_STOPS = 8;
const CHUNK_MAX_CHARS = 1600;

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, ene: 1, enero: 1,
  feb: 2, february: 2, febrero: 2,
  mar: 3, march: 3, marzo: 3,
  apr: 4, april: 4, abr: 4, abril: 4,
  may: 5, mayo: 5,
  jun: 6, june: 6, junio: 6,
  jul: 7, july: 7, julio: 7,
  aug: 8, august: 8, ago: 8, agosto: 8,
  sep: 9, sept: 9, september: 9, septiembre: 9,
  oct: 10, october: 10, octubre: 10,
  nov: 11, november: 11, noviembre: 11,
  dec: 12, december: 12, dic: 12, diciembre: 12,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, domingo: 0,
  monday: 1, mon: 1, lunes: 1,
  tuesday: 2, tues: 2, tue: 2, martes: 2,
  wednesday: 3, wed: 3, miercoles: 3,
  thursday: 4, thurs: 4, thur: 4, thu: 4, jueves: 4,
  friday: 5, fri: 5, viernes: 5,
  saturday: 6, sat: 6, sabado: 6,
};
const WEEKDAY_RE = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join('|');

/** A day heading: "Day 2", "Days 3-4", "Tuesday:", "Mon 16 Nov", "2026-11-16", "16 de noviembre". */
interface DayHeading {
  dayNum?: number;
  dayEnd?: number;
  /** YYYY-MM-DD, the year filled in when the heading has none. */
  date?: string;
  wd?: number;
}

/** The year that puts a day and month closest to today. */
function nearestYear(month: number, day: number, today: string): string | undefined {
  const y = Number(today.slice(0, 4));
  let best: string | undefined;
  for (const year of [y - 1, y, y + 1]) {
    if (!validDate(year, month, day)) continue;
    const d = isoDate(year, month, day);
    if (!best || Math.abs(daysBetween(today, d)) < Math.abs(daysBetween(today, best))) best = d;
  }
  return best;
}

/** The date nearest today (within two months) that is that day of the month and that weekday. */
function dayOfMonthNear(day: number, wd: number, today: string): string | undefined {
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  let best: string | undefined;
  for (let k = -2; k <= 2; k++) {
    const month = ((m - 1 + k + 12) % 12) + 1;
    const year = y + Math.floor((m - 1 + k) / 12);
    if (!validDate(year, month, day)) continue;
    const d = isoDate(year, month, day);
    if (weekday(d) !== wd) continue;
    if (!best || Math.abs(daysBetween(today, d)) < Math.abs(daysBetween(today, best))) best = d;
  }
  return best;
}

function fullYear(y: string): number {
  return y.length === 2 ? 2000 + Number(y) : Number(y);
}

/** Reads a day heading at the start of a line; undefined when the line is not one. */
export function parseDayHeading(line: string, today: string): DayHeading | undefined {
  let s = fold(line)
    .replace(/[*_`]+/g, '')
    .replace(/^[\s#>•·\-–—]+/, '');
  const h: DayHeading = {};
  let strong = false;
  let found = false;
  const markers: [RegExp, (m: RegExpExecArray) => boolean][] = [
    [
      /^(?:days?|dias?)\s*(\d{1,2})(?:\s*(?:-|–|—|to|and|&|y|a)\s*(\d{1,2}))?\b/,
      m => {
        const n = Number(m[1]);
        if (h.dayNum !== undefined || n < 1) return false;
        h.dayNum = n;
        if (m[2] && Number(m[2]) > n) h.dayEnd = Number(m[2]);
        strong = true;
        return true;
      },
    ],
    [
      new RegExp(`^(${WEEKDAY_RE})\\b\\.?`),
      m => {
        if (h.wd !== undefined) return false;
        h.wd = WEEKDAYS[m[1]];
        return true;
      },
    ],
    [
      /^(\d{4})-(\d{1,2})-(\d{1,2})\b/,
      m => setDate(isoIfValid(Number(m[1]), Number(m[2]), Number(m[3]))),
    ],
    [
      /^(\d{1,2})[/.](\d{1,2})[/.](\d{4}|\d{2})\b/,
      m => {
        const [a, b, y] = [Number(m[1]), Number(m[2]), fullYear(m[3])];
        // Day first, as in Spain, unless that cannot be a date.
        return setDate(a > 12 ? isoIfValid(y, b, a) : b > 12 ? isoIfValid(y, a, b) : isoIfValid(y, b, a));
      },
    ],
    [
      new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+|de\\s+)?(${MONTH_RE})\\b\\.?(?:,?\\s*(?:de\\s+)?(\\d{4}))?`),
      m => setDate(m[3] ? isoIfValid(Number(m[3]), MONTHS[m[2]], Number(m[1])) : nearestYear(MONTHS[m[2]], Number(m[1]), today)),
    ],
    [
      new RegExp(`^(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s*(\\d{4}))?`),
      m => setDate(m[3] ? isoIfValid(Number(m[3]), MONTHS[m[1]], Number(m[2])) : nearestYear(MONTHS[m[1]], Number(m[2]), today)),
    ],
    // "16/11" without a year, only as a whole heading ("16/11 - Córdoba"), so "1/2 day" is none.
    // Not with a dot: "10.30 - Alcázar" is a time.
    [
      /^(\d{1,2})\/(\d{1,2})(?=\s*(?:$|[:\-–—(|,]))/,
      m => {
        const [a, b] = [Number(m[1]), Number(m[2])];
        return setDate(nearestYear(b, a, today) ?? nearestYear(a, b, today));
      },
    ],
    // "Monday 16th - Triana", "Lunes 16:": a weekday with its day of the month, ending the heading.
    // A bare number before a dash or a time ("Monday 10 - Alcázar", "Monday 10:30") is an hour.
    [
      /^(\d{1,2})(?:(?:st|nd|rd|th)\b(?=\s*(?:$|[:\-–—(|,]))|(?=\s*(?:$|[(|,]|:(?!\d))))/,
      m => {
        if (h.wd === undefined || h.date) return false;
        const date = dayOfMonthNear(Number(m[1]), h.wd, today);
        return date ? setDate(date) : false;
      },
    ],
    [/^(morning|afternoon|evening|night|manana|tarde|noche)\b/, () => found],
  ];
  function isoIfValid(y: number, m: number, d: number): string | undefined {
    return validDate(y, m, d) ? isoDate(y, m, d) : undefined;
  }
  function setDate(date: string | undefined): boolean {
    if (!date || h.date) return false;
    h.date = date;
    return (strong = true);
  }
  for (;;) {
    const t = s.replace(/^[\s,()|.]+/, '');
    let matched = false;
    for (const candidate of found ? [t, t.replace(/^[-–—]\s*/, '')] : [t]) {
      for (const [re, apply] of markers) {
        const m = re.exec(candidate);
        if (m && apply(m)) {
          s = candidate.slice(m[0].length);
          matched = found = true;
          break;
        }
      }
      if (matched) break;
    }
    if (!matched) break;
  }
  if (!found) return undefined;
  const rest = s.replace(/^[\s,)|.]+/, '');
  // A weekday alone is a heading only when it ends the line or a separator follows ("Tuesday: …").
  if (!strong && rest && !/^[:\-–—]/.test(rest)) return undefined;
  return h;
}

/** A rough count of the stops in a line: its times, or its "; "-separated parts. */
function estimateStops(line: string): number {
  if (!line.trim()) return 0;
  const times = (line.match(/\b\d{1,2}(?::|\.|h)\d{2}\b|\b\d{1,2}\s?(?:am|pm)\b/gi) ?? []).length;
  const parts = line.split(/;|\bthen\b/i).length;
  return Math.max(1, times, parts);
}

function fits(lines: string[]): boolean {
  const filled = lines.filter(l => l.trim());
  return (
    filled.length <= CHUNK_MAX_LINES &&
    filled.reduce((n, l) => n + estimateStops(l), 0) <= CHUNK_MAX_STOPS &&
    filled.reduce((n, l) => n + l.length + 1, 0) <= CHUNK_MAX_CHARS
  );
}

/** Splits lines into groups that each fit one call; later groups start with `continued`. */
function packLines(lines: string[], continued?: string): string[][] {
  const groups: string[][] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (!line.trim() && !cur.length) continue;
    if (cur.length && !fits([...cur, line])) {
      groups.push(cur);
      cur = continued ? [continued] : [];
    }
    cur.push(line);
  }
  if (cur.some(l => l.trim() && l !== continued)) groups.push(cur);
  // No blank lines at either end.
  return groups.map(g => {
    const out = [...g];
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out;
  });
}

/**
 * A line with more stops than one call takes ("9:00 Alcázar, 11:00 Cathedral, 13:00 …") is cut
 * before its times, else at ";" and "then", so no single line overflows a call.
 */
function splitBusyLine(line: string): string[] {
  if (estimateStops(line) <= CHUNK_MAX_STOPS) return [line];
  const byTime = line.split(/[\s,;]+(?=(?:\d{1,2}(?::|\.|h)\d{2}|\d{1,2}\s?(?:am|pm))\b)/i);
  const pieces = byTime.length > 1 ? byTime : line.split(/;\s*|\s+then\s+/i);
  return pieces.map(p => p.trim()).filter(Boolean);
}

/** Long lines (a pasted email) become one line per sentence; busy lines, one line per stop. */
function splitLongLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .flatMap(line => (line.length > 300 ? (line.match(/[^.!?]+[.!?]*\s*/g) ?? [line]).map(s => s.trim()) : [line]))
    .flatMap(splitBusyLine);
}

/** One model call. A known day pins its stops to that day; otherwise the model places them. */
export interface TextChunk {
  text: string;
  day?: number;
  dayEnd?: number;
  /** True when the model's trip length counts (a chunk that may say "I'm here four days"). */
  countDays: boolean;
  label: string;
}

/**
 * Splits pasted itinerary text into chunks: by day headings when it has them ("Day 1",
 * "Tuesday", dates), else by blank-line paragraphs, else in pieces. Exported for tests.
 */
export function planTextChunks(text: string, today: string): { startDate: string; days: number; chunks: TextChunk[]; warnings: string[] } {
  const lines = splitLongLines(text);
  const warnings: string[] = [];
  const headings = lines.map(l => (l.trim() ? parseDayHeading(l, today) : undefined));
  const firstHeading = headings.findIndex(h => !!h);

  if (firstHeading < 0) {
    const all = lines.filter(l => l.trim());
    if (!all.length) return { startDate: today, days: 1, chunks: [], warnings };
    if (fits(all)) return { startDate: today, days: 1, chunks: [{ text: all.join('\n'), countDays: true, label: 'the itinerary' }], warnings };
    const paragraphs = lines
      .join('\n')
      .split(/\n\s*\n/)
      .map(p => p.split('\n').filter(l => l.trim()))
      .filter(p => p.length);
    if (paragraphs.length >= 2 && paragraphs.length <= MAX_TRIP_DAYS) {
      warnings.push('No day headings found: each paragraph was read as one day.');
      const chunks = paragraphs.flatMap((p, i) =>
        packLines(p, `Day ${i + 1}, continued:`).map((g, j) => ({ text: g.join('\n'), day: i + 1, countDays: i === 0 && j === 0, label: `day ${i + 1}` })),
      );
      return { startDate: today, days: paragraphs.length, chunks, warnings };
    }
    warnings.push('No day headings found: the days were left to the model.');
    const chunks = packLines(all).map((g, i) => ({ text: g.join('\n'), countDays: true, label: `part ${i + 1}` }));
    return { startDate: today, days: 1, chunks, warnings };
  }

  // Dates for the headings: given dates win; "Day N" counts from the start; a weekday is the
  // next such day on or after the heading before it.
  const found = headings.map((h, i) => (h ? { h, i } : undefined)).filter((x): x is { h: DayHeading; i: number } => !!x);
  let start = today;
  const dated = found.filter(f => f.h.date);
  if (dated.length) {
    start = dated.map(f => addDays(f.h.date!, -((f.h.dayNum ?? 1) - 1))).sort()[0];
  } else {
    const anchor = found.find(f => f.h.wd !== undefined);
    if (anchor) {
      // The first trip day on or after today that puts the heading's weekday on its day.
      const wantStart = (((anchor.h.wd! - ((anchor.h.dayNum ?? 1) - 1)) % 7) + 7) % 7;
      if (anchor.h.dayNum !== undefined || anchor === found[0]) {
        start = addDays(today, (wantStart - weekday(today) + 7) % 7);
      }
    }
  }
  const blocks: { lines: string[]; day: number; dayEnd?: number }[] = [];
  let prevDate: string | undefined;
  for (let k = 0; k < found.length; k++) {
    const { h, i } = found[k];
    let date: string;
    if (h.date) date = h.date;
    else if (h.dayNum !== undefined) date = addDays(start, h.dayNum - 1);
    else {
      const from = prevDate ?? start;
      date = addDays(from, (h.wd! - weekday(from) + 7) % 7);
    }
    prevDate = date;
    const day = daysBetween(start, date) + 1;
    const end = k + 1 < found.length ? found[k + 1].i : lines.length;
    blocks.push({
      lines: lines.slice(i, end),
      day,
      dayEnd: h.dayEnd !== undefined && h.dayNum !== undefined ? day + (h.dayEnd - h.dayNum) : undefined,
    });
  }

  // Lines before the first heading ("Seville, staying near the Alfalfa"): a short intro rides
  // with the first day, for the base and interests; a long one is read on its own.
  const preamble = lines.slice(0, firstHeading).filter(l => l.trim());
  const chunks: TextChunk[] = [];
  const shortIntro = preamble.length <= 4 && fits(preamble);
  if (preamble.length && !shortIntro) {
    chunks.push(...packLines(preamble).map((g, i) => ({ text: g.join('\n'), countDays: true, label: `the introduction${i ? ` (${i + 1})` : ''}` })));
  } else if (preamble.length) {
    blocks[0].lines = [...preamble, ...blocks[0].lines];
  }

  let dropped = 0;
  const merged: { lines: string[]; day: number; dayEnd?: number; withPreamble: boolean }[] = [];
  blocks.forEach((b, bi) => {
    if (b.day > MAX_TRIP_DAYS) {
      dropped++;
      return;
    }
    const last = merged[merged.length - 1];
    if (last && last.day === b.day && last.dayEnd === b.dayEnd && fits([...last.lines, ...b.lines])) last.lines.push(...b.lines);
    else merged.push({ ...b, withPreamble: bi === 0 && preamble.length > 0 && shortIntro });
  });
  if (dropped) warnings.push(`Left out ${dropped} day${dropped === 1 ? '' : 's'} after day ${MAX_TRIP_DAYS}: the app plans up to ${MAX_TRIP_DAYS} days.`);

  let lastDay = 1;
  for (const b of merged) {
    const date = addDays(start, b.day - 1);
    const dayEnd = b.dayEnd !== undefined ? Math.min(b.dayEnd, MAX_TRIP_DAYS) : undefined;
    lastDay = Math.max(lastDay, dayEnd ?? b.day);
    const groups = packLines(b.lines, `Day ${b.day} (${WEEKDAY_NAMES[weekday(date)]} ${date}), continued:`);
    groups.forEach((g, j) =>
      chunks.push({ text: g.join('\n'), day: b.day, dayEnd, countDays: b.withPreamble && j === 0, label: `day ${b.day}${groups.length > 1 ? ` (part ${j + 1})` : ''}` }),
    );
  }
  return { startDate: start, days: lastDay, chunks, warnings };
}

/** Passes calls through, keeping each trip draft the model returns. */
function recordingDrafts(llm: LLMClient, drafts: TripDraft[]): LLMClient {
  return {
    name: llm.name,
    stream: (req, onToken) => llm.stream(req, onToken),
    async json<T>(req: ChatRequest, schema: JSONSchema): Promise<T> {
      const out = await llm.json<T>(req, schema);
      if (req.tag === 'trip.extract') drafts.push(out as unknown as TripDraft);
      return out;
    },
  };
}

/**
 * Reads pasted itinerary text into a trip through the trip-setup path (TripPlanner.extract and
 * resolveDraft), one day per model call so each stays within 12 stops and 700 tokens, merged
 * in order. Day headings set the days; the model reads the stops. Throws only when every call
 * failed (no model running, say); a failed day otherwise becomes a warning.
 */
export async function importText(text: string, deps: TextImportDeps): Promise<ImportResult> {
  const { index, today } = deps;
  const plan = planTextChunks(text, today);
  const warnings = [...plan.warnings];
  const unmatched: string[] = [];
  const stops: Stop[] = [];
  const interests: Interest[] = [];
  let base: Trip['base'];
  let days = plan.days;
  let failures = 0;
  let firstError: unknown;

  if (!plan.chunks.length) warnings.push('There is no itinerary text to read.');
  deps.onProgress?.(0, plan.chunks.length);
  for (const [n, chunk] of plan.chunks.entries()) {
    if (deps.signal?.aborted) throw new Error('Import cancelled.');
    const drafts: TripDraft[] = [];
    const planner = new TripPlanner(recordingDrafts(deps.llm, drafts), index);
    const chunkStart = chunk.day ? addDays(plan.startDate, chunk.day - 1) : plan.startDate;
    try {
      const t = await planner.extract(chunk.text, chunkStart);
      const draft = drafts[drafts.length - 1];
      // resolveDraft takes any fuzzy hit for the model's place name ("Teatro de la Maestranza" lands
      // on the bullring, "Seville airport" on the cathedral). Here a hit counts only when a name is
      // really in it, as for calendar files; a rejected one is unpinned and its name kept.
      const resolved = t.stops.map(s => ({ ...s }));
      const claimed = new Set<number>();
      for (const ds of draft?.stops ?? []) {
        const k = resolved.findIndex((r, idx) => !claimed.has(idx) && r.title === ds.title);
        if (k >= 0) claimed.add(k);
        const r = k >= 0 ? resolved[k] : undefined;
        const place = r?.placeId ? index.place(r.placeId) : undefined;
        if (r && place && ds.place_name && !nameConfirms(place, ds.place_name, index) && !nameConfirms(place, ds.title, index)) {
          r.placeId = undefined;
          r.durationMinutes = ds.duration_minutes ?? undefined;
        }
        // Names the model read that match no pack place.
        if (ds.place_name && (!r || !r.placeId)) addName(unmatched, usableName(ds.place_name, index));
      }
      // A heading's day wins over the model's count; a "Days 4-5" heading lets the model choose within it.
      const dayOf = (s: Stop) => (chunk.day ? Math.min(chunk.dayEnd ?? chunk.day, chunk.day + Math.max(0, s.day - 1)) : s.day);
      for (const s of resolved) stops.push({ ...s, day: dayOf(s) });
      if (chunk.countDays) days = Math.max(days, (chunk.day ?? 1) + t.days - 1);
      days = Math.max(days, ...resolved.map(dayOf));
      for (const i of t.interests) if (!interests.includes(i)) interests.push(i);
      // "Seville" as where they stay (the model's base_area for a plain list of days) says nothing.
      const cityOnly = !!t.base && words(t.base.name).every(w => isDestinationWord(w, index) || FILLER.has(w));
      if (!base && t.base && !cityOnly) {
        const basePlace = t.base.placeId ? index.place(t.base.placeId) : undefined;
        base = basePlace && !nameConfirms(basePlace, t.base.name, index) ? { name: t.base.name } : t.base;
      }
      // A hotel the pack lacks, even when its neighbourhood matched ("Hotel Casa 1800 in Santa Cruz").
      const baseIsHotel = !!t.base?.placeId && index.place(t.base.placeId)?.category === 'hotel';
      if (draft?.base_area && !baseIsHotel) addName(unmatched, usableName(lodgingName(draft.base_area), index));
    } catch (e) {
      failures++;
      if (failures === 1) firstError = e;
      warnings.push(`Couldn't read ${chunk.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
    deps.onProgress?.(n + 1, plan.chunks.length);
  }
  if (plan.chunks.length && failures === plan.chunks.length) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError));
  }

  const over = stops.filter(s => s.day > MAX_TRIP_DAYS).length;
  if (over) warnings.push(`Left out ${over} stop${over === 1 ? '' : 's'} after day ${MAX_TRIP_DAYS}.`);
  days = Math.max(1, Math.min(MAX_TRIP_DAYS, days));
  return {
    trip: {
      startDate: plan.startDate,
      days,
      base,
      interests: interests.slice(0, 6),
      stops: sortStops(stops.filter(s => s.day >= 1 && s.day <= days)),
      description: text.trim().slice(0, 4000),
    },
    unmatched,
    warnings,
  };
}
