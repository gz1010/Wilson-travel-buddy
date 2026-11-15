import { seville } from '../../pack/seville';
import { FixtureLLM } from '../../services/llm/fixtureLLM';
import { SSEParser } from '../../services/llm/sse';
import { buildBody } from '../../services/llm/llamaClient';
import { DefaultCompanion } from '../companion';
import { distanceMeters, walkingMinutes } from '../geo';
import { routeIntent } from '../intent';
import { PackIndex } from '../pack';
import { NOT_IN_GUIDE } from '../prompts';
import { picksSchema, Recommender } from '../recommend';
import { scoreCandidates } from '../scoring';
import { SentenceChunker } from '../sentences';
import { sunTimes } from '../sun';
import { openState, shiftClock, formatHHMM } from '../time';
import { SideAssigner, Translator } from '../translate';
import { nextFixedStop, resolveDraft, type TripDraft } from '../trip';
import type { CompanionEvent, Pack, Situation, Trip } from '../types';

const index = new PackIndex(seville);
const DAY1 = '2026-11-15'; // a Sunday
// The pack's forecast is whatever prepare-pack.mjs last fetched (its days move with every run), so
// tests that need weather give themselves their own: the forecast's first day turns rainy from 16:00.
const RAIN_DAY = seville.forecast.hours[0]?.time.slice(0, 10) ?? DAY1;
const rainyIndex = new PackIndex({
  ...seville,
  forecast: {
    ...seville.forecast,
    hours: seville.forecast.hours.map(h =>
      h.time.startsWith(RAIN_DAY) && Number(h.time.slice(11, 13)) >= 16 ? { ...h, precipitationChance: 70, code: 61 } : h,
    ),
  },
} satisfies Pack);
const at = (minute: number, date = DAY1): Situation => ({
  clock: { date, minute },
  location: index.place('catedral')!.point,
  locationLabel: 'the Cathedral',
  visited: [],
});

describe('time and opening hours', () => {
  const hours = { daily: '10:00-14:00,17:00-20:00', sun: 'closed' };
  it('is open inside a range and reports closing', () => {
    expect(openState(hours, { date: '2026-11-16', minute: 11 * 60 })).toMatchObject({ open: true, closesAt: '14:00', minutesLeft: 180 });
  });
  it('is closed between ranges and says when it reopens', () => {
    expect(openState(hours, { date: '2026-11-16', minute: 15 * 60 })).toMatchObject({ open: false, opensAt: '17:00' });
  });
  it('honours a closed day', () => {
    expect(openState(hours, { date: DAY1, minute: 11 * 60 }).open).toBe(false);
  });
  it('handles ranges past midnight', () => {
    const bar = { daily: '13:00-01:30' };
    expect(openState(bar, { date: '2026-11-16', minute: 30 })).toMatchObject({ open: true, closesAt: '01:30' });
    expect(openState(bar, { date: '2026-11-16', minute: 23 * 60 })).toMatchObject({ open: true, minutesLeft: 150 });
  });
  it('rolls the clock over midnight', () => {
    expect(shiftClock({ date: DAY1, minute: 23 * 60 + 30 }, 45)).toEqual({ date: '2026-11-16', minute: 15 });
  });
});

describe('sun', () => {
  it('matches published sunrise and sunset for Seville within 2 minutes', () => {
    const p = seville.destination.center;
    const nov = sunTimes('2026-11-15', p, 60);
    expect(Math.abs(nov.sunrise! - (8 * 60 + 3.4))).toBeLessThan(2);
    expect(Math.abs(nov.sunset! - (18 * 60 + 13.2))).toBeLessThan(2);
    const jun = sunTimes('2026-06-21', p, 120);
    expect(Math.abs(jun.sunrise! - (7 * 60 + 3.7))).toBeLessThan(2);
    expect(Math.abs(jun.sunset! - (21 * 60 + 47.9))).toBeLessThan(2);
  });
});

describe('geo', () => {
  it('measures the Cathedral to the Alcázar at a few hundred metres', () => {
    const m = distanceMeters(index.place('catedral')!.point, index.place('alcazar')!.point);
    expect(m).toBeGreaterThan(250);
    expect(m).toBeLessThan(500);
    expect(walkingMinutes(m)).toBeLessThanOrEqual(8);
  });
});

describe('pack', () => {
  it('has consistent data', () => {
    const ids = new Set(seville.places.map(p => p.id));
    expect(ids.size).toBe(seville.places.length);
    for (const f of seville.facts) if (f.placeId) expect(ids.has(f.placeId)).toBe(true);
    for (const p of seville.places) {
      const [w, s, e, n] = seville.destination.bounds;
      expect(p.point.lon).toBeGreaterThan(w);
      expect(p.point.lon).toBeLessThan(e);
      expect(p.point.lat).toBeGreaterThan(s);
      expect(p.point.lat).toBeLessThan(n);
    }
  });
  it('finds places by spoken name, with or without accents', () => {
    expect(index.findPlace('the alcazar')?.id).toBe('alcazar');
    expect(index.findPlace('Plaza de España')?.id).toBe('plaza-espana');
    expect(index.findPlace('I am at the Museum of Fine Arts')?.id).toBe('bellas-artes');
  });
  it('searches facts', () => {
    expect(index.query('where is Columbus buried')[0]?.placeId).toBe('catedral');
  });
  it('spots places mentioned in an answer', () => {
    expect(index.placesMentionedIn('Try Triana Market, then walk to Calle Betis.').map(p => p.id)).toEqual(['mercado-triana', 'calle-betis']);
  });
});

describe('scoring', () => {
  const trip: Trip = { startDate: DAY1, days: 3, interests: ['views', 'food'], stops: [], description: '' };
  it('suggests outdoor places at 13:00 but only indoor ones once rain is near at 17:00', () => {
    expect(rainyIndex.forecastAt({ date: RAIN_DAY, minute: 13 * 60 })).toBeDefined(); // the pack covers RAIN_DAY
    const rainTrip: Trip = { ...trip, startDate: RAIN_DAY };
    const noon = scoreCandidates(rainyIndex, rainTrip, at(13 * 60, RAIN_DAY));
    expect(noon.some(c => !c.place.indoor)).toBe(true);
    const late = scoreCandidates(rainyIndex, rainTrip, at(17 * 60, RAIN_DAY)).slice(0, 3);
    expect(late.length).toBeGreaterThan(0);
    expect(late.every(c => c.place.indoor)).toBe(true);
  });
  it('never suggests closed or visited places', () => {
    const sit = { ...at(10 * 60, '2026-11-16'), visited: ['catedral'] }; // Monday
    const ids = scoreCandidates(index, trip, sit, { limit: 50 }).map(c => c.place.id);
    expect(ids).not.toContain('catedral');
    expect(ids).not.toContain('bellas-artes'); // closed Mondays
  });
  it('works around a booked stop', () => {
    const booked: Trip = { ...trip, stops: [{ id: 's', title: 'Alcázar tickets', placeId: 'alcazar', day: 1, start: '14:00', fixed: true }] };
    expect(nextFixedStop(booked, { date: DAY1, minute: 12 * 60 })?.minutesUntil).toBe(120);
    const recs = scoreCandidates(index, booked, at(13 * 60 + 30));
    expect(recs.map(c => c.place.id)).not.toContain('alcazar');
    expect(recs[0].notes.join(' ')).toMatch(/2:00|14:00/);
  });
});

describe('recommender', () => {
  it('drops IDs the code did not offer and keeps valid ones', async () => {
    const llm = new FixtureLLM({ recommend: () => JSON.stringify({ picks: [{ place_id: 'made-up', reason: 'x' }, { place_id: 'catedral', reason: 'Close by.' }] }) });
    const r = new Recommender(llm, index);
    const recs = await r.refine(undefined, at(12 * 60));
    expect(recs.map(x => x.placeId)).not.toContain('made-up');
  });
  it('puts candidate IDs in the schema enum', () => {
    const c = scoreCandidates(index, undefined, at(12 * 60));
    const schema: any = picksSchema(c);
    expect(schema.properties.picks.items.properties.place_id.enum).toEqual(c.map(x => x.place.id));
  });
  it('falls back to code-written reasons when the model fails', async () => {
    const llm = new FixtureLLM({});
    const recs = await new Recommender(llm, index).refine(undefined, at(12 * 60));
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.every(r => !r.fromModel && r.reason.length > 0)).toBe(true);
  });
});

describe('trip extraction', () => {
  it('resolves place names and clamps days', () => {
    const draft: TripDraft = {
      days: 3,
      base_area: 'Santa Cruz',
      interests: ['food', 'architecture', 'not-a-tag' as any],
      stops: [{ title: 'Museum', place_name: 'Museum of Fine Arts', day: 9, start: '15:00', duration_minutes: null, fixed: true }],
    };
    const trip = resolveDraft(draft, index, DAY1, 'desc');
    expect(trip.stops[0]).toMatchObject({ placeId: 'bellas-artes', day: 3, start: '15:00', fixed: true });
    expect(trip.interests).toEqual(['food', 'architecture']);
    expect(trip.base?.placeId).toBe('santa-cruz');
  });
});

describe('intent routing', () => {
  it.each([
    ['What should I do now?', true, 'recommend'],
    ["I'm here three days, staying near the old town", false, 'trip.setup'],
    ['Move the museum to tomorrow', true, 'trip.edit'],
    ['Translate for me, I need to talk to the waiter', true, 'translator'],
    ['How do I say the bill please', true, 'phrase'],
    ['Why is the Giralda famous?', true, 'guide'],
  ])('%s', (text, hasTrip, intent) => {
    expect(routeIntent(text, hasTrip)).toBe(intent);
  });
});

describe('translator', () => {
  it('uses the phrasebook before the model', async () => {
    const llm = new FixtureLLM({});
    const t = new Translator(llm, seville.phrases, 'en', 'es');
    expect(await t.translate('The bill, please!', 'en', 'es')).toBe('La cuenta, por favor');
    expect(llm.calls.length).toBe(0);
  });
  it('assigns sides from the first language each speaker uses', () => {
    const s = new SideAssigner('en', 'es');
    expect(s.assign(1, 'es')).toBe('local');
    expect(s.assign(0, 'en')).toBe('traveler');
    expect(s.assign(1, 'en')).toBe('traveler'); // language decides when it is known
    expect(s.assign(1, undefined)).toBe('traveler'); // then the speaker's last side is used
    expect(s.assign(undefined, 'es')).toBe('local');
    expect(s.direction('local', 'en')).toEqual({ from: 'en', to: 'es' });
  });
});

describe('streaming helpers', () => {
  it('splits sentences for the voice', () => {
    const c = new SentenceChunker();
    expect(c.push('It costs 3.5 euros. Then ')).toEqual(['It costs 3.5 euros.']);
    expect(c.push('turn left! Ok')).toEqual(['Then turn left!']);
    expect(c.flush()).toEqual(['Ok']);
  });
  it('parses llama-server SSE in pieces', () => {
    const p = new SSEParser();
    const a = 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"del';
    expect(p.feed(a)).toEqual(['Hel']);
    expect(p.feed(a + 'ta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n')).toEqual(['lo']);
    expect(p.done).toBe(true);
  });
  it('turns thinking off and attaches the schema', () => {
    const body: any = buildBody({ tag: 'trip.extract', messages: [] }, { type: 'object' });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.response_format.json_schema.schema).toEqual({ type: 'object' });
  });
});

describe('companion', () => {
  const collect = async (c: DefaultCompanion, text: string) => {
    const events: CompanionEvent[] = [];
    await c.handle(text, e => events.push(e));
    return events;
  };
  let saved: Trip | undefined;
  const companion = new DefaultCompanion(
    new FixtureLLM(
      {
        'trip.extract': JSON.stringify({ days: 3, base_area: 'Santa Cruz', interests: ['food', 'tapas'], stops: [{ title: 'Museum', place_name: 'Museum of Fine Arts', day: 3, start: '15:00', duration_minutes: 90, fixed: true }] }),
        recommend: (_r, schema: any) => JSON.stringify({ picks: [{ place_id: schema.properties.picks.items.properties.place_id.enum[0], reason: 'Good now.' }] }),
        guide: 'The Giralda in Seville Cathedral has ramps instead of stairs.',
      },
      0,
    ),
    index,
    { trip: () => saved, situation: () => at(13 * 60), saveTrip: async t => { saved = t; } },
  );
  it('sets up a trip from a description', async () => {
    const ev = await collect(companion, "I'm here three days, staying in Santa Cruz, I love tapas, Tuesday afternoon I have a museum ticket");
    expect(ev.find(e => e.type === 'trip')).toBeTruthy();
    expect(saved?.stops[0].placeId).toBe('bellas-artes');
  });
  it('recommends and focuses the map', async () => {
    const ev = await collect(companion, 'What should I do now?');
    expect(ev.filter(e => e.type === 'recommendations').length).toBe(2);
    expect(ev.find(e => e.type === 'focus')).toBeTruthy();
  });
  it('answers from the guide and focuses the place it names', async () => {
    const ev = await collect(companion, 'Tell me about the Giralda');
    expect(ev.find(e => e.type === 'focus')).toEqual({ type: 'focus', placeId: 'catedral' });
    expect(ev.at(-1)).toMatchObject({ type: 'done' });
  });
  it('declines when the pack has nothing', async () => {
    const ev = await collect(companion, 'zzqx vvbn');
    expect(ev.at(-1)).toEqual({ type: 'done', text: NOT_IN_GUIDE });
  });
});

it('formats times', () => expect(formatHHMM(65)).toBe('01:05'));
