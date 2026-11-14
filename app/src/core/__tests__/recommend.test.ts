import { FixtureLLM, type FixtureAnswer } from '../../services/llm/fixtureLLM';
import { seville } from '../../pack/seville';
import { PackIndex } from '../pack';
import { picksSchema, Recommender, spokenSummary, withTimeout } from '../recommend';
import { templateReason } from '../scoring';
import type { ChatRequest, JSONSchema, LLMClient, Situation, Trip } from '../types';

const index = new PackIndex(seville);
const date = '2026-11-17'; // Tuesday
const trip: Trip = {
  startDate: '2026-11-15',
  days: 3,
  interests: ['food', 'architecture'],
  stops: [{ id: 's1', title: 'Museum of Fine Arts', placeId: 'bellas-artes', day: 3, start: '15:00', fixed: true }],
  description: '',
};
const sit: Situation = {
  clock: { date, minute: 13 * 60 },
  location: seville.destination.center,
  locationLabel: 'Old town',
  visited: [],
};

const enumOf = (schema?: JSONSchema): string[] => (schema as any).properties.picks.items.properties.place_id.enum;
const rec = (answer: FixtureAnswer) => {
  const llm = new FixtureLLM({ recommend: answer }, 0);
  return { llm, r: new Recommender(llm, index, 200) };
};

describe('picksSchema', () => {
  test('place IDs are an enum of the candidates, so the grammar cannot invent a place', () => {
    const candidates = new Recommender(new FixtureLLM({}), index).candidates(trip, sit);
    const schema = picksSchema(candidates);
    expect(enumOf(schema)).toEqual(candidates.map(c => c.place.id));
    expect((schema as any).properties.picks.maxItems).toBe(3);
  });
});

describe('Recommender', () => {
  test('quick() gives three code-written reasons instantly', () => {
    const { r } = rec('{}');
    const quick = r.quick(trip, sit);
    expect(quick).toHaveLength(3);
    for (const q of quick) {
      expect(q.fromModel).toBe(false);
      expect(q.reason).toBe(templateReason(q.candidate));
    }
  });

  test('refine() keeps the model order and reasons for valid picks', async () => {
    const { llm, r } = rec((_req, schema) => {
      const ids = enumOf(schema);
      return JSON.stringify({
        picks: [
          { place_id: ids[2], reason: 'Third on the list, but the model liked it best.' },
          { place_id: ids[0], reason: 'Close by and you like food.' },
        ],
      });
    });
    const recs = await r.refine(trip, sit);
    const ids = enumOf(llm.calls[0].schema);
    expect(recs.map(x => x.placeId)).toEqual([ids[2], ids[0]]);
    expect(recs.every(x => x.fromModel)).toBe(true);
  });

  test('an unknown ID is rejected; a duplicate is dropped; an empty reason gets a code-written one', async () => {
    const { llm, r } = rec((_req, schema) => {
      const ids = enumOf(schema);
      return JSON.stringify({
        picks: [
          { place_id: 'sagrada-familia', reason: 'Not in Seville at all.' },
          { place_id: ids[1], reason: '   ' },
          { place_id: ids[1], reason: 'Same place twice.' },
        ],
      });
    });
    const recs = await r.refine(trip, sit);
    const ids = enumOf(llm.calls[0].schema);
    expect(recs).toHaveLength(1);
    expect(recs[0].placeId).toBe(ids[1]);
    expect(recs[0].fromModel).toBe(false);
    expect(recs[0].reason).toBe(templateReason(recs[0].candidate));
  });

  test('falls back to quick() when every pick is invalid', async () => {
    const { r } = rec(JSON.stringify({ picks: [{ place_id: 'nowhere', reason: 'x' }] }));
    const recs = await r.refine(trip, sit);
    expect(recs.map(x => x.placeId)).toEqual(r.quick(trip, sit).map(x => x.placeId));
  });

  test('falls back on bad JSON, an error, or a slow model', async () => {
    const quickIds = rec('{}').r.quick(trip, sit).map(x => x.placeId);
    expect((await rec('not json').r.refine(trip, sit)).map(x => x.placeId)).toEqual(quickIds);

    const failing: LLMClient = { name: 'x', stream: async () => '', json: async () => Promise.reject(new Error('down')) };
    expect((await new Recommender(failing, index).refine(trip, sit)).map(x => x.placeId)).toEqual(quickIds);

    const slow: LLMClient = { name: 'x', stream: async () => '', json: () => new Promise(() => {}) };
    expect((await new Recommender(slow, index, 50).refine(trip, sit)).map(x => x.placeId)).toEqual(quickIds);
  });

  test('the model sees computed facts, not raw data: time, interests, next booking, candidate notes', async () => {
    const { llm, r } = rec((_req, schema) => JSON.stringify({ picks: [{ place_id: enumOf(schema)[0], reason: 'ok' }] }));
    await r.refine(trip, sit);
    const req: ChatRequest = llm.calls[0].req;
    const ctx = req.messages[1].content;
    expect(ctx).toContain('Now: Tue 13:00, near Old town.');
    expect(ctx).toContain('They like: food, architecture.');
    expect(ctx).toContain('Next booking: Museum of Fine Arts at 15:00 (in 120 min).');
    expect(ctx).toMatch(/- id=\S+ \| .+ \| \d+ min walk/);
    expect(ctx).toContain('Sunset: ');
  });

  test('the booked museum is never recommended on its own day', () => {
    const { r } = rec('{}');
    expect(r.candidates(trip, sit).map(c => c.place.id)).not.toContain('bellas-artes');
  });

  test('nothing open nearby gives an empty list, and refine() does not call the model', async () => {
    const { llm, r } = rec('{}');
    // Squares are open all night, so "nothing fits" means out of walking range.
    const faraway = { ...sit, location: { lat: 37.6, lon: -5.6 } };
    expect(r.candidates(trip, faraway)).toEqual([]);
    expect(await r.refine(trip, faraway)).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });
});

describe('spokenSummary', () => {
  test('names the top pick with its reason, then the others', async () => {
    const { r } = rec('{}');
    const recs = r.quick(trip, sit);
    const s = spokenSummary(recs);
    expect(s.startsWith(`${recs[0].candidate.place.name}. ${recs[0].reason}`)).toBe(true);
    expect(s).toContain(`Or try ${recs[1].candidate.place.name} or ${recs[2].candidate.place.name}.`);
  });

  test('says so when nothing fits', () => {
    expect(spokenSummary([])).toMatch(/Nothing nearby/);
  });
});

describe('withTimeout', () => {
  test('passes values and errors through, and times out', async () => {
    await expect(withTimeout(Promise.resolve(1), 50)).resolves.toBe(1);
    await expect(withTimeout(Promise.reject(new Error('x')), 50)).rejects.toThrow('x');
    await expect(withTimeout(new Promise(() => {}), 10)).rejects.toThrow('Timed out');
  });
});
