/**
 * Changing the day's plan: a suggestion's "+ Add" puts it in the day on screen, a planned stop's ✕
 * takes it off, the place page asks which day, and each change can be undone. Also the clock: the
 * city's real time from the Mac's clock, ticking, with the time controls as an offset from it.
 */
import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { PackIndex } from '../../../core/pack';
import { seville } from '../../../pack/seville';
import { llmAnswers } from '../../../fixtures/llmAnswers';
import scriptedConversation from '../../../fixtures/conversation_es_en.json';
import { FixtureLLM } from '../../../services/llm/fixtureLLM';
import { TypedAudio, type ScriptedLine } from '../../../services/audio/typedAudio';
import type { Runtime } from '../../../services/runtime';
import { useBuddy, type Buddy } from '../../useBuddy';
import type { Nav, ScreenName } from '../../dusk/Nav';
import { NowScreen } from '../NowScreen';
import { PlaceScreen } from '../PlaceScreen';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => {}),
  removeItem: jest.fn(async () => {}),
}));
jest.mock('react-native-webview', () => {
  const { View } = require('react-native');
  return { WebView: View, default: View };
});

const index = new PackIndex(seville);
const runtime = (now?: () => number): Runtime => ({
  llm: new FixtureLLM(llmAnswers, 0),
  audio: new TypedAudio(scriptedConversation as ScriptedLine[]),
  live: { llm: false, audio: false },
  now,
});

let latest: Buddy | undefined;
function Harness({ rt, screen, placeId }: { rt: Runtime; screen: 'now' | 'place'; placeId?: string }) {
  const b = useBuddy(rt, index);
  latest = b;
  const nav: Nav = { screen, placeId, go: (_s: ScreenName) => {}, openPlace: () => {} };
  return screen === 'now' ? <NowScreen b={b} nav={nav} /> : <PlaceScreen b={b} nav={nav} />;
}

const pressables = (r: ReactTestRenderer, test: (label: string) => boolean) =>
  r.root.findAll(n => typeof n.props.accessibilityLabel === 'string' && test(n.props.accessibilityLabel) && typeof n.props.onPress === 'function');
const shows = (r: ReactTestRenderer, text: string) => r.root.findAll(n => n.props.children === text).length > 0;

async function render(el: React.ReactElement): Promise<ReactTestRenderer> {
  let r: ReactTestRenderer | undefined;
  await act(async () => {
    r = renderer.create(el);
  });
  // Let the quick picks and the fixture model's refined picks land.
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });
  return r!;
}

beforeAll(() => jest.useFakeTimers());
afterAll(() => jest.useRealTimers());

describe('day plan edits', () => {
  it('Now: "+ Add" adds a suggestion to the day on screen, Undo takes it back, ✕ removes a planned stop', async () => {
    const r = await render(<Harness rt={runtime()} screen="now" />);
    const adds = pressables(r, l => /^Add .+ to \w{3} \d+/.test(l));
    expect(adds.length).toBeGreaterThan(0);
    const label = adds[0].props.accessibilityLabel as string;
    const name = label.replace(/^Add (.+) to \w{3} \d+.*$/, '$1');
    const place = index.pack.places.find(p => p.name === name)!;
    expect(place).toBeDefined();
    expect(latest!.trip).toBeUndefined();

    await act(async () => adds[0].props.onPress());
    expect(latest!.trip?.stops.map(s => s.placeId)).toEqual([place.id]);
    expect(r.root.findAll(n => typeof n.props.children === 'string' && n.props.children.startsWith(`Added ${name} to `)).length).toBeGreaterThan(0);

    // Planned stops say so, suggestions don't: the stop card reads "In your plan".
    expect(pressables(r, l => l.startsWith(`${place.name}.`) && l.includes('In your plan')).length).toBeGreaterThan(0);

    await act(async () => pressables(r, l => l === 'Undo')[0].props.onPress());
    expect(latest!.trip).toBeUndefined();

    // Add again, then take it off with the stop's ✕, and undo that.
    await act(async () => pressables(r, l => l === label)[0].props.onPress());
    const added = latest!.trip!;
    await act(async () => pressables(r, l => l === `Remove ${added.stops[0].title} from your plan`)[0].props.onPress());
    expect(latest!.trip?.stops).toEqual([]);
    expect(r.root.findAll(n => typeof n.props.children === 'string' && n.props.children.startsWith('Removed ')).length).toBeGreaterThan(0);
    await act(async () => pressables(r, l => l === 'Undo')[0].props.onPress());
    expect(latest!.trip).toEqual(added);

    // The toast goes away by itself.
    await act(async () => {
      jest.advanceTimersByTime(7000);
    });
    expect(pressables(r, l => l === 'Undo').length).toBe(0);
    act(() => r.unmount());
  });

  it('Place: "Add to day" asks which day, then says which day it is on, with Remove and Undo', async () => {
    const place = index.pack.places[0];
    const r = await render(<Harness rt={runtime()} screen="place" placeId={place.id} />);
    await act(async () => pressables(r, l => l === `Add ${place.name} to a day`)[0].props.onPress());
    const days = pressables(r, l => l.startsWith('Add to '));
    expect(days.length).toBeGreaterThan(1);
    expect(shows(r, 'Today')).toBe(true);

    // The second day offered.
    await act(async () => days[1].props.onPress());
    const trip = latest!.trip!;
    expect(trip.stops).toHaveLength(1);
    expect(trip.stops[0].placeId).toBe(place.id);
    const day = trip.stops[0].day;
    expect(pressables(r, l => l.startsWith('Add to ')).length).toBe(0);
    const remove = pressables(r, l => l.startsWith(`${place.name} is in your plan for `) && l.endsWith('Remove it'));
    expect(remove.length).toBeGreaterThan(0);

    await act(async () => remove[0].props.onPress());
    expect(latest!.trip!.stops).toEqual([]);
    await act(async () => pressables(r, l => l === 'Undo')[0].props.onPress());
    expect(latest!.trip!.stops.map(s => [s.placeId, s.day])).toEqual([[place.id, day]]);
    act(() => r.unmount());
  });
});

describe('day plan edits, edge cases', () => {
  it('says so, and changes nothing, when the day is too far from the trip to stretch to', async () => {
    const r = await render(<Harness rt={runtime()} screen="now" />);
    // A trip four weeks out: today (the demo clock's day) is beyond the 14 days a trip can span.
    const far = { startDate: '2026-12-20', days: 4, interests: [], stops: [], description: '' };
    await act(async () => latest!.restoreTrip(far));
    const add = pressables(r, l => /^Add .+ to \w{3} \d+/.test(l))[0];
    expect(add).toBeDefined();
    await act(async () => add.props.onPress());
    expect(latest!.trip).toEqual(far);
    expect(r.root.findAll(n => typeof n.props.children === 'string' && n.props.children.includes('is too far from your trip')).length).toBeGreaterThan(0);
    expect(pressables(r, l => l === 'Undo').length).toBe(0);
    act(() => r.unmount());
  });

  it('drops the Undo offer when the trip changes some other way (voice, Chat, import)', async () => {
    const r = await render(<Harness rt={runtime()} screen="now" />);
    await act(async () => pressables(r, l => /^Add .+ to \w{3} \d+/.test(l))[0].props.onPress());
    expect(pressables(r, l => l === 'Undo').length).toBeGreaterThan(0);
    const t = latest!.trip!;
    await act(async () => latest!.restoreTrip({ ...t, description: 'changed by voice' }));
    expect(pressables(r, l => l === 'Undo').length).toBe(0);
    act(() => r.unmount());
  });
});

describe('the clock', () => {
  it("is the city's real time and ticks; moved, it keeps ticking from there and can go back", async () => {
    // 14:02:30 UTC on Sunday 15 November 2026 = 15:02 in Seville.
    let ms = Date.UTC(2026, 10, 15, 14, 2, 30);
    const r = await render(<Harness rt={runtime(() => ms)} screen="now" />);
    expect(latest!.situation.clock).toEqual({ date: '2026-11-15', minute: 15 * 60 + 2 });
    expect(latest!.clockMoved).toBe(false);

    await act(async () => {
      ms += 60_000;
      jest.advanceTimersByTime(60_000);
    });
    expect(latest!.situation.clock.minute).toBe(15 * 60 + 3);

    await act(async () => latest!.setClock({ date: '2026-11-15', minute: 18 * 60 }));
    expect(latest!.clockMoved).toBe(true);
    expect(pressables(r, l => l === 'Back to the real time in the city')).toHaveLength(1);
    await act(async () => {
      ms += 60_000;
      jest.advanceTimersByTime(60_000);
    });
    expect(latest!.situation.clock.minute).toBe(18 * 60 + 1);

    await act(async () => pressables(r, l => l === 'Back to the real time in the city')[0].props.onPress());
    expect(latest!.clockMoved).toBe(false);
    expect(latest!.situation.clock).toEqual({ date: '2026-11-15', minute: 15 * 60 + 4 });
    act(() => r.unmount());
  });

  it('without a real clock (tests) stays the demo clock: the first forecast day at 10:00', async () => {
    const r = await render(<Harness rt={runtime()} screen="now" />);
    expect(latest!.situation.clock).toEqual({ date: index.pack.forecast.hours[0].time.slice(0, 10), minute: 600 });
    expect(latest!.clockMoved).toBe(false);
    act(() => r.unmount());
  });
});
