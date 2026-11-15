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

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => {}),
  removeItem: jest.fn(async () => {}),
}));
// Metro aliases for the bundled map; the map itself is a web view, stubbed below.
jest.mock('buddy-maplibre', () => ({ js: '', css: '' }), { virtual: true });
jest.mock('buddy-tiles', () => ({ minzoom: 0, maxzoom: 0, tiles: null }), { virtual: true });
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

const screens = { now: NowScreen, place: PlaceScreen, map: MapScreen, setup: SetupScreen, talk: TalkScreen };

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
    act(() => r!.update(<WelcomeScreen city="Seville" steps={[]} status="" models={['Bonsai-2', 'WhisperKit']} ready onStart={() => {}} />));
    expect(JSON.stringify(r!.toJSON())).toContain('Bonsai-2 · WhisperKit');
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
      }
      expect(r!.toJSON()).toBeTruthy();
      expect(latest!.chat.some(l => l.who === 'buddy' && !l.pending)).toBe(true);
      expect(latest!.trip).toBeDefined();
      act(() => r!.unmount());
    });
  }
});
