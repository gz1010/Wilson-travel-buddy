import { formatDistance } from './geo';
import type { PackIndex, SearchHit } from './pack';
import { NOT_IN_GUIDE, prompts } from './prompts';
import { formatClock } from './time';
import { summarizeTrip } from './trip';
import type { LLMClient, Place, Situation, Trip } from './types';

const NEARBY = /\b(near|nearby|around here|close by|close to|walking distance|cerca)\b/i;

/** Answers questions from the pack, streaming the reply. */
export class Guide {
  constructor(private llm: LLMClient, private index: PackIndex) {}

  sources(question: string, sit: Situation, trip?: Trip): SearchHit[] {
    const hits = this.index.query(question, 5, ['place', 'fact']);
    if (NEARBY.test(question)) {
      // "near my hotel" means the hotel, not the current location.
      const anchor = /hotel|staying/i.test(question) && trip?.base?.point ? trip.base.point : sit.location;
      for (const { place, meters } of this.index.nearest(anchor, 6)) {
        if (place.category === 'hotel' || hits.some(h => h.id === place.id)) continue;
        hits.push({ kind: 'place', id: place.id, title: place.name, text: `${place.summary} (${formatDistance(meters)} away)`, placeId: place.id, score: 0 });
      }
    }
    return hits.slice(0, 8);
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
    const text = await this.llm.stream(
      {
        tag: 'guide',
        maxTokens: 220,
        messages: [
          { role: 'system', content: prompts.guide(this.index.destination.name) },
          { role: 'user', content: `${context}\n\nQuestion: ${question}` },
        ],
      },
      onToken,
    );
    return { text, places: this.index.placesMentionedIn(text) };
  }
}
