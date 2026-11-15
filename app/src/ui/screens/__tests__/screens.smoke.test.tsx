/**
 * Smoke test: every Dusk screen renders with the real app state (fixture model, typed audio) and
 * the Seville pack, with and without a trip, without throwing.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
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
import { MapScreen } from '../MapScreen';
import { SetupScreen } from '../SetupScreen';
import { TalkScreen } from '../TalkScreen';
import { WelcomeScreen } from '../WelcomeScreen';
import { LookScreen } from '../LookScreen';
import { TabBar } from '../../dusk/Nav';
import { FloatingBuddy } from '../../dusk/Buddy';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => {}),
  removeItem: jest.fn(async () => {}),
}));
// Metro aliases for the bundled map; the map itself is a web view, stubbed below.
jest.mock('buddy-maplibre', () => ({ js: '', css: '' }), { virtual: true });
jest.mock('buddy-tiles', () => ({ minzoom: 0, maxzoom: 0, tiles: null }), { virtual: true });
// One stand-in aerial tile, so the map offers its Aerial layer (scripts/build-aerial.mjs bakes the real ones).
jest.mock(
  'buddy-aerial',
  () => ({ source: 'test', attribution: 'PNOA máxima actualidad CC BY 4.0 scne.es', minzoom: 15, maxzoom: 15, bounds: [-6.02, 37.365, -5.97, 37.41], tiles: { '15/15838/12710': '/9j/' } }),
  { virtual: true },
);
jest.mock('react-native-webview', () => {
  const { View } = require('react-native');
  return { WebView: View, default: View };
});

const index = new PackIndex(seville);
const runtime: Runtime = {
  llm: new FixtureLLM(llmAnswers, 0),
  audio: new TypedAudio(scriptedConversation as ScriptedLine[]),
  live: { llm: false, audio: false },
};

const screens = { now: NowScreen, place: PlaceScreen, map: MapScreen, setup: SetupScreen, talk: TalkScreen, look: LookScreen };

let latest: Buddy | undefined;
function Harness({ screen }: { screen: keyof typeof screens }) {
  const b = useBuddy(runtime, index);
  latest = b;
  const nav: Nav = { screen, placeId: index.pack.places[0].id, go: (_s: ScreenName) => {}, openPlace: () => {} };
  const Screen = screens[screen];
  return <Screen b={b} nav={nav} />;
}

beforeAll(() => jest.useFakeTimers());
afterAll(() => jest.useRealTimers());

describe('Dusk screens render', () => {
  it('welcome', () => {
    let r: renderer.ReactTestRenderer | undefined;
    act(() => {
      r = renderer.create(<WelcomeScreen city="Seville" steps={[{ label: 'Seville guide', state: 'ready' }, { label: 'Bonsai-2', state: 'loading' }]} status="Connecting…" ready={false} onStart={() => {}} />);
    });
    expect(JSON.stringify(r!.toJSON())).toContain('Welcome');
    // The panel says how many of the on-device pieces are ready; Get started waits for them.
    expect(r!.root.findAll(n => n.props.children === '1 of 2 ready').length).toBeGreaterThan(0);
    expect(r!.root.findAll(n => n.props.accessibilityLabel === 'Get started, available once the models are ready').length).toBeGreaterThan(0);
    act(() => r!.update(<WelcomeScreen city="Seville" steps={[]} status="" models={['Bonsai-2', 'WhisperKit']} ready onStart={() => {}} />));
    expect(JSON.stringify(r!.toJSON())).toContain('Bonsai-2 · WhisperKit');
    expect(r!.root.findAll(n => n.props.accessibilityLabel === 'Get started').length).toBeGreaterThan(0);
    act(() => r!.unmount());
  });

  for (const screen of Object.keys(screens) as (keyof typeof screens)[]) {
    it(screen, async () => {
      let r: renderer.ReactTestRenderer | undefined;
      await act(async () => {
        r = renderer.create(<Harness screen={screen} />);
      });
      // With a trip and a stop too.
      await act(async () => {
        await latest!.addToTrip(index.pack.places[1].id);
      });
      // A conversation turn: the trip, the chat and the guide card all change.
      await act(async () => {
        const sent = latest!.send('Three days, staying in Santa Cruz. We love tapas and markets.');
        jest.advanceTimersByTime(1000);
        await sent;
      });
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      // Talk: tap the status pill to start the conversation.
      if (screen === 'talk') {
        const pill = r!.root.findAll(n => n.props.accessibilityLabel === 'Start the conversation' && typeof n.props.onPress === 'function')[0];
        await act(async () => pill.props.onPress());
        expect(JSON.stringify(r!.toJSON())).toContain('Listening');
        // Each half's language chip: the destination's language until Argmax hears the local, and the traveller's.
        expect(JSON.stringify(r!.toJSON())).toContain('Español · auto');
        expect(JSON.stringify(r!.toJSON())).toContain('English · you');
        // The scripted local answers in Spanish: the chip says it was detected.
        await act(async () => {
          jest.advanceTimersByTime(9000);
        });
        expect(JSON.stringify(r!.toJSON())).toContain('Español · detectado');
        // Tapping the chip offers the ten languages; picking one pins it.
        const chip = r!.root.findAll(n => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('Spanish, ') && typeof n.props.onPress === 'function')[0];
        await act(async () => chip.props.onPress());
        const french = r!.root.findAll(n => n.props.accessibilityLabel === 'French' && n.props.accessibilityRole === 'radio' && typeof n.props.onPress === 'function')[0];
        expect(french).toBeDefined();
        await act(async () => french.props.onPress());
        expect(JSON.stringify(r!.toJSON())).toContain('Français · pinned');
        await act(async () => {
          jest.advanceTimersByTime(9000);
        });
        expect(JSON.stringify(r!.toJSON())).toContain('Français · pinned');
      }
      // Look (shown as Scan): typed audio has no camera, so the screen says so instead of a preview;
      // the model on this Mac and the Offline chip stay in view.
      if (screen === 'look') {
        const json = JSON.stringify(r!.toJSON());
        for (const s of ['No camera right now', '"Scan"', `${runtime.llm.name} on this Mac`, 'Offline']) expect(json).toContain(s);
        expect(json).not.toContain('"Look"');
      }
      // Now: a glass chip per day of the trip, the Offline chip and the models, and the picked day
      // as a timeline (times on the left); a time there sets the clock to it.
      if (screen === 'now') {
        const dayChips = () => r!.root.findAll(n => n.props.accessibilityRole === 'radio' && typeof n.props.onPress === 'function');
        const times = () => r!.root.findAll(n => n.props.accessibilityHint === 'Sets the clock to this time' && typeof n.props.onPress === 'function');
        const shows = (label: string) => r!.root.findAll(n => n.props.accessibilityLabel === label).length > 0;
        const clockAt = (label: string) => Number(label.slice(0, 2)) * 60 + Number(label.slice(3, 5));
        const json = JSON.stringify(r!.toJSON());
        for (const s of ['Offline', runtime.llm.name, 'NOV', 'Sun 15', 'Now']) expect(json).toContain(s);
        expect(dayChips().filter(n => / of the trip$/.test(n.props.accessibilityLabel)).length).toBe(latest!.trip!.days);
        expect(shows('Plan for Sunday 15 November')).toBe(true);
        const late = times().at(-1)!;
        const lateLabel: string = late.props.accessibilityLabel;
        expect(lateLabel).toMatch(/^\d\d:\d\d, Sunday 15 November$/);
        await act(async () => late.props.onPress());
        expect(latest!.situation.clock).toEqual({ date: '2026-11-15', minute: clockAt(lateLabel) });
        // No trip: today and the next days the saved forecast covers. Another day's time moves the clock there.
        await act(async () => latest!.clearTrip());
        expect(dayChips().map(n => n.props.accessibilityLabel.split(',')[0])).toEqual(
          ['Sunday 15', 'Monday 16', 'Tuesday 17', 'Wednesday 18', 'Thursday 19', 'Friday 20', 'Saturday 21'].map(d => `${d} November`),
        );
        await act(async () => dayChips()[1].props.onPress());
        expect(shows('Plan for Monday 16 November')).toBe(true);
        const first = times()[0];
        const firstLabel: string = first.props.accessibilityLabel;
        expect(firstLabel).toMatch(/^\d\d:\d\d, Monday 16 November$/);
        await act(async () => first.props.onPress());
        expect(latest!.situation.clock).toEqual({ date: '2026-11-16', minute: clockAt(firstLabel) });
        expect(shows('Plan for Monday 16 November')).toBe(true);
        await act(async () => {
          await latest!.addToTrip(index.pack.places[1].id);
        });
      }
      // Chat (setup): the header, the models and the Offline chip; "Your trip" with the days; the
      // conversation as bubbles. A typed line goes in as yours and the buddy's answer comes in
      // below it. The trip appeared during this test (its days changed), so "Your trip" has opened
      // to a tile per day; tapping it closes them.
      if (screen === 'setup') {
        // Model names are kept whole on screen with no-break spaces and hyphens: read them as plain ones.
        const json = () => JSON.stringify(r!.toJSON()).replace(/\u00a0/g, ' ').replace(/\u2011/g, '-');
        const pressable = (test: (label: string) => boolean) =>
          r!.root.findAll(n => typeof n.props.accessibilityLabel === 'string' && test(n.props.accessibilityLabel) && typeof n.props.onPress === 'function');
        const asJson = (text: string) => JSON.stringify(text).slice(1, -1);
        for (const s of ['"Chat"', 'Offline', runtime.llm.name, 'Your trip', `${latest!.trip!.days} day`]) expect(json()).toContain(s);
        const reply = latest!.chat.filter(l => l.who === 'buddy' && !l.pending).at(-1)!;
        expect(json()).toContain(asJson(reply.text.slice(0, 24)));
        // Typed audio has no microphone: the ring is there and says so.
        expect(pressable(l => l === 'No microphone: type a message').length).toBeGreaterThan(0);
        const field = r!.root.findAll(n => n.props.accessibilityLabel === 'Type a message' && typeof n.props.onChangeText === 'function')[0];
        const question = `Tell me a historical fact about ${index.pack.places[0].name}`;
        await act(async () => field.props.onChangeText(question));
        const before = latest!.chat.length;
        await act(async () => {
          pressable(l => l === 'Send')[0].props.onPress();
          jest.advanceTimersByTime(1000);
        });
        await act(async () => {
          jest.advanceTimersByTime(2000);
        });
        expect(latest!.chat.length).toBe(before + 2);
        expect(latest!.chat.at(-2)).toMatchObject({ who: 'you', text: question });
        expect(latest!.chat.at(-1)).toMatchObject({ who: 'buddy', pending: false });
        expect(json()).toContain('Tell me a historical fact about');
        // The guide's facts behind that answer show under it.
        const facts = (latest!.chat.at(-1) as { cited?: { facts: { body: string }[] } }).cited?.facts ?? [];
        expect(facts.length).toBeGreaterThan(0);
        expect(json()).toContain('FROM THE GUIDE');
        expect(json()).toContain(asJson(facts[0].body.slice(0, 24)));
        const head = pressable(l => l.startsWith('Your trip'))[0];
        expect(head.props.accessibilityState.expanded).toBe(true);
        expect(pressable(l => /^Day \d+, /.test(l)).length).toBe(latest!.trip!.days);
        await act(async () => head.props.onPress());
        expect(pressable(l => /^Day \d+, /.test(l)).length).toBe(0);
        // "I'm staying two more days": the trip grows, and "Your trip" says so and opens on the new days.
        const daysBefore = latest!.trip!.days;
        await act(async () => field.props.onChangeText("I'm staying two more days"));
        await act(async () => {
          pressable(l => l === 'Send')[0].props.onPress();
          jest.advanceTimersByTime(1000);
        });
        expect(latest!.trip!.days).toBe(daysBefore + 2);
        const grown = pressable(l => l.startsWith('Your trip'))[0];
        expect(grown.props.accessibilityLabel).toMatch(new RegExp(`^Your trip, updated: ${daysBefore + 2} days · `));
        expect(grown.props.accessibilityState.expanded).toBe(true);
        expect(pressable(l => /^Day \d+, /.test(l)).length).toBe(daysBefore + 2);
        await act(async () => {
          jest.advanceTimersByTime(6000);
        });
        expect(pressable(l => l.startsWith('Your trip'))[0].props.accessibilityLabel).toMatch(/^Your trip: /);
        // The mic ring in each state (typed audio keeps Chat's idle): it renders and stays a button.
        const { VoiceMic } = require('../../dusk/VoiceMic') as typeof import('../../dusk/VoiceMic');
        const { Animated } = require('react-native') as typeof import('react-native');
        for (const state of ['idle', 'listening', 'thinking', 'speaking'] as const) {
          let mic: renderer.ReactTestRenderer | undefined;
          await act(async () => {
            mic = renderer.create(<VoiceMic state={state} level={new Animated.Value(0.5)} onPress={() => {}} />);
            jest.advanceTimersByTime(700);
          });
          expect(mic!.root.findAll(n => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function').length).toBeGreaterThan(0);
          act(() => mic!.unmount());
        }
      }
      // Map: typing lists up to five places (accents and case don't matter), I'm here moves you,
      // the Layers button offers three maps (Aerial shows its credit), and Locate me answers.
      if (screen === 'map') {
        const press = (label: string) => r!.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
        const rows = () => r!.root.findAll(n => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.endsWith('. Show on the map') && typeof n.props.onPress === 'function');
        const search = r!.root.findAll(n => n.props.accessibilityLabel === 'Search places' && typeof n.props.onChangeText === 'function')[0];
        await act(async () => search.props.onChangeText('TAPAS'));
        expect(rows().length).toBe(5);
        expect(rows().every(n => n.props.accessibilityLabel.includes('Tapas bar'))).toBe(true);
        await act(async () => search.props.onChangeText('real alcazar'));
        expect(rows()[0].props.accessibilityLabel.startsWith('Real Alcázar,')).toBe(true);
        expect(press('Show Real Alcázar on the map').length).toBeGreaterThan(0);
        // The list is drawn last (over the card), so its I'm here is the last one.
        await act(async () => press("I'm at Real Alcázar").at(-1)!.props.onPress());
        expect(latest!.situation.locationLabel).toBe('Real Alcázar');
        expect(rows().length).toBe(0);
        await act(async () => search.props.onChangeText('zzqx'));
        expect(JSON.stringify(r!.toJSON())).toContain('No “zzqx” in the Seville guide');
        await act(async () => search.props.onChangeText(''));
        await act(async () => press('Map layers')[0].props.onPress());
        for (const l of ['Dark map', 'Light map', 'Aerial map']) expect(press(l).length).toBe(1);
        await act(async () => press('Aerial map')[0].props.onPress());
        expect(press('Aerial map').length).toBe(0);
        // The licence and site are held together with no-break spaces, so the credit wraps before "CC BY".
        expect(JSON.stringify(r!.toJSON()).replace(/ /g, ' ')).toContain('Aerial: PNOA máxima actualidad CC BY 4.0 scne.es');
        await act(async () => {
          press('Locate me')[0].props.onPress();
        });
        if (JSON.stringify(r!.toJSON()).includes('Locating…')) {
          await act(async () => {
            jest.advanceTimersByTime(15000);
          });
        }
        expect(JSON.stringify(r!.toJSON())).toMatch(/Couldn't locate this Mac|Located by macOS|Last fix saved online|km from Seville/);
      }
      expect(r!.toJSON()).toBeTruthy();
      expect(latest!.chat.some(l => l.who === 'buddy' && !l.pending)).toBe(true);
      expect(latest!.trip).toBeDefined();
      act(() => r!.unmount());
    });
  }
});

describe('Scan (look)', () => {
  it('shows the sharp snap after the shutter, not the preview frame', async () => {
    const audio = runtime.audio;
    let onFrame: ((jpeg: string) => void) | undefined;
    const start = jest.spyOn(audio, 'startCamera').mockImplementation(f => {
      onFrame = f;
      return () => {
        onFrame = undefined;
      };
    });
    const snap = jest.spyOn(audio, 'snap').mockResolvedValue('SNAP');
    try {
      let r: renderer.ReactTestRenderer | undefined;
      await act(async () => {
        r = renderer.create(<Harness screen="look" />);
      });
      // The preview's pictures (the ambient backdrop behind the screen also shows the photo, blurred).
      const preview = r!.root.findAll(n => n.props.testID === 'scan-preview')[0];
      const shown = () => [...new Set(preview.findAll(n => typeof n.props.source?.uri === 'string').map(n => n.props.source.uri as string))];
      // The pictures wait for the preview's measured size (no layout in tests: report one).
      await act(async () => preview.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 520 } } }));
      await act(async () => onFrame!('PREVIEW'));
      expect(shown()).toEqual(['data:image/jpeg;base64,PREVIEW']);
      expect(JSON.stringify(r!.toJSON())).toContain('Point at a dish, a sign or a menu');
      const shutter = r!.root.findAll(n => n.props.accessibilityLabel === 'Scan: take a photo and find out what it is' && typeof n.props.onPress === 'function')[0];
      await act(async () => {
        shutter.props.onPress();
        jest.advanceTimersByTime(1000);
      });
      // Frames after the shutter are not shown; the snap is, over the held preview.
      await act(async () => onFrame!('LATER'));
      expect(snap).toHaveBeenCalled();
      expect(shown()).toEqual(['data:image/jpeg;base64,PREVIEW', 'data:image/jpeg;base64,SNAP']);
      // The backdrop behind the card and buttons is the photo you took, blurred.
      expect(r!.root.findAll(n => n.props.source?.uri === 'data:image/jpeg;base64,SNAP' && n.props.blurRadius > 0).length).toBeGreaterThan(0);
      // A resize redraws the pictures at the new size once it holds, not on every step of a drag.
      const widths = () => [...new Set(preview.findAll(n => typeof n.props.source?.uri === 'string').map(n => [n.props.style].flat(9).reduce((w, s) => s?.width ?? w, 0)))];
      expect(widths()).toEqual([390]);
      await act(async () => preview.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 420, height: 520 } } }));
      await act(async () => preview.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 430, height: 520 } } }));
      expect(widths()).toEqual([390]);
      await act(async () => {
        jest.advanceTimersByTime(200);
      });
      expect(widths()).toEqual([430]);
      expect(shown()).toEqual(['data:image/jpeg;base64,PREVIEW', 'data:image/jpeg;base64,SNAP']);
      // Retake: the photo goes and the preview moves again.
      const retake = r!.root.findAll(n => n.props.accessibilityLabel === 'Retake' && typeof n.props.onPress === 'function')[0];
      await act(async () => retake.props.onPress());
      await act(async () => onFrame!('NEXT'));
      expect(shown()).toEqual(['data:image/jpeg;base64,NEXT']);
      act(() => r!.unmount());
    } finally {
      start.mockRestore();
      snap.mockRestore();
    }
  });
});

describe('Tab bar and floating buddy', () => {
  it('tab bar: five icon tabs (Now, Map, Chat, Translate, Scan) with labels and tooltips, no words', async () => {
    const went: ScreenName[] = [];
    const navAt = (screen: ScreenName): Nav => ({ screen, go: s => went.push(s), openPlace: () => {} });
    let r: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      r = renderer.create(<TabBar nav={navAt('setup')} />);
    });
    const tabs = () => r!.root.findAll(n => n.props.accessibilityRole === 'tab' && typeof n.props.onPress === 'function');
    const selected = () => tabs().filter(n => n.props.accessibilityState?.selected).map(n => n.props.accessibilityLabel);
    expect(tabs().map(n => n.props.accessibilityLabel)).toEqual(['Now', 'Map', 'Chat', 'Translate', 'Scan']);
    expect(selected()).toEqual(['Chat']);
    expect(r!.root.findAll(n => String(n.type) === 'Text')).toHaveLength(0); // icons only
    for (const label of ['Now', 'Map', 'Chat', 'Translate', 'Scan']) expect(r!.root.findAll(n => n.props.tooltip === label).length).toBeGreaterThan(0);
    expect(r!.root.findAll(n => n.props.accessibilityLabel === 'Ask your buddy')).toHaveLength(0); // the mic orb left the bar
    await act(async () => tabs()[4].props.onPress());
    await act(async () => tabs()[2].props.onPress());
    expect(went).toEqual(['look', 'setup']);
    await act(async () => {
      r!.update(<TabBar nav={navAt('look')} />);
      jest.advanceTimersByTime(1500);
    });
    expect(selected()).toEqual(['Scan']);
    act(() => r!.unmount());
  });

  it('floating buddy: a tap talks in place, facts sit under their own answer, hidden where asked', async () => {
    let setCited: ((c: unknown) => void) | undefined;
    // Tokens a few ms apart (fake timers), so "busy" renders before the reply speaks, as in the app.
    const slowRuntime: Runtime = { ...runtime, llm: new FixtureLLM(llmAnswers) };
    function BuddyHarness({ visible }: { visible: boolean }) {
      const b = useBuddy(slowRuntime, index);
      const [cited, set] = React.useState<unknown>();
      setCited = set;
      latest = b;
      return <FloatingBuddy b={(cited ? { ...b, cited } : b) as Buddy} visible={visible} />;
    }
    const audio = runtime.audio;
    let finish: ((heard: { text: string }) => void) | undefined;
    const listen = jest.spyOn(audio, 'listen').mockImplementation(onPartial => {
      onPartial('Tell me about');
      return new Promise(resolve => {
        finish = resolve;
      });
    });
    const stop = jest.spyOn(audio, 'stopListening');
    const settle = async () => {
      for (let i = 0; i < 6; i++) {
        await act(async () => {
          await jest.advanceTimersByTimeAsync(500);
        });
      }
    };
    try {
      let r: renderer.ReactTestRenderer | undefined;
      await act(async () => {
        r = renderer.create(<BuddyHarness visible />);
      });
      const json = () => JSON.stringify(r!.toJSON());
      const orb = () => r!.root.findAll(n => n.props.accessibilityHint === 'Drag to move it' && typeof n.props.onAccessibilityTap === 'function')[0];
      expect(orb().props.accessibilityLabel).toBe('Ask your buddy');
      expect(json()).not.toContain('Your buddy'); // the panel opens only on a tap

      // Typed audio has no microphone: the panel offers a text field instead.
      await act(async () => orb().props.onAccessibilityTap());
      expect(json()).toContain('No microphone here: type your question.');
      expect(r!.root.findAll(n => String(n.type) === 'Text').length).toBeGreaterThan(0); // (the tab bar test's "no words" check can see words)
      expect(listen).not.toHaveBeenCalled();
      const input = () => r!.root.findAll(n => n.props.accessibilityLabel === 'Ask your buddy' && typeof n.props.onSubmitEditing === 'function')[0];
      await act(async () => input().props.onChangeText('What is the Giralda?'));
      await act(async () => input().props.onSubmitEditing());
      await settle();
      const reply = latest!.chat.filter(l => l.who === 'buddy').at(-1)!;
      expect(reply.pending).toBeFalsy();
      expect(json()).toContain('What is the Giralda?');
      expect(json()).toContain(reply.text.slice(0, 24));

      // The facts behind the answer: at most three, with their source.
      const facts = index.pack.facts.slice(0, 4).map((f, i) => (i === 0 ? { ...f, source: 'https://en.wikipedia.org/wiki/Giralda', license: 'CC BY-SA 4.0' } : f));
      await act(async () => setCited!({ facts }));
      expect(json()).toContain('From your Seville guide');
      for (const f of facts.slice(0, 3)) expect(json()).toContain(f.title);
      expect(r!.root.findAll(n => n.props.accessibilityLabel?.startsWith?.(`${facts[3].title}.`))).toHaveLength(0);
      expect(json()).toContain('Wikipedia · CC BY-SA 4.0');
      // A new question: the old answer's facts go.
      await act(async () => input().props.onChangeText('And the Alcázar?'));
      await act(async () => input().props.onSubmitEditing());
      await settle();
      expect(json()).not.toContain('From your Seville guide');

      // With a microphone: listening, the live words, tap again to finish; the answer streams in.
      await act(async () => r!.root.findAll(n => n.props.accessibilityLabel === 'Close' && typeof n.props.onPress === 'function')[0].props.onPress());
      expect(json()).not.toContain('Your buddy');
      jest.replaceProperty(audio, 'info', { ...audio.info, hasMicrophone: true });
      await act(async () => orb().props.onAccessibilityTap());
      expect(listen).toHaveBeenCalledTimes(1);
      expect(json()).toContain('Listening');
      expect(json()).toContain('Tell me about');
      expect(orb().props.accessibilityLabel).toBe('Stop listening');
      // The helper's mic level reaches the orb through the client's onLevel slot.
      expect(() => (audio as { onLevel?: (v: number) => void }).onLevel?.(0.6)).not.toThrow();
      await act(async () => orb().props.onAccessibilityTap());
      expect(stop).toHaveBeenCalled();
      await act(async () => finish!({ text: 'Tell me about the cathedral' }));
      await settle();
      expect(json()).toContain('Tell me about the cathedral');
      expect(latest!.chat.at(-1)!.pending).toBeFalsy();

      // Closing mid-listen still sends what was heard (useBuddy can't cancel a listen) but keeps that
      // reply quiet; a listen closed before anything was said silences nothing: the next answer speaks.
      const closePanel = () => r!.root.findAll(n => n.props.accessibilityLabel === 'Close' && typeof n.props.onPress === 'function')[0].props.onPress();
      const speak = jest.spyOn(audio, 'speak');
      await act(async () => orb().props.onAccessibilityTap());
      expect(orb().props.accessibilityLabel).toBe('Stop listening');
      await act(async () => closePanel());
      await act(async () => finish!({ text: 'Is the Giralda worth climbing?' }));
      await settle();
      expect(latest!.chat.at(-2)).toMatchObject({ who: 'you', text: 'Is the Giralda worth climbing?' });
      expect(speak).not.toHaveBeenCalled();
      await act(async () => orb().props.onAccessibilityTap());
      await act(async () => closePanel());
      await act(async () => finish!({ text: '' }));
      await act(async () => orb().props.onAccessibilityTap());
      expect(json()).not.toContain('Is the Giralda worth climbing?'); // a reopened panel starts afresh
      await act(async () => orb().props.onAccessibilityTap());
      await act(async () => finish!({ text: 'What is the Giralda?' }));
      await settle();
      expect(speak).toHaveBeenCalled();

      // Hidden on Chat and Translate.
      await act(async () => r!.update(<BuddyHarness visible={false} />));
      expect(r!.root.findAll(n => n.props.accessibilityHint === 'Drag to move it')).toHaveLength(0);
      act(() => r!.unmount());
    } finally {
      jest.restoreAllMocks();
    }
  });
});
