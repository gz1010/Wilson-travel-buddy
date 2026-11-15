import { FixtureLLM } from '../../services/llm/fixtureLLM';
import { seville } from '../../pack/seville';
import { PackIndex } from '../pack';
import { calendarLines, dayOfWeekday, nextFixedStop, resolveDraft, summarizeTrip, TRIP_SCHEMA, TripPlanner, tripDay, type TripDraft } from '../trip';
import type { Trip } from '../types';

const index = new PackIndex(seville);

// The example from SPEC.md, feature 1.
const SPEC_SENTENCE =
  "I'm here three days, staying near the old town, I love street food and architecture, Tuesday afternoon I have a museum ticket";
// Demo day 1 is Sunday 15 November 2026, so Tuesday is day 3.
const DAY1 = '2026-11-15';

const draft = (over: Partial<TripDraft> = {}): TripDraft => ({
  days: 3,
  base_area: null,
  interests: [],
  stops: [],
  ...over,
});
const stop = (over: Partial<TripDraft['stops'][number]> = {}): TripDraft['stops'][number] => ({
  title: 'Museum',
  place_name: null,
  day: 1,
  start: null,
  duration_minutes: null,
  fixed: false,
  ...over,
});

describe('calendarLines', () => {
  test('spells out weekdays so the model can map "Tuesday" to a day number', () => {
    const lines = calendarLines(DAY1, 3).split('\n');
    expect(lines).toEqual(['day 1 = Sunday 2026-11-15', 'day 2 = Monday 2026-11-16', 'day 3 = Tuesday 2026-11-17']);
  });
});

describe('TripPlanner.extract on the spec sentence', () => {
  // What a well-behaved model returns for SPEC_SENTENCE. Replace with a real
  // Bonsai-2 recording once llama-server is running.
  const answer = JSON.stringify(
    draft({
      base_area: 'the old town',
      interests: ['food', 'architecture'],
      stops: [stop({ title: 'Museum visit (ticket)', day: 3, start: '15:00', fixed: true })],
    }),
  );

  test('sends the description and a calendar starting today, with the schema', async () => {
    const llm = new FixtureLLM({ 'trip.extract': answer }, 0);
    await new TripPlanner(llm, index).extract(SPEC_SENTENCE, DAY1);
    const { req, schema } = llm.calls[0];
    expect(schema).toBe(TRIP_SCHEMA);
    expect(req.messages[1].content).toBe(SPEC_SENTENCE);
    expect(req.messages[0].content).toContain('day 3 = Tuesday 2026-11-17');
  });

  test('shows the Tuesday museum slot as a fixed 15:00 stop on day 3', async () => {
    const llm = new FixtureLLM({ 'trip.extract': answer }, 0);
    const trip = await new TripPlanner(llm, index).extract(SPEC_SENTENCE, DAY1);
    expect(trip.startDate).toBe(DAY1);
    expect(trip.days).toBe(3);
    expect(trip.interests).toEqual(['food', 'architecture']);
    expect(trip.stops).toHaveLength(1);
    const museum = trip.stops[0];
    expect(museum).toMatchObject({ day: 3, start: '15:00', fixed: true });
    expect(tripDay(trip, '2026-11-17')).toBe(3);
  });

  test('an unnamed museum is not pinned to an arbitrary museum in the pack', async () => {
    const llm = new FixtureLLM({ 'trip.extract': answer }, 0);
    const trip = await new TripPlanner(llm, index).extract(SPEC_SENTENCE, DAY1);
    expect(trip.stops[0].placeId).toBeUndefined();
  });

  test('the trip survives a save and reload (JSON round trip)', async () => {
    const llm = new FixtureLLM({ 'trip.extract': answer }, 0);
    const trip = await new TripPlanner(llm, index).extract(SPEC_SENTENCE, DAY1);
    expect(JSON.parse(JSON.stringify(trip))).toEqual(trip);
  });

  test('on Tuesday at 13:00 the museum is the next fixed stop, two hours away', async () => {
    const llm = new FixtureLLM({ 'trip.extract': answer }, 0);
    const trip = await new TripPlanner(llm, index).extract(SPEC_SENTENCE, DAY1);
    const next = nextFixedStop(trip, { date: '2026-11-17', minute: 13 * 60 });
    expect(next?.minutesUntil).toBe(120);
    expect(nextFixedStop(trip, { date: '2026-11-16', minute: 13 * 60 })).toBeUndefined();
  });
});

describe('resolveDraft', () => {
  test('matches named places to the pack', () => {
    const trip = resolveDraft(
      draft({ stops: [stop({ title: 'Fine arts', place_name: 'Museo de Bellas Artes', day: 3, start: '15:00', fixed: true })] }),
      index,
      DAY1,
      '',
    );
    expect(trip.stops[0].placeId).toBe('bellas-artes');
    expect(trip.stops[0].durationMinutes).toBe(index.place('bellas-artes')!.visitMinutes);
  });

  test('a generic place name or title is left unpinned, a real name inside it is not', () => {
    const trip = resolveDraft(
      draft({
        stops: [
          stop({ title: 'Museum', place_name: 'the museum' }),
          stop({ title: 'Museum ticket', place_name: null }),
          stop({ title: 'Tapas dinner', place_name: 'tapas bar' }),
          stop({ title: 'Visit the Alcázar', place_name: null }),
          stop({ title: 'Flamenco', place_name: 'Flamenco Dance Museum' }),
        ],
      }),
      index,
      DAY1,
      '',
    );
    expect(trip.stops.map(s => s.placeId)).toEqual([undefined, undefined, undefined, 'alcazar', 'museo-flamenco']);
  });

  test('matches the base area when it names a place', () => {
    const trip = resolveDraft(draft({ base_area: 'Santa Cruz' }), index, DAY1, '');
    expect(trip.base).toMatchObject({ name: 'Santa Cruz', placeId: 'santa-cruz' });
    expect(trip.base!.point).toBeDefined();
  });

  test('drops interests outside the list and duplicates', () => {
    const trip = resolveDraft(draft({ interests: ['food', 'food', 'surfing' as any, 'architecture'] }), index, DAY1, '');
    expect(trip.interests).toEqual(['food', 'architecture']);
  });

  test('drops a malformed start time instead of crashing', () => {
    const trip = resolveDraft(draft({ stops: [stop({ start: '3pm' })] }), index, DAY1, '');
    expect(trip.stops[0].start).toBeUndefined();
  });

  test('clamps days to 1–14 and stop days to the trip', () => {
    expect(resolveDraft(draft({ days: 0 }), index, DAY1, '').days).toBe(1);
    expect(resolveDraft(draft({ days: 30 }), index, DAY1, '').days).toBe(14);
    const trip = resolveDraft(draft({ days: 2, stops: [stop({ day: 5 })] }), index, DAY1, '');
    expect(trip.stops[0].day).toBe(2);
  });

  test('sorts stops by day, then time, untimed last', () => {
    const trip = resolveDraft(
      draft({
        stops: [
          stop({ title: 'C', day: 2 }),
          stop({ title: 'B', day: 1, start: '18:00' }),
          stop({ title: 'A', day: 1, start: '09:30' }),
          stop({ title: 'D', day: 1 }),
        ],
      }),
      index,
      DAY1,
      '',
    );
    expect(trip.stops.map(s => s.title)).toEqual(['A', 'B', 'D', 'C']);
  });

  test('stop IDs are unique', () => {
    const trip = resolveDraft(draft({ stops: [stop(), stop(), stop()] }), index, DAY1, '');
    expect(new Set(trip.stops.map(s => s.id)).size).toBe(3);
  });
});

describe('TripPlanner.revise', () => {
  const trip: Trip = resolveDraft(
    draft({ stops: [stop({ title: 'Museum of Fine Arts', place_name: 'Museum of Fine Arts', day: 3, start: '15:00', fixed: true })] }),
    index,
    DAY1,
    SPEC_SENTENCE,
  );

  test('"move the museum to tomorrow" on day 2 tells the model today is day 2', async () => {
    const moved = JSON.stringify(
      draft({ stops: [stop({ title: 'Museum of Fine Arts', place_name: 'Museum of Fine Arts', day: 3, start: '15:00', fixed: true })] }),
    );
    const llm = new FixtureLLM({ 'trip.revise': moved }, 0);
    const out = await new TripPlanner(llm, index).revise(trip, 'move the museum to tomorrow', '2026-11-16');
    expect(llm.calls[0].req.messages[0].content).toContain('today is day 2');
    expect(llm.calls[0].req.messages[1].content).toContain('Change: move the museum to tomorrow');
    expect(out.stops[0]).toMatchObject({ day: 3, placeId: 'bellas-artes' });
    expect(out.description).toBe(`${SPEC_SENTENCE}\nmove the museum to tomorrow`);
    expect(out.startDate).toBe(DAY1);
  });

  test('the current trip sent to the model round-trips unchanged', async () => {
    const llm = new FixtureLLM(
      {
        'trip.revise': req => /Current trip:\n(.*)\n\nChange:/s.exec(req.messages[1].content)![1],
      },
      0,
    );
    const out = await new TripPlanner(llm, index).revise(trip, 'nothing', DAY1);
    expect(out.stops.map(({ id, ...s }) => s)).toEqual(trip.stops.map(({ id, ...s }) => s));
    expect(out.interests).toEqual(trip.interests);
    expect(out.days).toBe(trip.days);
  });
});

describe('summarizeTrip', () => {
  test('reads well for the model and the screen', () => {
    const trip = resolveDraft(
      draft({
        base_area: 'Santa Cruz',
        interests: ['food', 'architecture'],
        stops: [stop({ title: 'Museum of Fine Arts', place_name: 'Museum of Fine Arts', day: 3, start: '15:00', fixed: true })],
      }),
      index,
      DAY1,
      '',
    );
    expect(summarizeTrip(trip, index)).toBe(
      [
        '3-day trip starting Sunday 2026-11-15.',
        'Staying near Santa Cruz.',
        'Likes: food, architecture.',
        'Day 3 15:00: Museum of Fine Arts [booked]',
      ].join('\n'),
    );
  });
});

describe('weekday overrides a miscounted day', () => {
  test('dayOfWeekday finds the first trip day on that weekday', () => {
    expect(dayOfWeekday(DAY1, 3, 'Tuesday')).toBe(3); // Sun, Mon, Tue
    expect(dayOfWeekday(DAY1, 3, 'sunday')).toBe(1);
    expect(dayOfWeekday(DAY1, 3, 'Friday')).toBeUndefined(); // not in a 3-day trip
    expect(dayOfWeekday(DAY1, 3, null)).toBeUndefined();
    expect(dayOfWeekday(DAY1, 3, 'Tues')).toBeUndefined();
  });

  test('seen live: the model said Tuesday but day 2; code puts it on day 3', () => {
    const trip = resolveDraft(draft({ stops: [stop({ title: 'museum', weekday: 'Tuesday', day: 2, start: '15:00', fixed: true })] }), index, DAY1, '');
    expect(trip.stops[0].day).toBe(3);
  });

  test('without a weekday, or one outside the trip, the day number stands', () => {
    const trip = resolveDraft(
      draft({ stops: [stop({ title: 'a', weekday: null, day: 2 }), stop({ title: 'b', weekday: 'Friday', day: 1 })] }),
      index,
      DAY1,
      '',
    );
    expect(trip.stops.map(s => s.day)).toEqual([1, 2]);
  });

  test('the schema asks for the weekday before the day', () => {
    const props = Object.keys((TRIP_SCHEMA as any).properties.stops.items.properties);
    expect(props.indexOf('weekday')).toBeLessThan(props.indexOf('day'));
  });
});
