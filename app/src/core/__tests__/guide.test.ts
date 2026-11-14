import { FixtureLLM } from '../../services/llm/fixtureLLM';
import { seville } from '../../pack/seville';
import { distanceMeters } from '../geo';
import { Guide } from '../guide';
import { PackIndex } from '../pack';
import { NOT_IN_GUIDE } from '../prompts';
import type { Situation, Trip } from '../types';

const index = new PackIndex(seville);
const sit: Situation = {
  clock: { date: '2026-11-17', minute: 11 * 60 },
  location: index.place('setas')!.point,
  locationLabel: 'Las Setas',
  visited: [],
};
const trip: Trip = {
  startDate: '2026-11-15',
  days: 3,
  base: { name: 'Santa Cruz', placeId: 'santa-cruz', point: index.place('santa-cruz')!.point },
  interests: ['food', 'architecture'],
  stops: [],
  description: '',
};
const guideWith = (answer: string) => {
  const llm = new FixtureLLM({ guide: answer }, 0);
  return { llm, guide: new Guide(llm, index) };
};

describe('Guide.sources', () => {
  const { guide } = guideWith('');

  test('a pack question finds the right place and facts', () => {
    const ids = guide.sources('What should I know before visiting the Alcazar?', sit).map(s => s.placeId ?? s.id);
    expect(ids).toContain('alcazar');
  });

  test.each(['What is the best sushi in Tokyo?', 'What is the wifi password?'])(
    'a clearly off-pack question finds no sources: %s',
    q => {
      expect(guide.sources(q, sit)).toEqual([]);
    },
  );

  test('"near my hotel" lists places nearest the hotel first, not nearest the traveller', () => {
    const sources = guide.sources("What's near my hotel?", sit, trip);
    const base = trip.base!.point!;
    const first = sources.slice(0, 5).map(s => index.place(s.placeId!)!);
    expect(first).toHaveLength(5);
    // All five are within a short walk of the hotel, and the hotel area itself is not listed.
    for (const p of first) expect(distanceMeters(base, p.point)).toBeLessThan(800);
    expect(first.map(p => p.id)).not.toContain('santa-cruz');
    expect(sources[0].text).toMatch(/\(\d+ m away\)$/);
  });

  test('"what is near here" anchors on the traveller', () => {
    const sources = guide.sources('What is near here?', sit);
    const nearest = index.nearest(sit.location, 2).find(n => n.meters > 0)!;
    expect(sources[0].placeId).toBe(nearest.place.id);
  });
});

describe('Guide.answer', () => {
  test('no sources: declines at once without calling the model', async () => {
    const { llm, guide } = guideWith('should not be used');
    const tokens: string[] = [];
    const out = await guide.answer('What is the best sushi in Tokyo?', sit, trip, t => tokens.push(t));
    expect(out).toEqual({ text: NOT_IN_GUIDE, places: [] });
    expect(tokens.join('')).toBe(NOT_IN_GUIDE);
    expect(llm.calls).toHaveLength(0);
  });

  test('streams the answer and reports the places it names, in order', async () => {
    const answer = 'Book the Real Alcázar ahead; afterwards Seville Cathedral is two minutes away.';
    const { llm, guide } = guideWith(answer);
    const tokens: string[] = [];
    const out = await guide.answer('What should I know before visiting the Alcazar?', sit, trip, t => tokens.push(t));
    expect(tokens.length).toBeGreaterThan(3);
    expect(tokens.join('')).toBe(answer);
    expect(out.places.map(p => p.id)).toEqual(['alcazar', 'catedral']);

    const prompt = llm.calls[0].req.messages[1].content;
    expect(prompt).toContain('SOURCES:\n[1] ');
    expect(prompt).toContain('Their trip:\n3-day trip');
    expect(prompt).toMatch(/Question: What should I know before visiting the Alcazar\?$/);
  });

  test('a declined answer names no places', async () => {
    const { guide } = guideWith(NOT_IN_GUIDE);
    const out = await guide.answer('Who won the World Cup in 2010?', sit, trip, () => {});
    expect(out.places).toEqual([]);
  });
});
