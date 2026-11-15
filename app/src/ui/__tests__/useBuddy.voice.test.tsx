// useBuddy's voice wiring with a stand-in helper that has the wake word: "Wilson, …" asks, the
// answer is spoken, Wilson listens for a follow-up (quietMs 6000), then the wake word comes back.
// Levels reach b.levels without re-rendering. (The loop's own rules: voiceLoop.test.ts.)
import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { PackIndex } from '../../core/pack';
import type { AudioInfo, Heard, Lang, LevelKind, WakeEvent } from '../../core/types';
import { llmAnswers } from '../../fixtures/llmAnswers';
import { seville } from '../../pack/seville';
import { TypedAudio } from '../../services/audio/typedAudio';
import { FixtureLLM } from '../../services/llm/fixtureLLM';
import type { Runtime } from '../../services/runtime';
import { useBuddy, type Buddy } from '../useBuddy';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => {}),
  removeItem: jest.fn(async () => {}),
}));

/** A helper with a microphone and the wake word; listens wait until the test answers them. */
class VoiceHelper extends TypedAudio {
  readonly info: AudioInfo = { hasMicrophone: true, models: ['test helper'], liveSpeakers: false, wake: true };
  wakeOn?: (e: WakeEvent) => void;
  wakeStarts = 0;
  wakeStops = 0;
  listens: { quietMs?: number; answer: (h: Heard) => void }[] = [];
  spoken: string[] = [];
  level?: (kind: LevelKind, value: number) => void;

  constructor() {
    super([]);
  }
  wake(onEvent: (e: WakeEvent) => void) {
    this.wakeStarts++;
    this.wakeOn = onEvent;
    return () => {
      this.wakeStops++;
      this.wakeOn = undefined;
    };
  }
  listen(_onPartial?: (text: string) => void, _language?: Lang, options?: { quietMs?: number }): Promise<Heard> {
    return new Promise(answer => this.listens.push({ quietMs: options?.quietMs, answer }));
  }
  async speak(text: string, _language: Lang, onStart?: () => void) {
    this.spoken.push(text);
    onStart?.();
  }
  subscribeLevels(cb: (kind: LevelKind, value: number) => void) {
    this.level = cb;
    return () => {
      this.level = undefined;
    };
  }
}

const index = new PackIndex(seville);
let latest: Buddy;
let renders = 0;

function setup() {
  const audio = new VoiceHelper();
  const rt: Runtime = { llm: new FixtureLLM(llmAnswers, 0), audio, live: { llm: false, audio: true } };
  function Harness() {
    latest = useBuddy(rt, index);
    renders++;
    return null;
  }
  let r: renderer.ReactTestRenderer;
  act(() => {
    r = renderer.create(<Harness />);
  });
  return { audio, unmount: () => act(() => r.unmount()) };
}

/** Advances fake time. Passive effects flush when act() ends, so a timer an effect starts runs in the next wait. */
const wait = async (ms: number) => {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
};

/** After the first render: the saved toggle loads (one act), then the wake word's 400 ms grace runs (the next). */
const started = async () => {
  await wait(10);
  await wait(1000);
};

beforeAll(() => jest.useFakeTimers());
afterAll(() => jest.useRealTimers());

describe('useBuddy: wake word, call and response, levels', () => {
  it('"Wilson, …" asks; the answer is spoken; Wilson follows up; then the wake word is back', async () => {
    const { audio, unmount } = setup();
    await started();
    expect(latest.wake.enabled).toBe(true);
    expect(latest.wake.available).toBe(true);
    expect(audio.wakeStarts).toBe(1);
    await act(async () => audio.wakeOn!({ type: 'state', listening: true }));
    expect(latest.wake.listening).toBe(true);

    // The name, while the person is still talking: Wilson shows he is listening.
    await act(async () => audio.wakeOn!({ type: 'heard', text: 'What is' }));
    expect(latest.listening).toBe(true);
    expect(latest.partial).toBe('What is');
    expect(audio.wakeStops).toBe(0); // the helper still has the sentence

    await act(async () => audio.wakeOn!({ type: 'wake', text: 'What is the Giralda?', heard: 'Wilson, what is the Giralda?', endedAt: Date.now() - 900 }));
    await wait(3000);
    expect(latest.chat.find(l => l.who === 'you')?.text).toBe('What is the Giralda?');
    expect(audio.spoken.length).toBeGreaterThan(0);
    expect(audio.wakeStops).toBe(1); // off while he thinks and speaks
    expect(latest.latency?.voice).toBe(true);

    // The follow-up: listening again by himself, giving up after 6 s of quiet.
    expect(audio.listens).toHaveLength(1);
    expect(audio.listens[0].quietMs).toBe(6000);
    expect(latest.followUp).toBe(true);
    expect(latest.listening).toBe(true);
    expect(audio.wakeStarts).toBe(1);

    await act(async () => audio.listens[0].answer({ text: '' }));
    expect(latest.followUp).toBe(false);
    expect(latest.listening).toBe(false);
    await wait(1000);
    expect(audio.wakeStarts).toBe(2); // idle again: listening for his name
    unmount();
  });

  it('"Wilson" alone: "Yes?", then a listen for the question', async () => {
    const { audio, unmount } = setup();
    await started();
    await act(async () => audio.wakeOn!({ type: 'wake', text: '', heard: 'Hey Wilson.' }));
    await wait(100);
    expect(audio.spoken).toEqual(['Yes?']);
    expect(audio.listens).toHaveLength(1);
    await act(async () => audio.listens[0].answer({ text: 'Is the Alcázar open?', endedAt: Date.now() }));
    await wait(3000);
    expect(latest.chat.filter(l => l.who === 'you').map(l => l.text)).toEqual(['Is the Alcázar open?']);
    unmount();
  });

  it('a typed message ends a follow-up listen and starts no new one', async () => {
    const { audio, unmount } = setup();
    await started();
    await act(async () => audio.wakeOn!({ type: 'wake', text: 'What is the Giralda?', heard: '' }));
    await wait(3000);
    expect(latest.followUp).toBe(true);
    const stop = jest.spyOn(audio, 'stopListening').mockImplementation(() => audio.listens[0].answer({ text: 'ignored' }));
    await act(async () => {
      await latest.send('And the Alcázar?');
    });
    await wait(3000);
    expect(stop).toHaveBeenCalled();
    expect(latest.chat.filter(l => l.who === 'you').map(l => l.text)).toEqual(['What is the Giralda?', 'And the Alcázar?']);
    expect(audio.listens).toHaveLength(1); // no follow-up after a typed question
    unmount();
  });

  it('cancelVoice() during the sentence after his name drops it at once: the wake word restarts', async () => {
    const { audio, unmount } = setup();
    await started();
    expect(audio.wakeStarts).toBe(1);
    const handler = audio.wakeOn!;
    await act(async () => handler({ type: 'heard', text: 'What is' }));
    expect(latest.listening).toBe(true);
    await act(async () => latest.cancelVoice());
    expect(latest.listening).toBe(false);
    expect(audio.wakeStops).toBe(1); // the helper stops recording that sentence now
    // One already on its way is ignored.
    await act(async () => handler({ type: 'wake', text: 'What is the Giralda?', heard: 'Wilson, what is the Giralda?' }));
    await wait(1000);
    expect(audio.wakeStarts).toBe(2); // listening for his name again
    expect(latest.chat).toHaveLength(0);
    await act(async () => audio.wakeOn!({ type: 'wake', text: 'Is the Alcázar open?', heard: '' }));
    await wait(3000);
    expect(latest.chat.filter(l => l.who === 'you').map(l => l.text)).toEqual(['Is the Alcázar open?']);
    unmount();
  });

  it('the toggle is remembered; hold() keeps it off (Translate) until released', async () => {
    const { audio, unmount } = setup();
    await started();
    expect(audio.wakeStarts).toBe(1);
    await act(async () => latest.wake.setEnabled(false));
    expect(audio.wakeStops).toBe(1);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith('travelbuddy.wake.v1', '0');
    await act(async () => latest.wake.setEnabled(true));
    await wait(1000);
    expect(audio.wakeStarts).toBe(2);

    let release!: () => void;
    await act(async () => {
      release = latest.wake.hold!('translate');
    });
    expect(audio.wakeStops).toBe(2);
    await act(async () => release());
    await wait(1000);
    expect(audio.wakeStarts).toBe(3);
    unmount();
  });

  it('levels reach b.levels subscribers without re-rendering', async () => {
    const { audio, unmount } = setup();
    await started();
    const seen: string[] = [];
    const off = latest.levels.subscribe(l => seen.push(`${l.mic}/${l.voice}`));
    const before = renders;
    act(() => {
      audio.level!('voice', 0.5);
      audio.level!('mic', 0.25);
    });
    expect(renders).toBe(before);
    expect(seen).toEqual(['0/0.5', '0.25/0.5']);
    expect(latest.levels.get()).toEqual({ mic: 0.25, voice: 0.5 });
    off();
    unmount();
  });
});
