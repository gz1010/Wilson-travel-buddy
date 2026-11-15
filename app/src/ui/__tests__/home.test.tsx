/**
 * The home's routing in DuskRoot: the app opens on the home while the models connect, a city card
 * tapped while Wilson is still waking opens its guide once he is awake, and the city's name in
 * Now's header leads back home. The runtime is the fixture model and typed audio (no helpers).
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { PackIndex } from '../../core/pack';
import { seville } from '../../pack/seville';
import { DuskRoot } from '../DuskRoot';
import { FloatingBuddy } from '../dusk/Buddy';
import { NowScreen } from '../screens/NowScreen';
import { WelcomeScreen } from '../screens/WelcomeScreen';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => {}),
  removeItem: jest.fn(async () => {}),
}));
jest.mock('buddy-maplibre', () => ({ js: '', css: '' }), { virtual: true });
jest.mock('buddy-tiles', () => ({ minzoom: 0, maxzoom: 0, tiles: null }), { virtual: true });
jest.mock('buddy-aerial', () => ({ source: 'test', attribution: '', minzoom: 15, maxzoom: 15, bounds: [-6.02, 37.365, -5.97, 37.41], tiles: {} }), { virtual: true });
jest.mock('react-native-webview', () => {
  const { View } = require('react-native');
  return { WebView: View, default: View };
});

/** Lets the test decide when the models are "connected". */
let mockConnect: (() => void) | undefined;
jest.mock('../../services/runtime', () => {
  const { FixtureLLM } = require('../../services/llm/fixtureLLM');
  const { TypedAudio } = require('../../services/audio/typedAudio');
  const { llmAnswers } = require('../../fixtures/llmAnswers');
  const lines = require('../../fixtures/conversation_es_en.json');
  return {
    connectRuntime: (onStatus: (s: string) => void) =>
      new Promise(resolve => {
        onStatus('Connecting to Bonsai-2…');
        mockConnect = () => resolve({ llm: new FixtureLLM(llmAnswers, 0), audio: new TypedAudio(lines), live: { llm: false, audio: false } });
      }),
  };
});

beforeAll(() => jest.useFakeTimers());
afterAll(() => jest.useRealTimers());

const index = new PackIndex(seville);

it('opens on the home, opens Seville once Wilson is awake, and comes back home from Now', async () => {
  let r: renderer.ReactTestRenderer | undefined;
  await act(async () => {
    r = renderer.create(<DuskRoot index={index} />);
  });
  const root = () => r!.root;
  expect(root().findAllByType(WelcomeScreen)).toHaveLength(1);
  expect(JSON.stringify(r!.toJSON())).toContain('Connecting to Bonsai-2…');

  // Tapped while the models still load: the card waits (its corner spins), the home stays.
  const card = () => root().findAll(n => /^Seville \(Sevilla\), Spain\./.test(String(n.props.accessibilityLabel ?? '')) && typeof n.props.onPress === 'function')[0];
  await act(async () => card().props.onPress());
  expect(root().findAllByType(WelcomeScreen)).toHaveLength(1);
  expect(card().props.accessibilityState).toMatchObject({ busy: true });

  // Wilson wakes up (the runtime connects, the saved trip is read): Seville's guide opens.
  await act(async () => {
    mockConnect!();
  });
  await act(async () => {
    jest.advanceTimersByTime(50);
  });
  expect(root().findAllByType(WelcomeScreen)).toHaveLength(0);
  expect(root().findAllByType(NowScreen)).toHaveLength(1);

  // The city's name in Now's header goes home; the floating Wilson hides there (the home has its own).
  const home = root().findAll(n => n.props.accessibilityLabel === 'Seville guide' && n.props.accessibilityHint === 'Back to the cities Wilson knows' && typeof n.props.onPress === 'function');
  expect(home.length).toBeGreaterThan(0);
  await act(async () => home[0].props.onPress());
  expect(root().findAllByType(WelcomeScreen)).toHaveLength(1);
  expect(root().findAllByType(NowScreen)).toHaveLength(0);
  expect(root().findByType(FloatingBuddy).props.visible).toBe(false);
  expect(JSON.stringify(r!.toJSON())).toContain('On this Mac: ');

  // Awake now, a tap opens the guide straight away.
  await act(async () => card().props.onPress());
  expect(root().findAllByType(NowScreen)).toHaveLength(1);
  act(() => r!.unmount());
});
