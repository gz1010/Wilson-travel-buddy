// Routing by rules rather than by the model: it is instant, never wrong in
// surprising ways, and easy to extend. Order matters; first match wins.

import { addDays, daysBetween, weekday } from './time';

export type Intent = 'recommend' | 'translator' | 'phrase' | 'trip.setup' | 'trip.edit' | 'guide';

const RULES: [Intent, RegExp][] = [
  ['translator', /\b(translat(e|or|ion)|talk to (a|the|this) (local|person|waiter|driver)|interpret)\b/i],
  ['phrase', /\bhow (do|would) (i|you) say\b|\bwhat'?s .+ in spanish\b/i],
  ['recommend', /\b(what should (i|we) do|what('?s| is) (good|worth)|recommend|suggest|where should (i|we) go|what now|anything (good|fun)|i'?m (bored|hungry)|what to do)\b/i],
  ['trip.edit', /\b(move|reschedule|cancel|remove|delete|add|swap|push|change)\b.*\b(to|from|on|my|the|trip|plan|itinerary|tomorrow|today|day)\b/i],
  ['trip.setup', /\b(i'?m (here|staying|in .+ for)|my trip|i (also )?(have|got) (a|tickets?)|i('?m| am) (visiting|arriving)|(\d+|two|three|four|five) (days|nights))\b/i],
];

const QUESTION = /^\s*(what|where|when|why|how|which|who|is|are|can|could|do|does|will|should)\b/i;
/** A request worded as a question: "Can you add a day?", "Could we stay two more nights?" */
const REQUEST = /^\s*(can|could|would|will) (you|we|i)\b|^\s*(please|let'?s)\b/i;
const CORRECTION = /^\s*(actually|no\b|wait|sorry|correction|i also|also)\b/i;
/** "What's worth seeing at the Cathedral?" is about that place, not a request for picks. */
const WORTH = /\bworth\b/i;

/**
 * Straight quotes, lower case, single spaces. macOS turns typed apostrophes into curly ones
 * ("I’m"), which the rules would otherwise miss.
 */
export function normalize(text: string): string {
  return text
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function routeIntent(text: string, hasTrip: boolean, opts: { namesPlace?: boolean } = {}): Intent {
  const t = normalize(text);
  const asks = QUESTION.test(t) && !REQUEST.test(t);
  // A longer or shorter stay edits the trip (or starts one), even in a sentence that would
  // otherwise replace the whole trip. A long description with a length is still a new trip.
  const stay = asks ? undefined : stayChangeOf(t);
  for (const [intent, re] of RULES) {
    // After the translator and phrase rules ("how do I say I'm staying two more days").
    if (intent === 'recommend' && stay) {
      if (!hasTrip) return 'trip.setup';
      if (stay.kind !== 'set' || t.split(' ').length <= 15) return 'trip.edit';
    }
    if (!re.test(t)) continue;
    if (intent === 'recommend' && opts.namesPlace && WORTH.test(t)) return 'guide';
    if (intent === 'trip.edit') return hasTrip ? 'trip.edit' : 'trip.setup';
    if (intent === 'trip.setup') {
      if (asks) continue; // "What is there to see in three days?" is a question, not a plan
      if (!hasTrip) return 'trip.setup';
      // A long description replaces the trip; a short remark ("I'm here four days") edits it.
      return t.split(' ').length > 15 ? 'trip.setup' : 'trip.edit';
    }
    return intent;
  }
  if (hasTrip && CORRECTION.test(t)) return 'trip.edit';
  // Questions never create or overwrite a trip; the guide works without one.
  return 'guide';
}

// ---------------------------------------------------------------------------
// The length of the stay, in code: "two more days", "add a day", "until Tuesday". A 4B model
// asked to rewrite the whole trip JSON often loses count; these are exact.

/** A date said relative to today: "Tuesday", "tomorrow", "the 20th", "November 20". */
export type DateTarget = { weekday: number } | { offset: number } | { day: number; month?: number };

export type StayChange =
  /** Days more (or fewer, when negative). */
  | { kind: 'add'; days: number }
  /** The whole stay, in days. */
  | { kind: 'set'; days: number }
  /** The last day of the stay. */
  | { kind: 'until'; target: DateTarget };

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  'a couple of': 2,
  'a couple': 2,
  'couple of': 2,
};
const N = '(\\d{1,2}|a couple of|a couple|couple of|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen)';
const UNIT = '(days?|nights?|weeks?)';
/** "a day trip", "a day pass": a thing to do, not a day of the stay. */
const NOT_A_THING = "(?![ -]?(trips?|tours?|pass(es)?|tickets?|excursions?|out)\\b)(?! ?\\d)";
/**
 * Where a whole stay's length may end: "I'm here four days", "…three days, staying near…", "five
 * days in Seville". Not "stay a day at the beach" or "a day in Córdoba": an outing, not the stay.
 */
const SET_END = "(?=$|[,.!?;]| (?:in (?:seville|sevilla|town|the city|total)|here|altogether|only|please|and|but|so|now|instead|then)\\b)";
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\\.?';
/** "until 5 pm" and "until 17:00" are times, not the 5th or the 17th. */
const NOT_A_TIME = "(?! ?(?:pm|am|p\\.m|a\\.m|o'?clock|:|h\\b|hours?|minutes?|mins?))";
/**
 * A bare number is a clock time far more often than a date ("I'm out until 11", "at the museum
 * until 3"): a day of the month needs "the", an ordinal or a month ("the 20th", "20th", "20 Nov").
 */
const DAY_OF_MONTH = `(?=the |\\d{1,2}(?:st|nd|rd|th)\\b|\\d{1,2}(?: of)? ${MONTH.replace('(', '(?:')})`;
const DATE = `(?:(?:this |next |on )?(${WEEKDAYS.join('|')})|(the day after tomorrow)|(tomorrow)|(today|tonight)|${DAY_OF_MONTH}(?:the )?(\\d{1,2})(?:st|nd|rd|th)?${NOT_A_TIME}(?: of)?(?: ${MONTH})?|${MONTH} (?:the )?(\\d{1,2})(?:st|nd|rd|th)?${NOT_A_TIME})\\b`;

/** Words that may sit around a change of length without saying anything else. */
const FILLER = new Set(
  `i i'm im i've i'll i'd we we're were we've we'll we'd you it it's is am are be been was will would can could shall should may might
  actually ok okay so hey buddy please now also and just think thought decided decide to want wanna going gonna like let's lets
  stay staying stayed here there in at seville sevilla the city town spain my our trip stay plan visit holiday vacation
  extend extending it this that for until till til through thru a an more longer total all of means yeah yes no sorry wait
  change make update add adding days day nights night weeks week leaving leave on then too instead thanks thank great cool oh
  um uh well since because have got extra another least by up fly flying flight home back go going head heading depart
  departing check checking out out cut remove drop shorten shorter fewer less early earlier sooner one two three four five six
  seven eight nine ten eleven twelve thirteen fourteen couple more further additional only even including after tomorrow today
  tonight next last sunday monday tuesday wednesday thursday friday saturday january february march april may june july august
  september october november december jan feb mar apr jun jul aug sep sept oct nov dec st nd rd th of`.split(/\s+/),
);

function count(word: string): number {
  return /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word] ?? 1;
}

function inDays(n: number, unit: string): number {
  return unit.startsWith('week') ? n * 7 : n;
}

function dateTarget(m: RegExpExecArray, at: number): DateTarget | undefined {
  const [wd, dayAfter, tomorrow, today, dom, month1, month2, dom2] = m.slice(at, at + 8);
  if (wd) return { weekday: WEEKDAYS.indexOf(wd) };
  if (dayAfter) return { offset: 2 };
  if (tomorrow) return { offset: 1 };
  if (today) return { offset: 0 };
  const day = Number(dom ?? dom2);
  if (!day || day > 31) return undefined;
  const name = month1 ?? month2;
  const month = name ? MONTHS.indexOf(name.slice(0, 3)) + 1 : undefined;
  return month ? { day, month } : { day };
}

const STAY_CONTEXT = /\b(stay|staying|stayed|here|extend\w*|add|adding|longer|trip|remain\w*|keep|visit)\b/;

interface StayRule {
  re: RegExp;
  change: (m: RegExpExecArray) => StayChange | undefined;
  /** Needs a word about staying somewhere in the sentence ("another day" alone may mean "later"). */
  context?: boolean;
  /**
   * Needs a word about the stay, or nothing else in the sentence: "I'm busy until Tuesday" and
   * "push the flamenco show until Tuesday" are not the end of the trip.
   */
  stayWords?: RegExp;
}

/** Words that tie an "until …" to the stay itself. */
const UNTIL_CONTEXT = /\b(stay\w*|here|trip|visit\w*|remain\w*|extend\w*|leav\w*|in (?:town|seville|sevilla|the city|spain))\b/;

const STAY_RULES: StayRule[] = [
  // Shorter: "one day less", "leaving a day early", "cut a day", "shorten it by two days".
  { re: new RegExp(`\\b${N} (?:fewer|less) ${UNIT}\\b`), change: m => ({ kind: 'add', days: -inDays(count(m[1]), m[2]) }) },
  { re: new RegExp(`\\b${N} ${UNIT} (?:less|fewer|shorter)\\b`), change: m => ({ kind: 'add', days: -inDays(count(m[1]), m[2]) }) },
  {
    // Early only when leaving: "I'll be at the museum a day early" is not a shorter stay.
    re: new RegExp(`\\b(?:leav\\w*|go(?:ing)? home|fly(?:ing)? (?:home|out|back)|head(?:ing)? home|depart\\w*|check(?:ing)? out)\\b.{0,20}?\\b${N} ${UNIT} (?:early|earlier|sooner)\\b`),
    change: m => ({ kind: 'add', days: -inDays(count(m[1]), m[2]) }),
  },
  {
    re: new RegExp(`\\b(?:cut|remove|drop|lose|take off|knock off|subtract)(?: off)? (?:(?:the|our|my) last|${N}) ${UNIT}\\b${NOT_A_THING}`),
    change: m => ({ kind: 'add', days: -inDays(m[1] ? count(m[1]) : 1, m[2]) }),
  },
  { re: new RegExp(`\\bshorten\\w*\\b.{0,30}?\\bby ${N} ${UNIT}\\b`), change: m => ({ kind: 'add', days: -inDays(count(m[1]), m[2]) }) },
  // Longer: "two more days", "another night", "add a day", "extend my trip by two days".
  { re: new RegExp(`\\b${N} (?:more|extra|additional|further) ${UNIT}\\b${NOT_A_THING}`), change: m => ({ kind: 'add', days: inDays(count(m[1]), m[2]) }), context: true },
  { re: new RegExp(`\\b${N} ${UNIT} (?:longer|more|extra)\\b`), change: m => ({ kind: 'add', days: inDays(count(m[1]), m[2]) }), context: true },
  {
    re: new RegExp(`\\b(?:another|one more|an extra|one extra|an additional)(?: ${N})? ${UNIT}\\b${NOT_A_THING}`),
    change: m => ({ kind: 'add', days: inDays(m[1] ? count(m[1]) : 1, m[2]) }),
    context: true,
  },
  {
    re: new RegExp(`\\badd(?:ing)?(?: on)?(?: ${N})?(?: more| extra| additional)? ${UNIT}\\b${NOT_A_THING}`),
    change: m => ({ kind: 'add', days: inDays(m[1] ? count(m[1]) : 1, m[2]) }),
  },
  { re: new RegExp(`\\bextend\\w*\\b.{0,30}?\\b(?:by |for )?${N}(?: more)? ${UNIT}\\b`), change: m => ({ kind: 'add', days: inDays(count(m[1]), m[2]) }) },
  { re: /\bextend\w* (?:my|our|the) (?:trip|stay|visit)\b/, change: () => ({ kind: 'add', days: 1 }) },
  // The last day: "until Tuesday", "I'm leaving on the 20th", "flying home tomorrow".
  {
    re: new RegExp(`\\b(?:until|till|til|through|thru|up to|up until)(?: and including)? ${DATE}`),
    change: m => {
      const target = dateTarget(m, 1);
      return target && { kind: 'until', target };
    },
    stayWords: UNTIL_CONTEXT,
  },
  {
    re: new RegExp(
      // Not "the bus leaves tomorrow" or "can we go back tomorrow?" (to a place): the traveller leaving.
      `\\b(?:leav(?:e|ing)|fly(?:ing)?(?: out| home| back)?|(?:my |our )?flight(?: home| back| out)?(?: is| leaves)?|go(?:ing)? home|going back|head(?:ing)? home|heading back|depart(?:ing)?|check(?:ing)? out)(?: is)?(?: on)? ${DATE}`,
    ),
    change: m => {
      const target = dateTarget(m, 1);
      return target && { kind: 'until', target };
    },
  },
  // The whole stay: "I'm here four days", "make it five nights", "a week in Seville".
  {
    re: new RegExp(
      `\\b(?:here|staying|stay|stay is|be here|visiting|in seville|in sevilla|trip is|trip's|trip will be|make it|make (?:the|my|our) (?:trip|stay)|change (?:it|the trip|my trip) to|only|just|in total|altogether)(?: for| to)?(?: only| just)? ${N} ${UNIT}${SET_END}`,
    ),
    change: m => setStay(m[1], m[2]),
  },
  // Or said first: "Three days, staying in Santa Cruz", "A week. We love tapas."
  {
    re: new RegExp(`^(?:(?:ok(?:ay)?|so|actually|no|wait|sorry|um|well)[,.]? )*${N} ${UNIT}${SET_END}`),
    change: m => setStay(m[1], m[2]),
  },
];

function setStay(n: string, unit: string): StayChange {
  // Three nights is four days: the day you arrive to the day you leave.
  return { kind: 'set', days: unit.startsWith('night') ? count(n) + 1 : inDays(count(n), unit) };
}

/**
 * A change to how long the traveller stays, if the text says one; undefined otherwise. Pure
 * wording: dates are resolved against the trip with stayDays().
 */
export function stayChangeOf(text: string): StayChange | undefined {
  const t = normalize(text);
  // "The museum is closed for two more days" is about the museum.
  if (/\b(closed|open|opens|rain|raining|forecast|weather)\b/.test(t)) return undefined;
  for (const rule of STAY_RULES) {
    const m = rule.re.exec(t);
    if (!m) continue;
    if (rule.context && !STAY_CONTEXT.test(t) && t.split(' ').length > 4) continue;
    if (rule.stayWords && !rule.stayWords.test(t) && !onlyStayChange(t)) continue;
    const change = rule.change(m);
    if (change) return change;
  }
  return undefined;
}

/**
 * True when the text says nothing but the change of length ("Actually I'm staying two more days"),
 * so code can make it without the model.
 */
export function onlyStayChange(text: string): boolean {
  const words = normalize(text)
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  return words.every(w => FILLER.has(w) || /^\d{1,2}(st|nd|rd|th)?$/.test(w));
}

/** The date a target means, from the clock's date `today` (and not before `notBefore`). */
export function resolveDate(target: DateTarget, today: string, notBefore = today): string | undefined {
  if ('offset' in target) return addDays(today, target.offset);
  const ref = notBefore > today ? notBefore : today;
  if ('weekday' in target) {
    // The next one: "until Sunday" said on a Sunday means next Sunday.
    for (let i = 0; i < 8; i++) {
      const d = addDays(ref, i);
      if (weekday(d) === target.weekday && d !== today) return d;
    }
    return undefined;
  }
  // A day of the month counts from today: "until the 18th" before a trip that starts on the 20th is a mistake, not December.
  const [y, m] = today.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  const valid = (yy: number, mm: number) => {
    const s = `${yy}-${pad(mm)}-${pad(target.day)}`;
    return addDays(s, 0) === s ? s : undefined; // 31 February rolls over: not a date
  };
  if (target.month) {
    const s = valid(y, target.month);
    return s && s < today ? valid(y + 1, target.month) : s;
  }
  const s = valid(y, m);
  if (s && s >= today) return s;
  return m === 12 ? valid(y + 1, 1) : valid(y, m + 1);
}

/** The trip's new length in days for a change, or undefined when it makes no sense (an end before the start). */
export function stayDays(change: StayChange, trip: { startDate: string; days: number }, today: string): number | undefined {
  switch (change.kind) {
    case 'add':
      return trip.days + change.days;
    case 'set':
      return change.days;
    case 'until': {
      const end = resolveDate(change.target, today, trip.startDate);
      if (!end) return undefined;
      const n = daysBetween(trip.startDate, end) + 1;
      return n >= 1 ? n : undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Where the traveller is staying: "my hotel is here", "I'm staying at the Hotel Inglaterra".

export type HotelChange =
  | { here: true }
  /** named: it reads like a name ("Hotel Inglaterra"), not a remark ("my hotel is nice"). */
  | { here: false; name: string; named: boolean };

const LEAD = "^(?:(?:ok(?:ay)?|so|actually|and|also|hey|buddy|please|oh|no|wait|sorry)[,.]? )*";
const LODGING = '(?:hotel|airbnb|apartment|flat|hostel|room|place)';
const HOTEL_HERE = [
  new RegExp(`${LEAD}(?:my|our|the) ${LODGING}(?: is|'s)(?: right)? (?:here|this one|this place|where i am)\\b`),
  new RegExp(`\\b(?:this|here) is (?:my|our) ${LODGING}\\b`),
  new RegExp(`\\b(?:set|make|mark|save|use) (?:this|here|this place|it|where i am) as (?:my|our) (?:${LODGING}|base)\\b`),
];
const HOTEL_NAMED = [
  new RegExp(`${LEAD}(?:my|our) ${LODGING}(?: is|'s)(?: called| named)? (.+?)[.!]?$`),
  new RegExp(`${LEAD}(?:i'?m|we'?re|i am|we are|i'?ll be|we'?ll be)? ?(?:now )?staying (at|in|near|by|close to|next to) (.+?)[.!]?$`),
];
/** Words that make a phrase a place to stay rather than a remark about one. */
const LODGING_WORDS = /\b(hotel|hostal|hostel|casa|palacio|inn|suites?|apartments?|apartamentos?|airbnb|pension|pensi[oó]n|posada|corral|plaza|calle|barrio)\b/i;

/**
 * A new place to stay, when that is all the text says. Not "staying in Seville", and not a
 * sentence that also changes the dates or the plans: those go to the planner. The caller checks
 * a name that isn't `named` against the guide before taking it ("my hotel is nice" is not one).
 */
export function hotelOf(text: string): HotelChange | undefined {
  const t = normalize(text);
  if (HOTEL_HERE.some(re => re.test(t))) return { here: true };
  for (const re of HOTEL_NAMED) {
    const m = re.exec(t);
    if (!m) continue;
    const prep = m.length > 2 ? m[1] : undefined;
    let name = (prep ? m[2] : m[1]).trim();
    const lead = /^(at|in|near|by|close to|next to|right by|on) /.exec(name);
    if (lead) name = name.slice(lead[0].length);
    const near = !['at', 'in', 'on'].includes(lead?.[1] ?? prep ?? 'at');
    const article = /^(the|a|an) /.exec(name)?.[0] ?? '';
    name = name.slice(article.length);
    if (!name || name.split(' ').length > 8 || /[,;?!]|\. | and | for | until | till | from |\bdays?\b|\bnights?\b|\bweeks?\b/.test(name)) return undefined;
    if (/^(seville|sevilla|the city|city|town|spain|here|there|the area|hotel|a hotel|an airbnb|airbnb|apartment|hostel|my hotel)$/.test(name)) {
      return undefined;
    }
    // Keep the traveller's own capitals ("Hotel Inglaterra"), not the lower-cased copy.
    const original = text.replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '');
    const at = original.toLowerCase().lastIndexOf(name);
    const shown = at >= 0 ? original.slice(at, at + name.length) : name;
    const named = LODGING_WORDS.test(shown) || /(^|\s)\p{Lu}/u.test(shown);
    return { here: false, name: near ? `near ${article}${shown}` : shown, named };
  }
  return undefined;
}
