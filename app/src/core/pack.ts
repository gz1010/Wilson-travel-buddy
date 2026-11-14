import MiniSearch from 'minisearch';
import { distanceMeters } from './geo';
import type { Fact, ForecastHour, GeoPoint, Pack, Place, Clock } from './types';
import { formatHHMM } from './time';

export interface SearchHit {
  kind: 'place' | 'fact' | 'phrase';
  id: string;
  title: string;
  text: string;
  placeId?: string;
  score: number;
}

interface Doc {
  key: string;
  kind: SearchHit['kind'];
  id: string;
  title: string;
  text: string;
  tags: string;
  placeId?: string;
}

/** Lower-case and strip accents, so "Alcazar" finds "Alcázar". */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

const STOP_WORDS = new Set(
  'a an and are at be can de del do does el for from how i in is it la las los me my near of on or the there this to what when where which who why with y you'.split(
    ' ',
  ),
);

/**
 * The destination pack with full-text search. Everything is in memory: at
 * a hundred places and a few hundred facts there is no need for a database.
 */
export class PackIndex {
  readonly pack: Pack;
  private readonly search: MiniSearch<Doc>;
  private readonly placesById: Map<string, Place>;
  private readonly nameIndex: { place: Place; names: string[] }[];

  constructor(pack: Pack) {
    this.pack = pack;
    this.placesById = new Map(pack.places.map(p => [p.id, p]));
    this.search = new MiniSearch<Doc>({
      idField: 'key',
      fields: ['title', 'text', 'tags'],
      storeFields: ['kind', 'id', 'title', 'text', 'placeId'],
      processTerm: term => {
        const t = fold(term);
        return STOP_WORDS.has(t) ? null : t;
      },
      searchOptions: { boost: { title: 3, tags: 1.5 }, prefix: true, fuzzy: 0.2 },
    });
    const docs: Doc[] = [
      ...pack.places.map(p => ({
        key: `place:${p.id}`,
        kind: 'place' as const,
        id: p.id,
        title: p.localName ? `${p.name} (${p.localName})` : p.name,
        text: `${p.summary} ${p.neighborhood ?? ''} ${p.category}`,
        tags: p.tags.join(' '),
        placeId: p.id,
      })),
      ...pack.facts.map(f => ({
        key: `fact:${f.id}`,
        kind: 'fact' as const,
        id: f.id,
        title: f.title,
        text: f.body,
        tags: f.tags.join(' '),
        placeId: f.placeId,
      })),
      ...pack.phrases.map(ph => ({
        key: `phrase:${ph.id}`,
        kind: 'phrase' as const,
        id: ph.id,
        title: ph.en,
        text: ph.local,
        tags: ph.category,
      })),
    ];
    this.search.addAll(docs);

    this.nameIndex = pack.places.map(place => {
      const names = [place.name, place.localName, ...(place.aliases ?? [])]
        .filter((n): n is string => !!n)
        .flatMap(n => {
          const f = fold(n);
          // "Real Alcázar de Sevilla" should also match "the Alcázar".
          const short = f.replace(/\b(de|del|la|el|los|las|of|the|real|sevilla|seville)\b/g, ' ').replace(/\s+/g, ' ').trim();
          return short && short !== f && short.length >= 4 ? [f, short] : [f];
        });
      return { place, names };
    });
  }

  get destination() {
    return this.pack.destination;
  }

  place(id: string): Place | undefined {
    return this.placesById.get(id);
  }

  query(text: string, limit = 6, kinds?: SearchHit['kind'][]): SearchHit[] {
    const hits = this.search.search(text, kinds ? { filter: r => kinds.includes(r.kind) } : undefined);
    return hits.slice(0, limit).map(h => ({
      kind: h.kind,
      id: h.id,
      title: h.title,
      text: h.text,
      placeId: h.placeId,
      score: h.score,
    }));
  }

  facts(placeId: string): Fact[] {
    return this.pack.facts.filter(f => f.placeId === placeId);
  }

  nearest(point: GeoPoint, limit = 5): { place: Place; meters: number }[] {
    return this.pack.places
      .map(place => ({ place, meters: distanceMeters(point, place.point) }))
      .sort((a, b) => a.meters - b.meters)
      .slice(0, limit);
  }

  /** Finds a place the user named ("the cathedral", "Plaza de España"). */
  findPlace(text: string): Place | undefined {
    const t = fold(text);
    let best: { place: Place; len: number } | undefined;
    for (const { place, names } of this.nameIndex) {
      for (const n of names) {
        if (t.includes(n) && (!best || n.length > best.len)) best = { place, len: n.length };
      }
    }
    if (best) return best.place;
    // Fall back to titles only, and only when one place clearly wins: matching on summaries
    // sent "the old town" to a park whose summary mentions the old town.
    const hits = this.search.search(text, { fields: ['title'], fuzzy: false, prefix: false, filter: r => r.kind === 'place' });
    if (hits.length === 1 || (hits[0] && hits[0].score > 1.5 * hits[1].score)) return this.place(hits[0].id);
    return undefined;
  }

  /** Places whose names appear in a piece of text, in order of appearance. */
  placesMentionedIn(text: string): Place[] {
    const t = fold(text);
    const found: { place: Place; at: number }[] = [];
    for (const { place, names } of this.nameIndex) {
      const at = Math.min(...names.map(n => (n.length >= 4 ? t.indexOf(n) : -1)).map(i => (i < 0 ? Infinity : i)));
      if (at !== Infinity) found.push({ place, at });
    }
    return found.sort((a, b) => a.at - b.at).map(f => f.place);
  }

  /** The saved forecast for the hour containing the clock, if the pack covers it. */
  forecastAt(clock: Clock): ForecastHour | undefined {
    const key = `${clock.date}T${formatHHMM(Math.floor(clock.minute / 60) * 60)}`;
    return this.pack.forecast.hours.find(h => h.time === key);
  }

  /** Forecast hours from the clock onward, for the next `hours` hours. */
  forecastAhead(clock: Clock, hours: number): ForecastHour[] {
    const start = `${clock.date}T${formatHHMM(Math.floor(clock.minute / 60) * 60)}`;
    const i = this.pack.forecast.hours.findIndex(h => h.time === start);
    return i < 0 ? [] : this.pack.forecast.hours.slice(i, i + hours);
  }
}
