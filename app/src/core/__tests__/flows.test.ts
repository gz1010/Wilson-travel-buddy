/**
 * End to end through Person A's code: what the traveller says in Chat (or to the floating
 * buddy) reaches the trip, Now's day strip, the Map's hotel chip and the facts panel. The model
 * is FixtureLLM; the live run against Bonsai-2 is recorded in the task report, not here.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { seville } from '../../pack/seville';
import { llmAnswers } from '../../fixtures/llmAnswers';
import { FixtureLLM, type FixtureAnswer } from '../../services/llm/fixtureLLM';
import { TypedAudio } from '../../services/audio/typedAudio';
import type { Runtime } from '../../services/runtime';
import { useBuddy, type Buddy } from '../../ui/useBuddy';
import { DefaultCompanion, describeStay, stripCitations, withStop } from '../companion';
import { planDates } from '../dayplan';
import { hotelOf, onlyStayChange, resolveDate, routeIntent, stayChangeOf, stayDays } from '../intent';
import { PackIndex } from '../pack';
import { NOT_IN_GUIDE } from '../prompts';
import { stopsOn, type TripDraft } from '../trip';
import type { CompanionEvent, Situation, Trip } from '../types';

const mockMemory = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (k: string) => mockMemory.get(k) ?? null),
  setItem: jest.fn(async (k: string, v: string) => {
    mockMemory.set(k, v);
  }),
  removeItem: jest.fn(async (k: string) => {
    mockMemory.delete(k);
  }),
}));

const index = new PackIndex(seville);
const TODAY = '2026-11-15'; // a Sunday
const place = (id: string) => index.place(id)!;
const at = (id: string, minute = 13 * 60): Situation => ({ clock: { date: TODAY, minute }, location: place(id).point, locationLabel: place(id).name, visited: [] });
const centre: Situation = { clock: { date: TODAY, minute: 13 * 60 }, location: seville.destination.center, locationLabel: 'the city centre', visited: [] };

const threeDays = (): Trip => ({
  startDate: TODAY,
  days: 3,
  base: { name: 'Santa Cruz', placeId: 'santa-cruz', point: place('santa-cruz').point },
  interests: ['food'],
  stops: [
    { id: 's1', title: 'Real Alcázar', placeId: 'alcazar', day: 1, start: '10:00', durationMinutes: 120, fixed: false },
    { id: 's2', title: 'Flamenco show', placeId: 'casa-memoria', day: 3, start: '19:00', fixed: true },
  ],
  description: "I'm here three days",
});

/** The trip the planner's prompt carries ("Current trip:\n{…}\n\nChange: …"), as the model got it. */
const draftIn = (content: string): TripDraft => JSON.parse(/Current trip:\n(.*)\n\nChange:/s.exec(content)![1]);

function setup(answers: Record<string, FixtureAnswer> = {}, start?: Trip, sit: Situation = centre, focus?: string) {
  let trip = start;
  let now = sit;
  const saved: Trip[] = [];
  const llm = new FixtureLLM({ ...llmAnswers, ...answers }, 0);
  const companion = new DefaultCompanion(llm, index, {
    trip: () => trip,
    situation: () => now,
    saveTrip: async t => {
      trip = t;
      saved.push(t);
    },
    focus: () => focus,
  });
  const run = async (text: string) => {
    const events: CompanionEvent[] = [];
    await companion.handle(text, e => events.push(e));
    return events;
  };
  return {
    llm,
    run,
    saved,
    trip: () => trip,
    moveTo: (s: Situation) => (now = s),
    focusOn: (id?: string) => (focus = id),
  };
}
const done = (events: CompanionEvent[]) => events.find((e): e is Extract<CompanionEvent, { type: 'done' }> => e.type === 'done')!;
const tokens = (events: CompanionEvent[]) => events.filter(e => e.type === 'token').map(e => (e as { text: string }).text).join('');

// ---------------------------------------------------------------------------
describe('"I\'m staying two more days" reaches the trip and Now', () => {
  test('a longer stay is exact, instant (no model), keeps the stops, and Now shows the new days', async () => {
    const { run, saved, llm } = setup({}, threeDays());
    const events = await run("I'm staying two more days");
    expect(llm.calls).toHaveLength(0);
    expect(events.map(e => e.type)).toEqual(['trip', 'done']);
    expect(saved).toHaveLength(1);
    expect(saved[0].days).toBe(5);
    expect(saved[0].stops.map(s => s.id)).toEqual(['s1', 's2']);
    expect(saved[0].base?.placeId).toBe('santa-cruz');
    expect(done(events).text).toBe('Your trip is now 5 days, until Thursday 19 November. The new days are on Now.');
    // What Now's day strip reads (R2's dayplan): one day per trip day.
    expect(planDates(saved[0], TODAY)).toEqual(['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19']);
  });

  test.each([
    ["I’m here until Tuesday", 1, 3], // curly apostrophe, as macOS types it
    ['add a day', 1, 2],
    ['Can you add two more days?', 1, 3],
    ['We decided to stay an extra night', 2, 3],
    ['Extend my trip by three days', 2, 5],
    ["I'm leaving on Friday", 1, 6],
    ['Actually we are here for a week', 3, 7],
    ['Flying home tomorrow', 4, 2],
  ])('"%s" (from %i days) → %i days', async (text, from, to) => {
    const { run, saved } = setup({}, { ...threeDays(), days: from, stops: [] });
    await run(text);
    expect(saved.at(-1)?.days).toBe(to);
  });

  test('a shorter stay takes off the stops after the new last day, and says so', async () => {
    const { run, saved } = setup({}, threeDays());
    const events = await run("I'm leaving a day early");
    expect(saved[0].days).toBe(2);
    expect(saved[0].stops.map(s => s.id)).toEqual(['s1']);
    expect(done(events).text).toBe('Your trip is now 2 days, until Monday 16 November. I took Flamenco show off: it was after that.');
  });

  test('the stay never passes 14 days, and an end before the start is questioned, not saved', async () => {
    const { run, saved } = setup({}, { ...threeDays(), days: 13 });
    expect(done(await run('add three more days')).text).toMatch(/^Your trip is now 14 days, the most I can plan, until /);
    const late = setup({}, { ...threeDays(), startDate: '2026-11-20' });
    const events = await late.run("I'm here until the 18th");
    expect(late.saved).toHaveLength(0);
    expect(done(events).text).toMatch(/can't end before that/);
    expect(saved.at(-1)!.days).toBe(14);
  });

  test('with other changes too, the model edits the stops and code fixes the count it got wrong', async () => {
    const { run, saved, llm } = setup(
      {
        'trip.revise': req => {
          // Bonsai-2 adds the stop but keeps "days" as it was: seen with "two more days".
          const draft = draftIn(req.messages[1].content);
          draft.stops.push({ title: 'Torre del Oro', place_name: 'Torre del Oro', weekday: 'Tuesday', day: 3, start: '11:00', duration_minutes: null, fixed: false });
          return JSON.stringify(draft);
        },
      },
      threeDays(),
    );
    const events = await run("I'm staying two more days and want to see the Torre del Oro on Tuesday");
    expect(llm.calls.map(c => c.req.tag)).toEqual(['trip.revise']);
    expect(saved[0].days).toBe(5);
    expect(saved[0].stops.find(s => s.placeId === 'torre-oro')).toMatchObject({ day: 3, start: '11:00' });
    expect(done(events).text).toMatch(/Added Torre del Oro on Tuesday at 11:00\..*Your trip is now 5 days\./);
  });

  test('with no trip yet, "two more days" counts today: a three-day trip from today', async () => {
    const { run, saved } = setup({ 'trip.extract': JSON.stringify({ days: 2, base_area: null, interests: [], stops: [] }) });
    await run("I'm staying two more days");
    expect(saved[0]).toMatchObject({ startDate: TODAY, days: 3 });
  });

  test('questions about days are not edits', () => {
    expect(routeIntent('Should I stay two more days?', true)).toBe('guide');
    expect(routeIntent('What is there to see in three days?', true)).toBe('guide');
    expect(routeIntent("Let's do the museum another day", true)).toBe('guide');
    expect(routeIntent('The museum is closed for two more days', true)).toBe('guide');
    expect(routeIntent("I'm at the museum until 5 pm", true)).toBe('guide');
    expect(stayChangeOf('add a day trip to Córdoba')).toBeUndefined();
    expect(stayChangeOf('add the Alcazar to day 2')).toBeUndefined();
    expect(routeIntent("How do I say I'm staying two more days", true)).toBe('phrase');
    // Outings are not the stay: these must never cut a trip to one day.
    for (const outing of ['A day at the beach would be nice', "I'd like to stay a day in Cordoba", "I'll be at the museum a day early", 'Two days ago I arrived', 'We have two days left']) {
      expect(stayChangeOf(outing)).toBeUndefined();
    }
    // Clock times, other people's plans and other things' dates are not the end of the stay
    // (each of these once made the trip 14 days or cut it to Tuesday, dropping stops).
    for (const other of [
      "I'm out until 11",
      "I'll be at the cathedral until 3",
      'The flamenco show is until 11',
      "I'm busy until Tuesday",
      'Push the flamenco show until Tuesday',
      'The bus leaves tomorrow',
      'Can we go back tomorrow?',
    ]) {
      expect(stayChangeOf(other)).toBeUndefined();
    }
    expect(stayChangeOf("We're in town till the 20th")).toEqual({ kind: 'until', target: { day: 20 } });
    expect(stayChangeOf("I'm going back tomorrow")).toEqual({ kind: 'until', target: { offset: 1 } });
  });

  test('"push the show until Tuesday" goes to the planner and keeps the trip\'s length', async () => {
    const { run, saved, llm } = setup({}, { ...threeDays(), days: 5 });
    await run('Push the flamenco show until Tuesday');
    expect(llm.calls.map(c => c.req.tag)).toEqual(['trip.revise']);
    expect(saved.at(-1)!.days).toBe(5);
  });

  test('wording: until, leaving and nights; what is only about the length', () => {
    expect(resolveDate({ weekday: 0 }, TODAY)).toBe('2026-11-22'); // "until Sunday", said on a Sunday
    expect(resolveDate({ day: 2 }, TODAY)).toBe('2026-12-02');
    expect(resolveDate({ day: 20, month: 11 }, TODAY)).toBe('2026-11-20');
    expect(stayDays(stayChangeOf("I'm here three nights")!, { startDate: TODAY, days: 1 }, TODAY)).toBe(4);
    expect(onlyStayChange('Actually we are staying two more nights in Seville')).toBe(true);
    expect(onlyStayChange("I'm staying two more days to see Córdoba")).toBe(false);
    expect(describeStay(threeDays(), threeDays(), 3)).toBe('Your trip is already 3 days, until Tuesday 17 November.');
  });
});

// ---------------------------------------------------------------------------
describe('answers carry the guide facts they come from (b.cited)', () => {
  /** Answers like Bonsai-2 does with the answer prompt: sentences with source numbers. */
  /** The prompt's number for a fact: matched on title and text, as several facts share an article title. */
  const sourceNumber = (prompt: string, factId: string) => {
    const f = index.pack.facts.find(x => x.id === factId)!;
    return prompt
      .split('\n')
      .find(l => l.includes(`] ${f.title}: ${f.body.slice(0, 40)}`))
      ?.match(/^\[(\d+)\]/)?.[1];
  };
  const citing = (factId: string, text: string): FixtureAnswer => req => text.replace(/\[n\]/g, `[${sourceNumber(req.messages[1].content, factId)}]`);

  test('"tell me the history of the Torre del Oro": the cited Wikipedia fact first, then the place\'s others', async () => {
    const { run, llm } = setup({
      guide: citing('wiki-torre-oro', 'The Torre del Oro was built by the Almohad Caliphate to guard the river [n]. It later served as a prison [n].'),
    });
    const events = await run('Tell me the history of the Torre del Oro');
    const d = done(events);
    expect(d.text).toBe('The Torre del Oro was built by the Almohad Caliphate to guard the river. It later served as a prison.');
    expect(tokens(events)).toBe(d.text); // the numbers are never shown or spoken
    expect(d.cited?.placeId).toBe('torre-oro');
    // The cited fact first, then the facts the answer repeats ("served as a prison") and the rest
    // of the place's, the hand-written one among them (deepen-facts.mjs adds more per place).
    const ids = d.cited!.facts.map(f => f.id);
    expect(ids[0]).toBe('wiki-torre-oro');
    expect(ids).toContain('torre-oro-name');
    expect(d.cited?.facts.every(f => f.placeId === 'torre-oro')).toBe(true);
    expect(d.cited?.facts[0]).toMatchObject({ source: 'https://en.wikipedia.org/wiki/Torre_del_Oro', license: 'CC BY-SA 4.0' });
    expect(events.find(e => e.type === 'focus')).toEqual({ type: 'focus', placeId: 'torre-oro' });
    // The answer prompt asks for the numbers; the sources carry the new Wikipedia facts.
    expect(llm.calls[0].req.messages[0].content).toMatch(/number of the source/);
    expect(llm.calls[0].req.messages[1].content).toMatch(/Almohad/);
  });

  test('"is the cathedral worth it?" with no numbers: the facts the answer repeats, then the rest of the cathedral\'s', async () => {
    const { run } = setup({ guide: 'Yes: it is one of the largest churches in the world and a World Heritage Site. Book ahead to skip the queue.' });
    const d = done(await run('Is the cathedral worth it?'));
    expect(d.cited?.placeId).toBe('catedral');
    const ids = d.cited!.facts.map(f => f.id);
    // The answer repeats the Wikipedia lead ("largest", "World Heritage"), so it comes first; then
    // the rest of the cathedral's facts, and nothing about another place.
    expect(ids.slice(0, 2)).toContain('wiki-catedral');
    expect(d.cited!.facts.every(f => f.placeId === 'catedral')).toBe(true);
    expect(ids).toEqual(expect.arrayContaining(['giralda-ramps', 'columbus-tomb']));
  });

  test('a source number the answer does not bear out is left out (seen live: Columbus cited to El Salvador)', async () => {
    const { run, llm } = setup({
      guide: req => {
        const p = req.messages[1].content;
        return `You can see Columbus's tomb [${sourceNumber(p, 'wiki-salvador')}]. It is a UNESCO World Heritage Site and the largest Gothic cathedral [${sourceNumber(p, 'wiki-catedral')}].`;
      },
    });
    // The cathedral has so many facts now that a plain "is it worth it?" brings no other place's;
    // naming El Salvador puts its fact among the sources, as in the live case.
    const d = done(await run('Is the cathedral worth it compared with El Salvador?'));
    expect(llm.calls[0].req.messages[1].content).toContain('] Church of San Salvador (Seville):'); // it was among the sources
    expect(d.cited?.facts[0].id).toBe('wiki-catedral');
    expect(d.cited?.facts.map(f => f.id)).not.toContain('wiki-salvador');
  });

  test('a decline about a place the guide knows answers from its facts instead; off-pack stays declined, with no facts', async () => {
    const { run } = setup({ guide: `${NOT_IN_GUIDE} [3]` });
    const d = done(await run('Tell me the history of the Torre del Oro'));
    expect(d.text).not.toBe(NOT_IN_GUIDE);
    expect(d.text).not.toMatch(/\[|\(Arabic/);
    expect(d.cited?.placeId).toBe('torre-oro');
    const off = setup({ guide: NOT_IN_GUIDE });
    const declined = done(await off.run('Who won the World Cup in 2010?'));
    expect(declined.text).toBe(NOT_IN_GUIDE);
    expect(declined.cited).toBeUndefined();
  });

  test('"is it worth it?" is about the place on screen; "a historical fact" about where you are', async () => {
    const { run, llm, focusOn, moveTo } = setup({}, undefined, centre, 'torre-oro');
    const d = done(await run('Is it worth it?'));
    expect(llm.calls.at(-1)!.req.messages[1].content).toMatch(/Question: Is it worth it\? \(about Torre del Oro\)$/);
    expect(d.cited?.placeId).toBe('torre-oro');
    // "Tell me more" follows it too.
    const more = done(await run('Tell me more'));
    expect(llm.calls.at(-1)!.req.messages[1].content).toMatch(/Question: Tell me more \(about Torre del Oro\)$/);
    expect(more.cited?.placeId).toBe('torre-oro');
    focusOn(undefined);
    moveTo(at('setas'));
    const fact = done(await run('Tell me a historical fact'));
    expect(fact.cited?.placeId).toBe('setas');
    expect(fact.cited?.facts.length).toBeGreaterThan(0);
    // A question about the city or a topic is not pinned to a place.
    expect(done(await run('Tell me the history of Seville')).cited?.placeId).not.toBe('setas');
  });

  test('a recorded answer without a model (the dev app) also comes with its facts', async () => {
    const { run } = setup();
    const d = done(await run('Why does the Giralda have ramps?'));
    expect(d.text).toMatch(/ramps/);
    expect(d.text).not.toMatch(/\[\d\]/);
    expect(d.cited?.facts[0].id).toBe('giralda-ramps');
  });

  test('source numbers come out cleanly', () => {
    expect(stripCitations('It was a prison [1]. Its name comes from its tiles [1, 4].')).toBe('It was a prison. Its name comes from its tiles.');
  });
});

// ---------------------------------------------------------------------------
describe('the hotel reaches the Map ("At my hotel" needs trip.base.point)', () => {
  test('"my hotel is here" puts it where you are, and later edits by the model keep it there', async () => {
    const here = at('plaza-nueva');
    const { run, saved, llm } = setup({}, { ...threeDays(), base: { name: 'Hotel Casa 1800' } }, here);
    const events = await run('My hotel is here');
    expect(llm.calls).toHaveLength(0);
    expect(saved[0].base).toEqual({ name: 'Hotel Casa 1800', point: here.location });
    expect(done(events).text).toMatch(/At my hotel/);
    await run("I'm staying two more days");
    expect(saved.at(-1)!.base?.point).toEqual(here.location);
    // The planner's resolveDraft looks the base up by name and finds no point: code keeps it.
    await run('Move the flamenco show to Monday');
    expect(llm.calls.map(c => c.req.tag)).toEqual(['trip.revise']);
    expect(saved.at(-1)!.base?.point).toEqual(here.location);
  });

  test('a hotel named in Chat: by a guide place it is on the map; unknown, the reply says how to place it', async () => {
    const { run, saved } = setup({}, threeDays());
    await run("I'm staying at the Hotel Inglaterra on Plaza Nueva");
    expect(saved[0].base).toMatchObject({ name: 'Hotel Inglaterra on Plaza Nueva', placeId: 'plaza-nueva', point: place('plaza-nueva').point });
    const events = await run('My hotel is Hotel Casa 1800');
    expect(saved.at(-1)!.base).toEqual({ name: 'Hotel Casa 1800', placeId: undefined, point: undefined });
    expect(done(events).text).toMatch(/tap where it is and tell me "my hotel is here"/);
  });

  test('"how do I say this is my room?" is a phrase, not a hotel', async () => {
    const { run, saved } = setup({}, threeDays());
    await run('How do I say this is my room in Spanish?');
    expect(saved).toHaveLength(0);
  });

  test('remarks that are not a hotel go on to the guide', () => {
    expect(hotelOf('my hotel is nice')).toMatchObject({ named: false });
    expect(hotelOf("I'm staying in Seville")).toBeUndefined();
    expect(hotelOf("I'm staying near the cathedral for three more days")).toBeUndefined();
    expect(hotelOf('Is my hotel near the cathedral?')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('adding a place to a day', () => {
  test('today: the first free time from now; another day: that day (growing the trip to it), from 10:00', () => {
    const trip = threeDays();
    const t1 = withStop(trip, place('torre-oro'), { date: TODAY, minute: 9 * 60 + 50 });
    // 10:00–12:00 is the Alcázar, so the Torre del Oro goes at 12:00.
    expect(stopsOn(t1, TODAY).map(s => [s.placeId, s.start])).toEqual([['alcazar', '10:00'], ['torre-oro', '12:00']]);
    expect(withStop(t1, place('torre-oro'), { date: TODAY, minute: 600 })).toBe(t1); // already on that day
    const t2 = withStop(trip, place('setas'), { date: TODAY, minute: 600 }, { date: '2026-11-19' });
    expect(t2.days).toBe(5);
    expect(stopsOn(t2, '2026-11-19').map(s => [s.placeId, s.start])).toEqual([['setas', '10:00']]);
    expect(planDates(t2, TODAY)).toContain('2026-11-19');
    const t3 = withStop(undefined, place('setas'), { date: TODAY, minute: 23 * 60 + 40 });
    expect(t3).toMatchObject({ startDate: TODAY, days: 1 });
    expect(t3.stops[0].start).toBeUndefined(); // too late today: "Any time", not 00:00
  });
});

// ---------------------------------------------------------------------------
// Through the hook the screens use: Chat → b.trip (Now), b.cited (the facts panel), b.trip.base (Map).

describe('useBuddy end to end', () => {
  const runtime: Runtime = { llm: new FixtureLLM(llmAnswers, 0), audio: new TypedAudio([]), live: { llm: false, audio: false } };
  let b: Buddy | undefined;
  function Harness() {
    b = useBuddy(runtime, index);
    return null;
  }
  beforeAll(() => jest.useFakeTimers());
  afterAll(() => jest.useRealTimers());

  test('Chat edits the trip that Now reads and saves it; answers expose their facts; the hotel gives the Map its chip', async () => {
    mockMemory.clear();
    let r: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      r = renderer.create(React.createElement(Harness));
    });
    const say = async (text: string) =>
      act(async () => {
        await b!.send(text);
      });
    // A place from Place's "Add to my day": a one-day trip from the clock's date.
    await act(async () => {
      await b!.addToTrip('alcazar');
    });
    const today = b!.situation.clock.date;
    expect(b!.trip).toMatchObject({ startDate: today, days: 1 });

    await say("I'm staying two more days");
    expect(b!.trip!.days).toBe(3);
    expect(planDates(b!.trip, today)).toHaveLength(3);
    expect(JSON.parse(mockMemory.get('travelbuddy.trip.v1')!).days).toBe(3); // persisted
    expect(b!.tripIsNew).toBe(true);
    expect(b!.chat.at(-1)).toMatchObject({ who: 'buddy', pending: false, text: expect.stringMatching(/^Your trip is now 3 days/) });

    // Place's "Add to my day" for another day lands on that day.
    const tomorrow = planDates(b!.trip, today)[1];
    await act(async () => {
      await b!.addToTrip('torre-oro', { date: tomorrow });
    });
    expect(stopsOn(b!.trip!, tomorrow).map(s => s.placeId)).toEqual(['torre-oro']);

    await say('Tell me about the Torre del Oro');
    expect(b!.cited?.placeId).toBe('torre-oro');
    expect(b!.cited!.facts.map(f => f.id)).toEqual(expect.arrayContaining(['wiki-torre-oro', 'torre-oro-name']));
    expect(b!.chat.at(-1)!.cited).toEqual(b!.cited);
    expect(b!.chat.at(-1)!.text).not.toMatch(/\[\d\]/);
    expect(b!.focusId).toBe('torre-oro');

    // "Is it worth it?" follows the place on screen.
    await say('Is it worth it?');
    expect(b!.cited?.placeId).toBe('torre-oro');

    // A new question that is not about a place clears the facts.
    await say('What should I do now?');
    expect(b!.cited).toBeUndefined();

    // The Map's "At my hotel" chip shows when the trip's base has a point.
    await act(async () => b!.setLocation(place('plaza-nueva').point, 'Plaza Nueva'));
    await say('This is my hotel');
    expect(b!.trip!.base?.point).toEqual(place('plaza-nueva').point);
    expect(b!.trip!.days).toBe(3);

    act(() => r!.unmount());
  });
});

// ---------------------------------------------------------------------------
describe('"find X near me" answers from the offline map of everything (nearby index)', () => {
  test('"find movie theatre in sevilla": the nearest cinemas by name and walk, with no model call', async () => {
    const { run, llm } = setup();
    const d = done(await run('find movie theatre in sevilla'));
    expect(d.text).toMatch(/^The nearest cinema is (Cines Avenida|Odeon Multicines Plaza de Armas|Cine Cervantes|Alameda)/);
    expect(d.text).toMatch(/about \d+ min on foot/);
    expect(llm.calls.length).toBe(0);
  });

  test('"a pharmacy near the cathedral" is measured from the cathedral', async () => {
    const { run } = setup();
    const d = done(await run('Is there a pharmacy near the cathedral?'));
    expect(d.text).toMatch(/^Near Seville Cathedral: the nearest pharmacy is /);
  });

  test('guide questions, phrases and trip edits are not caught', async () => {
    const { run } = setup();
    expect(done(await run('Tell me the history of the Torre del Oro')).text).not.toMatch(/nearest/);
    expect(done(await run('How do I say where is the pharmacy in Spanish?')).text).not.toMatch(/nearest pharmacy/);
  });
});
