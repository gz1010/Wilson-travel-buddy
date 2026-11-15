/**
 * Locating the Mac: macOS Location through the helper, else the last fix saved while macOS could
 * locate it, else a tap on the map. Plus the helper client's location.get round trip.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { PackIndex } from '../pack';
import { seville } from '../../pack/seville';
import type { LocationFix } from '../types';
import { agoText, findMe, onPackMap, placeLabel, useBuddy, type Buddy, type LocateDeps } from '../../ui/useBuddy';
import { HelperAudioClient } from '../../services/audio/helperClient';
import { TypedAudio } from '../../services/audio/typedAudio';
import { FixtureLLM } from '../../services/llm/fixtureLLM';
import { llmAnswers } from '../../fixtures/llmAnswers';
import type { Runtime } from '../../services/runtime';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => {}),
  removeItem: jest.fn(async () => {}),
}));

const index = new PackIndex(seville);
const NOW = Date.UTC(2026, 10, 15, 12, 0);
const plazaNueva = index.pack.places.find(p => /plaza nueva/i.test(p.name)) ?? index.pack.places[0];
/** New York: macOS located the Mac, but nowhere near the pack's map. */
const newYork = { lat: 40.7128, lon: -74.006 };

function deps(opts: { fix?: LocationFix; error?: string; saved?: LocationFix; throws?: boolean }) {
  const saved: LocationFix[] = [];
  const d: LocateDeps & { saved: LocationFix[] } = {
    saved,
    ask: async onError => {
      if (opts.throws) throw new Error('socket closed');
      if (!opts.fix) onError(opts.error ?? 'macOS could not locate this Mac. A Mac has no GPS: macOS locates it from nearby Wi-Fi networks, so Wi-Fi must be on.');
      return opts.fix;
    },
    loadFix: async () => opts.saved,
    saveFix: async f => {
      saved.push(f);
    },
    now: () => NOW,
  };
  return d;
}

describe('findMe (macOS, else the saved fix, else a tap)', () => {
  it('uses macOS when it can, names the place, and saves the fix', async () => {
    const fix = { ...plazaNueva.point, accuracy: 65, at: NOW - 5_000 };
    const d = deps({ fix });
    const { located, note } = await findMe(index, d);
    expect(located).toEqual({ point: plazaNueva.point, accuracy: 65, source: 'macos', at: fix.at, label: plazaNueva.name });
    expect(note).toBeUndefined();
    expect(d.saved).toEqual([fix]);
  });

  it('falls back to the saved fix when macOS cannot (Wi-Fi off), saying how old it is', async () => {
    const saved = { ...plazaNueva.point, accuracy: 65, at: NOW - 2 * 3600_000 };
    const d = deps({ error: 'Wi-Fi is off, so macOS cannot locate this Mac (it has no GPS and works from nearby Wi-Fi networks).', saved });
    const { located, note } = await findMe(index, d);
    expect(located?.source).toBe('saved');
    expect(located?.point).toEqual(plazaNueva.point);
    expect(located?.label).toBe(`${plazaNueva.name} (last known, 2 h ago)`);
    expect(note).toMatch(/^Wi-Fi is off.*Showing where macOS last located you, 2 h ago\.$/);
    expect(d.saved).toEqual([]); // a saved fix is not saved again
  });

  it('falls back when the helper is missing or throws', async () => {
    const saved = { ...plazaNueva.point, at: NOW - 10 * 60_000 };
    expect((await findMe(index, deps({ throws: true, saved }))).located?.source).toBe('saved');
    // TypedAudio (no helper) has no macOS Location at all.
    const typed = new TypedAudio([]);
    const reasons: string[] = [];
    expect(await typed.locate(m => reasons.push(m))).toBeUndefined();
    expect(reasons[0]).toMatch(/audio helper/);
    const r = await findMe(index, { ...deps({ saved }), ask: e => typed.locate(e) });
    expect(r.located?.label).toMatch(/10 min ago/);
    expect(r.note).toMatch(/^No macOS Location without the audio helper\. Showing/);
  });

  it('asks for a tap when there is no saved fix either', async () => {
    const { located, note } = await findMe(index, deps({ error: 'Location access was refused' }));
    expect(located).toBeUndefined();
    expect(note).toBe('Location access was refused. Tap the map to set where you are.');
  });

  it('moves no one when macOS puts the Mac far from the pack, and does not save that fix', async () => {
    const saved = { ...plazaNueva.point, at: NOW - 3600_000 };
    const d = deps({ fix: { ...newYork, accuracy: 30, at: NOW }, saved });
    const { located, note } = await findMe(index, d);
    expect(located).toBeUndefined();
    expect(note).toMatch(/^macOS places this Mac [\d.]+ km from Seville, off the offline map\. Tap the map/);
    expect(d.saved).toEqual([]);
  });

  it('ignores a saved fix from another city, and unusable fixes', async () => {
    expect((await findMe(index, deps({ saved: { ...newYork, at: NOW } }))).located).toBeUndefined();
    const bad = { lat: NaN, lon: 0, at: NOW };
    expect((await findMe(index, deps({ fix: bad }))).located).toBeUndefined();
  });

  it('labels a vague fix by its neighbourhood, or generically', async () => {
    const withHood = index.pack.places.find(p => p.neighborhood)!;
    expect(placeLabel(index, withHood.point, 30)).toBe(withHood.name);
    expect(placeLabel(index, withHood.point, 1000)).toBe(withHood.neighborhood);
    expect(placeLabel(index, withHood.point, 5000)).toBeUndefined();
    const vague = await findMe(index, deps({ fix: { ...index.destination.center, accuracy: 5000, at: NOW } }));
    expect(vague.located?.label).toBe('where macOS located you');
  });

  it('knows the map and says how old a fix is', () => {
    expect(onPackMap(index, index.destination.center)).toBe(true);
    expect(onPackMap(index, newYork)).toBe(false);
    expect(agoText(20_000)).toBe('just now');
    expect(agoText(12 * 60_000)).toBe('12 min ago');
    expect(agoText(2 * 3600_000)).toBe('2 h ago');
    expect(agoText(3 * 86400_000)).toBe('3 days ago');
    expect(agoText(-5_000)).toBe('just now');
  });
});

/** A WebSocket stand-in: the test plays the helper. */
class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket | undefined;
  readyState = 0;
  sent: { type: string; id?: string }[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (ev: { data: string }) => void;
  constructor(public url: string) {
    FakeSocket.last = this;
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  reply(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

describe('HelperAudioClient.locate', () => {
  const realWebSocket = globalThis.WebSocket;
  beforeAll(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  });
  afterAll(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket;
  });

  async function connected() {
    const client = new HelperAudioClient();
    const ready = client.connect('ws://127.0.0.1:1', 2000, 2000);
    const ws = FakeSocket.last!;
    ws.open();
    ws.reply({ type: 'ready', version: 1, models: ['WhisperKit'], liveSpeakers: false });
    expect(await ready).toBe(true);
    return { client, ws };
  }

  it('sends location.get and resolves with the fix of the same id', async () => {
    const { client, ws } = await connected();
    const pending = client.locate();
    const get = ws.sent.find(m => m.type === 'location.get')!;
    expect(get.id).toBeTruthy();
    ws.reply({ type: 'location', id: 'someone-else', lat: 1, lon: 1, at: 1 }); // not ours
    ws.reply({ type: 'location', id: get.id, lat: 37.39, lon: -5.99, accuracy: 65, at: 1234 });
    expect(await pending).toEqual({ lat: 37.39, lon: -5.99, accuracy: 65, at: 1234 });
    ws.close();
  });

  it("passes the helper's reason on, and gives up if the helper never answers", async () => {
    jest.useFakeTimers();
    try {
      const { client, ws } = await connected();
      const reasons: string[] = [];
      const refused = client.locate(m => reasons.push(m));
      const get = ws.sent.filter(m => m.type === 'location.get').pop()!;
      ws.reply({ type: 'location.error', id: get.id, message: 'Wi-Fi is off.' });
      expect(await refused).toBeUndefined();
      expect(reasons).toEqual(['Wi-Fi is off.']);

      // An older helper ignores location.get: the client stops waiting after its timeout.
      const silent = client.locate(m => reasons.push(m), 10_000);
      jest.advanceTimersByTime(10_001);
      expect(await silent).toBeUndefined();
      expect(reasons[1]).toMatch(/did not answer/);

      // A disconnect releases a waiting locate at once.
      const cut = client.locate(m => reasons.push(m));
      ws.close();
      expect(await cut).toBeUndefined();
      expect(reasons[2]).toMatch(/disconnected/);
      expect(await client.locate(m => reasons.push(m))).toBeUndefined();
      expect(reasons[3]).toMatch(/not connected/);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('b.locate (useBuddy)', () => {
  /** Typed audio whose locate() the test answers. */
  function runtimeWith(answer: () => Promise<LocationFix | undefined>): Runtime {
    const audio = new TypedAudio([]);
    audio.locate = answer;
    return { llm: new FixtureLLM(llmAnswers, 0), audio, live: { llm: false, audio: true } };
  }
  async function mount(rt: Runtime) {
    const ref: { b?: Buddy } = {};
    function Harness() {
      ref.b = useBuddy(rt, index);
      return null;
    }
    let r: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      r = renderer.create(React.createElement(Harness));
    });
    await act(async () => {
      await new Promise<void>(done => setTimeout(done, 0));
    });
    return { ref, unmount: () => act(() => r!.unmount()) };
  }

  it('locates once at startup, and on request returns { point, accuracy, source }', async () => {
    const fix = { ...plazaNueva.point, accuracy: 50, at: Date.now() };
    const { ref, unmount } = await mount(runtimeWith(async () => fix));
    expect(ref.b!.situation.location).toEqual(plazaNueva.point);
    expect(ref.b!.situation.locationLabel).toBe(plazaNueva.name);

    await act(async () => ref.b!.setLocation(index.destination.center, 'the map point you chose'));
    let got: Awaited<ReturnType<Buddy['locate']>>;
    await act(async () => {
      got = await ref.b!.locate();
    });
    expect(got!).toMatchObject({ point: plazaNueva.point, accuracy: 50, source: 'macos' });
    expect(ref.b!.situation.locationLabel).toBe(plazaNueva.name);
    expect(ref.b!.locating).toBe(false);
    expect(ref.b!.locateNote).toBeUndefined();
    unmount();
  });

  it('keeps a tap made while the startup locate was still waiting for macOS', async () => {
    let answer: (f: LocationFix | undefined) => void = () => {};
    const { ref, unmount } = await mount(runtimeWith(() => new Promise(done => (answer = done))));
    const tapped = index.pack.places[3].point;
    await act(async () => ref.b!.setLocation(tapped));
    await act(async () => {
      answer({ ...plazaNueva.point, accuracy: 50, at: Date.now() });
      await new Promise<void>(done => setTimeout(done, 0));
    });
    expect(ref.b!.situation.location).toEqual(tapped);
    unmount();
  });

  it('says why when there is nothing to go on', async () => {
    const { ref, unmount } = await mount(runtimeWith(async () => undefined));
    expect(ref.b!.situation.locationLabel).toBe('the city centre');
    let got: Awaited<ReturnType<Buddy['locate']>> | 'unset' = 'unset';
    const notes: string[] = [];
    await act(async () => {
      got = await ref.b!.locate(n => notes.push(n));
    });
    expect(got).toBeUndefined();
    expect(ref.b!.locateNote).toMatch(/Tap the map to set where you are\.$/);
    expect(notes).toEqual([ref.b!.locateNote]);
    unmount();
  });
});
