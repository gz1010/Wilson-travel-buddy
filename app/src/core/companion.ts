import { DeclineFilter, Guide } from './guide';
import { hotelOf, normalize, onlyStayChange, routeIntent, stayChangeOf, stayDays, type HotelChange } from './intent';
import { NearbyIndex, nearbyAnswer, nearbyQuery } from './nearby';
import { fold, type PackIndex, type SearchHit } from './pack';
import { NOT_IN_GUIDE, prompts } from './prompts';
import { Recommender, spokenSummary } from './recommend';
import { Translator } from './translate';
import { addDays, daysBetween, formatClock, formatHHMM, parseHHMM, weekday, WEEKDAY_NAMES } from './time';
import { sortStops, summarizeTrip, tripDay, TripPlanner } from './trip';
import type { Cited, Clock, Companion, CompanionEvent, Fact, Interest, LLMClient, Place, Situation, Stop, Trip } from './types';

export interface CompanionContext {
  trip(): Trip | undefined;
  situation(): Situation;
  saveTrip(trip: Trip): Promise<void>;
  /** The place on screen (the Map's card, a Place page), for "is it worth it?" and "tell me more about it". */
  focus?(): string | undefined;
}

/** The longest trip the planner makes (its schema's maximum). */
export const MAX_TRIP_DAYS = 14;

/** How many facts an answer shows at most. */
const MAX_CITED = 6;

/**
 * Takes what the traveller said or typed and does the right thing: set up
 * the trip, edit it, recommend, answer from the guide, or switch to the
 * translator. Voice and text come through the same door.
 */
export class DefaultCompanion implements Companion {
  readonly planner: TripPlanner;
  readonly recommender: Recommender;
  readonly guide: Guide;
  readonly translator: Translator;
  /** The place the last answer was about, for a follow-up ("is it worth it?"). */
  private lastPlaceId?: string;
  private readonly factsById: Map<string, Fact>;

  constructor(private llm: LLMClient, private index: PackIndex, private ctx: CompanionContext) {
    this.planner = new TripPlanner(llm, index);
    this.recommender = new Recommender(llm, index);
    this.guide = new Guide(llm, index);
    this.translator = new Translator(llm, index.pack.phrases, 'en', index.destination.language);
    this.factsById = new Map(index.pack.facts.map(f => [f.id, f]));
    this.nearby = index.pack.nearby ? new NearbyIndex(index.pack.nearby) : undefined;
  }

  /** The city's offline map of everything (cinemas, pharmacies…), when the pack has one. */
  private readonly nearby?: NearbyIndex;

  /**
   * Answers "is there a pharmacy near the cathedral?" or "find a movie theatre" from the nearby
   * index, measured from the place named or else from where the traveller is. False when the
   * question is not one of those (the guide answers it).
   */
  private answerNearby(text: string, named: Place | undefined, sit: Situation, emit: (e: CompanionEvent) => void): boolean {
    if (!this.nearby) return false;
    const query = nearbyQuery(text);
    // "Is the Museum of Fine Arts nearby?" is about that museum: the guide answers.
    if (!query || (named && query.category.guide)) return false;
    const from = named?.point ?? sit.location;
    const results = this.nearby.search(query, from, sit.clock);
    let answer = nearbyAnswer(query, results, { city: this.index.destination.name, covered: this.nearby.covers(from) });
    if (named && results.length) answer = `Near ${named.name}: ${answer.charAt(0).toLowerCase()}${answer.slice(1)}`;
    const placeId = results[0]?.place.placeId;
    if (placeId && this.index.place(placeId)) {
      this.lastPlaceId = placeId;
      emit({ type: 'focus', placeId });
    }
    emit({ type: 'done', text: answer });
    return true;
  }

  async handle(text: string, emit: (e: CompanionEvent) => void): Promise<void> {
    const trip = this.ctx.trip();
    const sit = this.ctx.situation();
    const today = sit.clock.date;
    const named = this.index.findPlace(text, { fuzzy: false });
    try {
      const intent = routeIntent(text, !!trip, { namesPlace: !!named });
      // "My hotel is here", "I'm staying at the Hotel Inglaterra": code sets the base. Not inside
      // "how do I say this is my room?" or "translate…", which are phrases to say.
      const hotel = intent === 'translator' || intent === 'phrase' ? undefined : hotelOf(text);
      if (hotel && (await this.setHotel(hotel, trip, sit, emit))) return;
      // "Find a cinema / pharmacy / cash machine near me": every place on the city's offline map,
      // not only the guide's. Code finds and ranks them, so nothing is invented (core/nearby.ts).
      if ((intent === 'guide' || intent === 'recommend') && this.answerNearby(text, named, sit, emit)) return;

      switch (intent) {
        case 'translator': {
          emit({ type: 'translator' });
          emit({ type: 'done', text: 'Opening the translator.' });
          return;
        }
        case 'trip.setup': {
          emit({ type: 'status', text: 'Reading your plans…' });
          let next = await this.planner.extract(text, today);
          // The model reads "two more days" as two days; code counts from today.
          const stay = stayChangeOf(text);
          const days = stay && stayDays(stay, { startDate: next.startDate, days: 1 }, today);
          if (days) next = resize(next, days);
          next = keepBasePoint(trip, next);
          await this.ctx.saveTrip(next);
          emit({ type: 'trip', trip: next });
          emit({ type: 'done', text: confirmTrip(next) });
          return;
        }
        case 'trip.edit': {
          const stay = stayChangeOf(text);
          // Only the length changed: exact, instant, and the stops stay as they are.
          if (stay && onlyStayChange(text)) {
            const asked = stayDays(stay, trip!, today);
            if (asked === undefined) {
              emit({ type: 'done', text: `Your trip starts ${spokenDate(trip!.startDate)}, so it can't end before that. Which day do you leave?` });
              return;
            }
            const next = resize(trip!, asked, text);
            await this.ctx.saveTrip(next);
            emit({ type: 'trip', trip: next });
            emit({ type: 'done', text: describeStay(trip!, next, asked) });
            return;
          }
          emit({ type: 'status', text: 'Updating your plans…' });
          let next = await this.planner.revise(trip!, text, today);
          const asked = stay && stayDays(stay, trip!, today);
          if (asked) next = resize(next, asked);
          next = keepBasePoint(trip, next);
          await this.ctx.saveTrip(next);
          emit({ type: 'trip', trip: next });
          emit({ type: 'done', text: describeChanges(trip!, next) });
          return;
        }
        case 'recommend': {
          emit({ type: 'recommendations', items: this.recommender.quick(trip, sit) });
          emit({ type: 'status', text: 'Thinking about what fits right now…' });
          const recs = await this.recommender.refine(trip, sit);
          emit({ type: 'recommendations', items: recs });
          if (recs[0]) {
            this.lastPlaceId = recs[0].placeId;
            emit({ type: 'focus', placeId: recs[0].placeId });
          }
          emit({ type: 'done', text: spokenSummary(recs) });
          return;
        }
        case 'phrase': {
          const what = text.replace(/.*how (do|would) (i|you) say\s*/i, '').replace(/\s+in spanish\??$/i, '').replace(/[?"]/g, '').trim();
          const lang = this.index.destination.language;
          const out = await this.translator.translate(what, 'en', lang, t => emit({ type: 'token', text: t, lang }));
          emit({ type: 'done', text: out, lang });
          return;
        }
        case 'guide':
        default: {
          await this.answer(text, named, sit, trip, emit);
          return;
        }
      }
    } catch (e) {
      emit({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  }

  // -------------------------------------------------------------------------
  // Answers from the guide, with the facts behind them.

  /**
   * Answers from the pack (B's sources and decline filter), asking the model to number the
   * sources it used; code strips the numbers and attaches those facts, else the facts of the
   * place the question is about, to the done event as `cited`.
   */
  private async answer(text: string, named: Place | undefined, sit: Situation, trip: Trip | undefined, emit: (e: CompanionEvent) => void) {
    const subject = named ?? this.subjectOf(text, sit);
    // "Is it worth it?" carries its place along, so the sources are about it.
    const question = subject && !named ? `${text.trim()} (about ${subject.name})` : text;
    const sources = this.guide.sources(question, sit, trip);
    let shown = '';
    let raw = '';
    if (sources.length) {
      const context = [
        `Now: ${formatClock(sit.clock)}, near ${sit.locationLabel}.`,
        trip ? `Their trip:\n${summarizeTrip(trip, this.index)}` : '',
        'SOURCES:',
        ...sources.map((s, i) => `[${i + 1}] ${s.title}: ${s.text}`),
      ]
        .filter(Boolean)
        .join('\n');
      // The filter hands over whole sentences; the refusal is held back until the end, when a
      // question about a place can still be answered from its facts.
      const filter = new DeclineFilter(sentence => {
        const clean = stripCitations(sentence).trim();
        if (!clean || clean === NOT_IN_GUIDE || isAboutSources(clean)) return;
        const piece = shown ? ` ${clean}` : clean;
        shown += piece;
        emit({ type: 'token', text: piece });
      });
      await this.llm.stream(
        {
          tag: 'guide',
          maxTokens: 260,
          messages: [
            { role: 'system', content: prompts.answer(this.index.destination.name) },
            { role: 'user', content: `${context}\n\nQuestion: ${question}` },
          ],
        },
        t => {
          raw += t;
          filter.push(t);
        },
      );
      filter.end();
    }

    const answerPlaces = this.index.placesMentionedIn(shown);
    const cited = this.citedFor(text, raw, shown, sources, subject, answerPlaces);
    let reply = shown;
    if (!reply) {
      // Declined. A question about a place the guide knows ("tell me its history") still gets its facts.
      const t = normalize(text);
      reply = (subject && (ABOUT.test(t) || FOLLOW_UP.test(t)) && factAnswer(subject, cited?.facts ?? [], text)) || NOT_IN_GUIDE;
      emit({ type: 'token', text: reply });
    }
    const declined = reply === NOT_IN_GUIDE;
    const focus = declined ? undefined : subject ?? answerPlaces[0] ?? (cited?.placeId ? this.index.place(cited.placeId) : undefined);
    if (focus) {
      this.lastPlaceId = focus.id;
      emit({ type: 'focus', placeId: focus.id });
    }
    emit(declined || !cited ? { type: 'done', text: reply } : { type: 'done', text: reply, cited });
  }

  /**
   * The place a question without a place name is about: "is it worth it?" (the place on screen,
   * or the last answer's), "what's the history here?" and "tell me a historical fact" (the place
   * you are at, else the one on screen, else the nearest place with facts on that topic).
   * Undefined for anything else, and for questions about the city itself.
   */
  private subjectOf(text: string, sit: Situation): Place | undefined {
    const t = normalize(text);
    if (new RegExp(`\\b(${fold(this.index.destination.name)}|sevilla|spain|andalusia)\\b`).test(fold(t))) return undefined;
    const factRequest = FACT_REQUEST.test(t);
    const pointing = (ABOUT.test(t) && POINTING.test(t) && !/\b(is|are) there\b|\bthere (is|are)\b|\bthere's\b/.test(t)) || FOLLOW_UP.test(t);
    if (!factRequest && !pointing) return undefined;
    const place = (id?: string) => (id ? this.index.place(id) : undefined);
    const [near] = this.index.nearest(sit.location, 1);
    const atYou = near && near.meters < 200 ? near.place : undefined;
    const onScreen = place(this.ctx.focus?.()) ?? place(this.lastPlaceId);
    // "Here" and a fact request are where you are; "it" and "this" are what is on screen.
    const found = factRequest || /\b(here|around here|nearby|where i am)\b/.test(t) ? atYou ?? onScreen : onScreen ?? atYou;
    if (found || !factRequest) return found;
    // "Tell me a fun fact": the nearest place that has some, preferring history.
    const topic = topicsOf(t);
    return this.index
      .nearest(sit.location, 40)
      .map(n => n.place)
      .find(p => this.index.facts(p.id).some(f => !topic.length || f.tags.some(tag => topic.includes(tag))));
  }

  /** The facts behind an answer, most relevant first; undefined when there are none. */
  private citedFor(
    question: string,
    raw: string,
    shown: string,
    sources: SearchHit[],
    subject: Place | undefined,
    answerPlaces: Place[],
  ): Cited | undefined {
    const facts: Fact[] = [];
    const add = (f: Fact | undefined) => f && !facts.some(x => x.id === f.id) && facts.push(f);
    // 1. What the model said it used: "[2]". A 4B model sometimes numbers the wrong source (seen
    // live: Columbus's tomb cited to El Salvador), so a cited fact counts when it is about the
    // place asked about or the answer repeats it.
    const numbered = citations(raw)
      .map(c => ({ ...c, hit: sources[c.n - 1] }))
      .filter(c => !!c.hit && ((!!subject && c.hit.placeId === subject.id) || overlap(c.claim, c.hit.text) >= 2))
      .map(c => c.hit!)
      .filter((h, i, all) => all.findIndex(x => x.id === h.id) === i);
    numbered.filter(h => h.kind === 'fact').forEach(h => add(this.factsById.get(h.id)));
    // 2. Facts among the sources that the answer plainly repeats: two telling words for a fact
    // about a place the answer is about, three in one sentence for any other ("largest" and
    // "cathedral" alone are not El Salvador's fact).
    const near = new Set([subject?.id, ...answerPlaces.map(p => p.id)]);
    const sentences = shown.match(/[^.!?]+[.!?]*/g) ?? [];
    const used = sources.filter(
      h => h.kind === 'fact' && (h.placeId && near.has(h.placeId) ? overlap(shown, h.text) >= 2 : sentences.some(x => overlap(x, h.text) >= 3)),
    );
    used.forEach(h => add(this.factsById.get(h.id)));
    // 3. The place's own facts: the place asked about, else the one the answer rests on.
    const about = ABOUT.test(normalize(question));
    const placeId =
      subject?.id ??
      numbered.find(h => h.placeId)?.placeId ??
      used.find(h => h.placeId)?.placeId ??
      (about || answerPlaces.length === 1 ? answerPlaces[0]?.id : undefined) ??
      (about ? sources.find(h => h.kind === 'fact' && h.placeId)?.placeId : undefined);
    if (placeId) rankFacts(this.index.facts(placeId), question).forEach(add);
    if (!facts.length) return undefined;
    return { placeId, facts: facts.slice(0, MAX_CITED) };
  }

  // -------------------------------------------------------------------------
  // Where the traveller is staying.

  /** Sets the trip's base from a hotel remark. False when the remark was not about one after all. */
  private async setHotel(hotel: HotelChange, trip: Trip | undefined, sit: Situation, emit: (e: CompanionEvent) => void): Promise<boolean> {
    const base: Trip = trip ?? { startDate: sit.clock.date, days: 1, interests: [], stops: [], description: '' };
    let next: Trip;
    let reply: string;
    if (hotel.here) {
      const old = trip?.base?.name;
      const name = old && !/^near\b/i.test(old) ? old : 'My hotel';
      next = { ...base, base: { name, point: sit.location } };
      reply =
        sit.locationLabel === 'the city centre'
          ? `I've put your hotel in the city centre for now. On the Map, tap where it is, then tell me "my hotel is here".`
          : `Got it: your hotel is at ${sit.locationLabel}. On the Map, "At my hotel" takes you back there.`;
    } else {
      const place = this.index.findPlace(hotel.name);
      if (!place && !hotel.named) return false; // "my hotel is nice"
      const same = trip?.base?.point && fold(trip.base.name) === fold(hotel.name) ? trip.base : undefined;
      const point = place?.point ?? same?.point;
      next = { ...base, base: { name: hotel.name, placeId: place?.id, point } };
      const where = /^near\b/i.test(hotel.name) ? `staying ${hotel.name}` : `staying at ${hotel.name}`;
      reply = point
        ? `Got it: you're ${where}. On the Map, "At my hotel" takes you there.`
        : `Got it: you're ${where}. It isn't in my guide, so on the Map, tap where it is and tell me "my hotel is here".`;
    }
    next = { ...next, description: [base.description, `Base: ${next.base!.name}`].filter(Boolean).join('\n') };
    await this.ctx.saveTrip(next);
    emit({ type: 'trip', trip: next });
    emit({ type: 'done', text: reply });
    return true;
  }
}

// ---------------------------------------------------------------------------
// Trip helpers

/** A stop with no duration is taken to last this long when finding a free time (as Now does). */
const DEFAULT_STOP_MINUTES = 60;
/** A new stop on another day than today starts looking for a free time here. */
const DAY_STARTS = 10 * 60;

let stopCounter = 0;

/**
 * The trip with a place added to a day (the clock's date, or `at.date`). A date outside the trip
 * grows the trip to include it; with no trip, it starts one on that date. The stop starts at
 * `at.start`, else at the first free quarter hour that day (from the clock, on today), else it
 * has no time. Returns the same trip when the place is already on that day.
 */
export function withStop(trip: Trip | undefined, place: Place, clock: Clock, at: { date?: string; start?: string } = {}): Trip {
  const date = at.date ?? clock.date;
  let t: Trip = trip ?? { startDate: date, days: 1, interests: [], stops: [], description: '' };
  if (!tripDay(t, date)) {
    const offset = daysBetween(t.startDate, date);
    if (offset >= t.days && offset < MAX_TRIP_DAYS) t = { ...t, days: offset + 1 };
    else if (offset < 0 && t.days - offset <= MAX_TRIP_DAYS) {
      // Before the first day: the trip starts earlier, and its days shift along.
      t = { ...t, startDate: date, days: t.days - offset, stops: t.stops.map(s => ({ ...s, day: s.day - offset })) };
    }
  }
  const day = tripDay(t, date) ?? (daysBetween(t.startDate, date) < 0 ? 1 : t.days);
  const sameDay = t.stops.filter(s => s.day === day);
  if (trip && sameDay.some(s => s.placeId === place.id)) return trip;
  const start = at.start ?? freeStart(sameDay, date === clock.date ? clock.minute : DAY_STARTS, place.visitMinutes || DEFAULT_STOP_MINUTES);
  const stop: Stop = {
    id: `stop-${Date.now().toString(36)}-${(stopCounter++).toString(36)}`,
    title: place.name,
    placeId: place.id,
    day,
    start,
    durationMinutes: place.visitMinutes,
    fixed: false,
  };
  return { ...t, stops: sortStops([...t.stops, stop]) };
}

/** The first quarter hour from `from` when a visit of `minutes` overlaps none of the stops; undefined past 23:00. */
function freeStart(stops: Stop[], from: number, minutes: number): string | undefined {
  const busy = stops
    .map(s => {
      try {
        const start = s.start ? parseHHMM(s.start) : undefined;
        return start === undefined ? undefined : { start, end: start + (s.durationMinutes || DEFAULT_STOP_MINUTES) };
      } catch {
        return undefined;
      }
    })
    .filter((b): b is { start: number; end: number } => !!b)
    .sort((a, b) => a.start - b.start);
  let m = Math.ceil(from / 15) * 15;
  for (const b of busy) if (m < b.end && m + minutes > b.start) m = Math.ceil(b.end / 15) * 15;
  return m <= 23 * 60 ? formatHHMM(m) : undefined;
}

/** The trip at a new length. Stops after the new last day go; the rest stay as they are. */
export function resize(trip: Trip, days: number, note?: string): Trip {
  const n = Math.max(1, Math.min(MAX_TRIP_DAYS, Math.round(days)));
  return {
    ...trip,
    days: n,
    stops: trip.stops.filter(s => s.day <= n),
    description: note ? [trip.description, note].filter(Boolean).join('\n') : trip.description,
  };
}

/**
 * The planner finds the base's point from its name in the guide; a hotel the traveller placed on
 * the map ("my hotel is here") isn't in it, so a later edit would lose the point. Keep it.
 */
export function keepBasePoint(before: Trip | undefined, after: Trip): Trip {
  const old = before?.base;
  const now = after.base;
  if (!old?.point || !now || now.point || fold(now.name).replace(/^near /, '') !== fold(old.name).replace(/^near /, '')) return after;
  return { ...after, base: { ...now, point: old.point, placeId: now.placeId ?? old.placeId } };
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Tuesday 17 November" */
export function spokenDate(date: string): string {
  return `${WEEKDAY_NAMES[weekday(date)]} ${Number(date.slice(8, 10))} ${MONTH_NAMES[Number(date.slice(5, 7)) - 1]}`;
}

/** A change of length, said aloud: "Your trip is now 5 days, until Thursday 19 November." */
export function describeStay(before: Trip, after: Trip, asked: number): string {
  const end = spokenDate(addDays(after.startDate, after.days - 1));
  const capped = asked > MAX_TRIP_DAYS ? `, the most I can plan` : '';
  const length = `${after.days} day${after.days > 1 ? 's' : ''}`;
  if (after.days === before.days) return `Your trip is already ${length}${capped}, until ${end}.`;
  const removed = before.stops.filter(s => !after.stops.some(a => a.id === s.id)).map(s => s.title);
  let s = `Your trip is now ${length}${capped}, until ${end}.`;
  if (removed.length) s += ` I took ${listOf(removed)} off: ${removed.length > 1 ? 'they were' : 'it was'} after that.`;
  if (after.days > before.days) s += ' The new days are on Now.';
  return s;
}

function listOf(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0];
}

/** What an edit changed, said aloud: "Moved Museum ticket to Monday at 15:00." */
export function describeChanges(before: Trip, after: Trip): string {
  const when = (trip: Trip, s: Stop) => {
    const date = addDays(trip.startDate, s.day - 1);
    return `${WEEKDAY_NAMES[weekday(date)]}${s.start ? ` at ${s.start}` : ''}`;
  };
  const key = (s: Stop) => s.placeId ?? s.title.toLowerCase();
  const out: string[] = [];
  for (const s of after.stops) {
    const old = before.stops.find(b => key(b) === key(s));
    if (!old) out.push(`Added ${s.title} on ${when(after, s)}.`);
    else if (old.day !== s.day || old.start !== s.start) out.push(`Moved ${s.title} to ${when(after, s)}.`);
  }
  for (const b of before.stops) {
    if (!after.stops.some(s => key(s) === key(b))) out.push(`Removed ${b.title}.`);
  }
  if (after.days !== before.days) out.push(`Your trip is now ${after.days} day${after.days > 1 ? 's' : ''}.`);
  if (after.base?.name && after.base.name !== before.base?.name) out.push(`You're staying ${after.base.name.replace(/^(?!near\b)/i, 'at ')}.`);
  return out.length ? out.slice(0, 3).join(' ') : 'Nothing changed in your plan. Tell me again what to change?';
}

function confirmTrip(trip: Trip): string {
  const booked = trip.stops.filter(s => s.fixed);
  const parts = [`Got it: ${trip.days} day${trip.days > 1 ? 's' : ''}`];
  // The model often keeps the word "near" in the base ("near the old town"); don't say it twice.
  if (trip.base) parts.push(`staying near ${trip.base.name.replace(/^(near|by|in|at)\s+/i, '')}`);
  if (trip.interests.length) parts.push(`into ${trip.interests.slice(0, 3).join(', ')}`);
  let s = parts.join(', ') + '.';
  if (booked.length) s += ` I'll plan around ${booked.map(b => b.title).join(' and ')}.`;
  return s + ' Check the plan on screen and tell me anything to fix.';
}

// ---------------------------------------------------------------------------
// Facts

/** Questions about a place itself: its story, its facts, whether to go. */
const ABOUT =
  /\b(histor\w*|story|stories|facts?|trivia|legend|tell me (more )?about|worth|built|famous|special|interesting|what is (it|this|that)|what's (it|this|that)|who (built|made|designed)|when was|how old|why is|should i (go|see|visit)|about (it|this|that|here))\b/;
/** "Tell me more", "go on": more about the place on screen (or the last answer's). */
const FOLLOW_UP = /^(?:(?:ok(?:ay)?|so|and|yes|yeah|wow|cool|nice|interesting)[,.!]? )*(?:tell me more|more|go on|keep going)(?: please)?[?.!]*$/;
/** "it", "this place", "here": a question that points at a place instead of naming it. */
const POINTING = /\b(it|its|it's|this|that|this place|that place|this one|that one|there|here|around here|nearby|where i am)\b/;
/** A request for a fact, with no other topic: "tell me a historical fact", "any fun facts here?" */
const FACT_REQUEST =
  /^(?:(?:ok(?:ay)?|so|hey|buddy|please|and|also|now|then)[,]? )*(?:can you |could you |would you |will you )?(?:please )?(?:tell me|give me|show me|share|teach me|got|know|do you (?:have|know)|i(?:'d| would) like|i want|what's|what is)? ?(?:a|an|some|another|any|one|more|the)? ?(?:more )?(?:historical|history|fun|interesting|random|cool|local|quick|little)? ?(?:facts?|history|trivia|story|stories)(?: (?:about|of|for|on) (?:it|this|that|here|this place|that place|there|around here|nearby|where i am))?(?: here| around here| nearby)?(?: please)?[?.!]*$/;

const TOPIC_WORDS: [RegExp, Interest][] = [
  [/\b(histor\w*|old|built|story|stories|legend|when was|how old)\b/, 'history'],
  [/\b(architect\w*|design\w*|building|built)\b/, 'architecture'],
  [/\b(art|paint\w*|artist)\b/, 'art'],
  [/\b(food|eat|dish|tapas|drink)\b/, 'food'],
  [/\b(church|religio\w*|saint|pray\w*)\b/, 'religion'],
  [/\b(view|views|sunset|rooftop)\b/, 'views'],
];

function topicsOf(t: string): Interest[] {
  return TOPIC_WORDS.filter(([re]) => re.test(t)).map(([, tag]) => tag);
}

/** A place's facts with those on the question's topic first ("history" → history facts). */
export function rankFacts(facts: Fact[], question: string): Fact[] {
  const topic = topicsOf(normalize(question));
  if (!topic.length) return facts;
  const on = (f: Fact) => f.tags.some(t => topic.includes(t));
  return [...facts.filter(on), ...facts.filter(f => !on(f))];
}

/**
 * The source numbers the model put after its sentences ("[2]", "[1, 3]"), in order, each with
 * the words it was put after (since the previous number), so code can check the claim.
 */
export function citations(raw: string): { n: number; claim: string }[] {
  const out: { n: number; claim: string }[] = [];
  let from = 0;
  for (const m of raw.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    const claim = raw.slice(from, m.index).trim();
    from = (m.index ?? 0) + m[0].length;
    for (const n of m[1].split(',').map(Number)) out.push({ n, claim });
  }
  return out;
}

/** The answer without its source numbers, as shown and spoken. */
export function stripCitations(text: string): string {
  return text
    .replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '')
    .replace(/\s+([.,;!?])/g, '$1')
    .replace(/ {2,}/g, ' ');
}

/** A sentence about the sources rather than the city, which the decline filter lets through. */
function isAboutSources(s: string): boolean {
  return /\b(they|it|these|this) (do|does) not (provide|mention|say|specify|include|give)\b|\bno (information|mention|details) (about|on|of)\b|\bnot (mentioned|specified|provided) in\b/i.test(s);
}

const WEAK = new Set('this that with from were was have has they their them there which while into also than then been being about after before over under very most more some such only your what when where'.split(' '));

/** How many telling words (4+ letters) of a fact an answer repeats. */
function overlap(answer: string, fact: string): number {
  const words = (s: string) => new Set(fold(s).split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !WEAK.has(w)));
  const a = words(answer);
  let n = 0;
  for (const w of words(fact)) if (a.has(w)) n++;
  return n;
}

/**
 * An answer from the facts themselves, for when the model declined a question about a place
 * the guide knows: its best fact on the topic, else its summary. Wikipedia's bracketed
 * pronunciations and transliterations are left out: they are read aloud.
 */
function factAnswer(place: Place, facts: Fact[], question: string): string | undefined {
  const tidy = (s: string) => s.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  const [best] = rankFacts(facts.filter(f => f.placeId === place.id), question);
  if (best && topicsOf(normalize(question)).length) {
    const sentences = tidy(best.body).match(/[^.!?]+[.!?]+/g) ?? [tidy(best.body)];
    return sentences.slice(0, 2).join(' ').trim();
  }
  return `${place.name}: ${tidy(place.summary)}`;
}
