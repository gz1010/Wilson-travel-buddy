import { formatDistance } from './geo';
import type { PackIndex, SearchHit } from './pack';
import { NOT_IN_GUIDE, prompts } from './prompts';
import { formatClock } from './time';
import { summarizeTrip } from './trip';
import type { LLMClient, Place, Situation, Trip } from './types';

/** Search hits below this are noise; findPlace uses the same bar. */
const MIN_SOURCE_SCORE = 8;

const NEARBY =/\b(near|nearby|around here|close by|close to|walking distance|cerca)\b/i;

/** Answers questions from the pack, streaming the reply. */
export class Guide {
  constructor(private llm: LLMClient, private index: PackIndex) {}

  sources(question: string, sit: Situation, trip?: Trip): SearchHit[] {
    // Fuzzy search always finds something; weak matches ("sushi in Tokyo" →
    // a tapas fact) only tempt a small model to answer anyway.
    const hits = this.index
      .query(question, 5, ['place', 'fact'])
      .filter(h => h.score >= MIN_SOURCE_SCORE)
      .map(h => {
        // The search document appends neighbourhood and category for matching;
        // the model only needs the summary (seen live: it read "Santa Catalina tapas-bar" aloud).
        const place = h.kind === 'place' ? this.index.place(h.id) : undefined;
        return place ? { ...h, text: place.neighborhood ? `${place.summary} (${place.neighborhood})` : place.summary } : h;
      });
    if (!NEARBY.test(question)) return hits;
    // "near my hotel" means the hotel, not the current location. Nearby
    // places go first: for these questions they are the answer.
    const anchor = /hotel|staying/i.test(question) && trip?.base?.point ? trip.base.point : sit.location;
    const nearby: SearchHit[] = this.index
      .nearest(anchor, 7)
      .filter(({ place, meters }) => place.category !== 'hotel' && meters > 0)
      .slice(0, 5)
      .map(({ place, meters }) => ({
        kind: 'place',
        id: place.id,
        title: place.name,
        text: `${place.summary} (${formatDistance(meters)} away)`,
        placeId: place.id,
        score: 0,
      }));
    return [...nearby, ...hits.filter(h => !nearby.some(n => n.id === h.id))].slice(0, 8);
  }

  async answer(question: string, sit: Situation, trip: Trip | undefined, onToken: (t: string) => void): Promise<{ text: string; places: Place[] }> {
    const sources = this.sources(question, sit, trip);
    if (sources.length === 0) {
      onToken(NOT_IN_GUIDE);
      return { text: NOT_IN_GUIDE, places: [] };
    }
    const context = [
      `Now: ${formatClock(sit.clock)}, near ${sit.locationLabel}.`,
      trip ? `Their trip:\n${summarizeTrip(trip, this.index)}` : '',
      'SOURCES:',
      ...sources.map((s, i) => `[${i + 1}] ${s.title}: ${s.text}`),
    ]
      .filter(Boolean)
      .join('\n');
    const filter = new DeclineFilter(onToken);
    await this.llm.stream(
      {
        tag: 'guide',
        maxTokens: 220,
        messages: [
          { role: 'system', content: prompts.guide(this.index.destination.name) },
          { role: 'user', content: `${context}\n\nQuestion: ${question}` },
        ],
      },
      t => filter.push(t),
    );
    const text = filter.end();
    return { text, places: this.index.placesMentionedIn(text) };
  }
}

/**
 * Bonsai-2 sometimes adds the refusal after a real answer ("…buried in the
 * Cathedral. That isn't in my guide for this trip.") or talks about its
 * sources ("No, the sources do not mention tap water."), which read aloud
 * sounds like an answer. This passes the reply through a sentence at a time
 * and drops those sentences, so they are never shown or spoken; if nothing
 * is left, the reply is the refusal.
 */
export class DeclineFilter {
  private tail = '';
  private out = '';

  constructor(private onToken: (t: string) => void) {}

  push(token: string): void {
    this.tail += token;
    let m: RegExpExecArray | null;
    const end = /[.!?…]["”')\]]*\s+/g;
    let cut = 0;
    while ((m = end.exec(this.tail))) {
      this.sentence(this.tail.slice(cut, m.index + m[0].length));
      cut = m.index + m[0].length;
    }
    this.tail = this.tail.slice(cut);
  }

  /** Call when the stream ends; returns everything shown. */
  end(): string {
    this.sentence(this.tail);
    this.tail = '';
    if (!this.out) this.emit(NOT_IN_GUIDE);
    return this.out;
  }

  private sentence(raw: string): void {
    const s = raw.trim();
    if (!s || isMeta(s)) return;
    this.emit(this.out ? ` ${s}` : s);
  }

  private emit(text: string): void {
    this.out += text;
    this.onToken(text);
  }
}

/** A sentence about the guide rather than the city. */
function isMeta(s: string): boolean {
  return s.includes(NOT_IN_GUIDE.slice(0, -1)) || /\b(the|my|these|your|our) (sources?|guide)\b/i.test(s);
}
