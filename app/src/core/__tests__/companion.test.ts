import { FixtureLLM, type FixtureAnswer } from '../../services/llm/fixtureLLM';
import { seville } from '../../pack/seville';
import { DefaultCompanion, describeChanges } from '../companion';
import { PackIndex } from '../pack';
import { NOT_IN_GUIDE } from '../prompts';
import type { CompanionEvent, Situation, Trip } from '../types';

const index = new PackIndex(seville);
const sit: Situation = {
  clock: { date: '2026-11-15', minute: 13 * 60 },
  location: seville.destination.center,
  locationLabel: 'Old town',
  visited: [],
};

const TRIP_ANSWER = JSON.stringify({
  days: 3,
  base_area: 'Santa Cruz',
  interests: ['food', 'architecture'],
  stops: [{ title: 'Museum ticket', place_name: null, day: 3, start: '15:00', duration_minutes: null, fixed: true }],
});

function setup(answers: Record<string, FixtureAnswer>, start?: Trip) {
  let trip = start;
  const saved: Trip[] = [];
  const llm = new FixtureLLM(answers, 0);
  const companion = new DefaultCompanion(llm, index, {
    trip: () => trip,
    situation: () => sit,
    saveTrip: async t => {
      trip = t;
      saved.push(t);
    },
  });
  const run = async (text: string) => {
    const events: CompanionEvent[] = [];
    await companion.handle(text, e => events.push(e));
    return events;
  };
  return { llm, run, saved, trip: () => trip };
}
const types = (events: CompanionEvent[]) => events.map(e => e.type);
const done = (events: CompanionEvent[]) => (events.at(-1) as { type: 'done'; text: string }).text;

test('first message with no trip sets the trip up, saves it and confirms aloud', async () => {
  const { run, saved } = setup({ 'trip.extract': TRIP_ANSWER });
  const events = await run("I'm here three days, staying near the old town, I love street food and architecture, Tuesday afternoon I have a museum ticket");
  expect(types(events)).toEqual(['status', 'trip', 'done']);
  expect(saved).toHaveLength(1);
  expect(saved[0].stops[0]).toMatchObject({ day: 3, start: '15:00', fixed: true });
  expect(done(events)).toBe(
    "Got it: 3 days, staying near Santa Cruz, into food, architecture. I'll plan around Museum ticket. Check the plan on screen and tell me anything to fix.",
  );
});

test('"what should I do now?" shows instant picks, then the model\'s, moves the map and speaks the top one', async () => {
  const { run } = setup(
    {
      'trip.extract': TRIP_ANSWER,
      recommend: (_req, schema) => {
        const ids: string[] = (schema as any).properties.picks.items.properties.place_id.enum;
        return JSON.stringify({ picks: [{ place_id: ids[1], reason: 'Short walk, and you like food.' }] });
      },
    },
  );
  await run("I'm here three days, Tuesday afternoon I have a museum ticket");
  const events = await run('What should I do now?');
  expect(types(events)).toEqual(['recommendations', 'status', 'recommendations', 'focus', 'done']);
  const final = events[2] as Extract<CompanionEvent, { type: 'recommendations' }>;
  expect(final.items).toHaveLength(1);
  expect(final.items[0].fromModel).toBe(true);
  expect(events[3]).toEqual({ type: 'focus', placeId: final.items[0].placeId });
  expect(done(events)).toBe(`${final.items[0].candidate.place.name}. Short walk, and you like food.`);
});

test('a guide question streams tokens and focuses the first place named', async () => {
  const { run } = setup({ 'trip.extract': TRIP_ANSWER, guide: 'Seville Cathedral holds the tomb of Columbus.' });
  await run("I'm here three days");
  const events = await run('Tell me about Columbus');
  expect(types(events).filter(t => t !== 'token')).toEqual(['focus', 'done']);
  expect(events.filter(e => e.type === 'token').length).toBeGreaterThan(1);
  expect(events.find(e => e.type === 'focus')).toEqual({ type: 'focus', placeId: 'catedral' });
});

test('an off-pack question is declined', async () => {
  const { run, llm } = setup({ 'trip.extract': TRIP_ANSWER, guide: 'Sushi Zanmai in Tsukiji.' });
  await run("I'm here three days");
  const events = await run('What is the best sushi in Tokyo?');
  expect(done(events)).toBe(NOT_IN_GUIDE);
  expect(llm.calls.map(c => c.req.tag)).not.toContain('guide');
});

test('"move the museum to tomorrow" revises and saves the trip', async () => {
  const moved = JSON.parse(TRIP_ANSWER);
  moved.stops[0].day = 2;
  const { run, saved } = setup({ 'trip.extract': TRIP_ANSWER, 'trip.revise': JSON.stringify(moved) });
  await run("I'm here three days, Tuesday afternoon I have a museum ticket");
  const events = await run('Move the museum to tomorrow');
  expect(types(events)).toEqual(['status', 'trip', 'done']);
  expect(saved.at(-1)!.stops[0].day).toBe(2);
  expect(done(events)).toBe('Moved Museum ticket to Monday at 15:00.');
});

describe('describeChanges', () => {
  const base: Trip = {
    startDate: '2026-11-15',
    days: 3,
    interests: [],
    description: '',
    stops: [
      { id: 'a', title: 'Museum ticket', day: 3, start: '15:00', fixed: true },
      { id: 'b', title: 'Flamenco show', placeId: 'casa-memoria', day: 1, start: '19:00', fixed: true },
    ],
  };
  test('added, removed, and a longer trip; stop IDs may change between versions', () => {
    const after: Trip = {
      ...base,
      days: 4,
      stops: [
        { id: 'x', title: 'Museum ticket', day: 3, start: '15:00', fixed: true },
        { id: 'y', title: 'Alcázar', placeId: 'alcazar', day: 4, fixed: false },
      ],
    };
    expect(describeChanges(base, after)).toBe('Added Alcázar on Wednesday. Removed Flamenco show. Your trip is now 4 days.');
  });
  test('no change says so', () => {
    expect(describeChanges(base, { ...base, stops: base.stops.map(s => ({ ...s, id: s.id + '2' })) })).toMatch(/^Nothing changed/);
  });
});

test('the translator is one spoken request away', async () => {
  const { run } = setup({}, { startDate: '2026-11-15', days: 1, interests: [], stops: [], description: '' });
  expect(types(await run('I need to talk to the waiter'))).toEqual(['translator', 'done']);
});

test('"how do I say thank you" answers from the phrasebook without the model', async () => {
  const { run, llm } = setup({}, { startDate: '2026-11-15', days: 1, interests: [], stops: [], description: '' });
  const events = await run('How do I say thank you?');
  expect(done(events)).toBe('Gracias');
  expect(llm.calls).toHaveLength(0);
});

test('a model failure becomes an error event, not a crash', async () => {
  const { run, saved } = setup({ 'trip.extract': 'not json' });
  const events = await run("I'm here three days");
  expect(types(events)).toEqual(['status', 'error']);
  expect(saved).toHaveLength(0);
});
