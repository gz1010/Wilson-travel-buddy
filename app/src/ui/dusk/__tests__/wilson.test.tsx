/**
 * Wilson (dusk/Wilson.tsx): his mood from the app's state, his levels, his face in every mood and
 * size, and the floating Wilson's liquid-glass drag (dusk/Buddy.tsx).
 */
import React from 'react';
import { AccessibilityInfo, Animated } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { NOT_IN_GUIDE } from '../../../core/prompts';
import type { Buddy } from '../../useBuddy';
import { FloatingBuddy } from '../Buddy';
import {
  HAPPY_MS,
  isDecline,
  UNSURE_MS,
  useWilsonLevel,
  useWilsonMood,
  Wilson,
  WILSON_MOODS,
  WILSON_SIZE,
  wilsonMood,
  wilsonMoodUntil,
  type WilsonMood,
  type WilsonMoodSource,
} from '../Wilson';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => {}),
  removeItem: jest.fn(async () => {}),
}));

type Line = NonNullable<WilsonMoodSource['chat']>[number];
const stop = (id: string) => ({ id });
const reply = (id: string, text: string, extra: Partial<Line> = {}): Line => ({ id, who: 'buddy', text, ...extra });
const asked = (id: string, text: string): Line => ({ id, who: 'you', text });

/** A Buddy-shaped state with a stable companion, as useBuddy gives (its companion is memoised). */
function app(init: Partial<WilsonMoodSource> = {}) {
  const companion = {};
  let state: WilsonMoodSource = { listening: false, speaking: false, busy: false, chat: [], trip: undefined, tripLoaded: true, companion, ...init };
  return {
    get: () => state,
    set(patch: Partial<WilsonMoodSource>) {
      state = { ...state, ...patch, companion };
      return state;
    },
  };
}

describe('wilsonMood', () => {
  it('listening, speaking and thinking come first, in that order; otherwise idle', () => {
    const a = app();
    expect(wilsonMood(a.get(), { now: 0 })).toBe('idle');
    expect(wilsonMood(a.set({ busy: true }), { now: 1 })).toBe('thinking');
    expect(wilsonMood(a.set({ busy: true, speaking: true }), { now: 2 })).toBe('speaking');
    expect(wilsonMood(a.set({ busy: true, speaking: true, listening: true }), { now: 3 })).toBe('listening');
    expect(wilsonMood(a.set({ busy: false, speaking: false, listening: false }), { now: 4 })).toBe('idle');
  });

  it('thinks while the day re-plans only when asked to (the timeline)', () => {
    const a = app({ recsThinking: true });
    expect(wilsonMood(a.get(), { now: 0 })).toBe('idle');
    expect(wilsonMood(a.get(), { now: 1, replan: true })).toBe('thinking');
  });

  it('is happy for ~2 s after a stop is added to the day', () => {
    const a = app({ trip: { stops: [stop('s1')] } });
    expect(wilsonMood(a.get(), { now: 1000 })).toBe('idle');
    expect(wilsonMood(a.set({ trip: { stops: [stop('s1'), stop('s2')] } }), { now: 2000 })).toBe('happy');
    expect(wilsonMoodUntil(a.get(), 2000)).toBe(2000 + HAPPY_MS);
    expect(wilsonMood(a.get(), { now: 2000 + HAPPY_MS - 1 })).toBe('happy');
    expect(wilsonMood(a.get(), { now: 2000 + HAPPY_MS + 1 })).toBe('idle');
    expect(wilsonMoodUntil(a.get(), 2000 + HAPPY_MS + 1)).toBeUndefined();
    // Removing a stop is not a reason to smile.
    expect(wilsonMood(a.set({ trip: { stops: [stop('s2')] } }), { now: 9000 })).toBe('idle');
  });

  it('a stop added by voice: happy once he has finished thinking and speaking', () => {
    const a = app({ trip: { stops: [] } });
    wilsonMood(a.get(), { now: 0 });
    expect(wilsonMood(a.set({ busy: true, trip: { stops: [stop('giralda')] } }), { now: 100 })).toBe('thinking');
    expect(wilsonMood(a.set({ busy: false, speaking: true }), { now: 900 })).toBe('speaking');
    expect(wilsonMood(a.set({ speaking: false }), { now: 3000 })).toBe('happy');
    expect(wilsonMood(a.get(), { now: 3000 + HAPPY_MS + 1 })).toBe('idle');
  });

  it('the saved trip arriving from storage is not "added"', () => {
    const a = app({ tripLoaded: false, trip: undefined });
    expect(wilsonMood(a.get(), { now: 0 })).toBe('idle');
    expect(wilsonMood(a.set({ trip: { stops: [stop('a'), stop('b')] } }), { now: 10 })).toBe('idle');
    expect(wilsonMood(a.set({ tripLoaded: true }), { now: 20 })).toBe('idle');
    // Already loaded when he first looks: the stops he finds are not new either.
    const b = app({ trip: { stops: [stop('x')] } });
    expect(wilsonMood(b.get(), { now: 0 })).toBe('idle');
  });

  it('is unsure for ~4 s after a "not in my guide" answer, once it has been said', () => {
    const a = app({ chat: [asked('l1', 'Hi'), reply('l2', 'Hello!')] });
    expect(wilsonMood(a.get(), { now: 0 })).toBe('idle');
    // Streaming: the pending line isn't judged yet.
    const pending = [asked('l1', 'Hi'), reply('l2', 'Hello!'), asked('l3', 'Where is the Louvre?'), reply('l4', '', { pending: true })];
    expect(wilsonMood(a.set({ busy: true, chat: pending }), { now: 100 })).toBe('thinking');
    const done = [...pending.slice(0, 3), reply('l4', NOT_IN_GUIDE)];
    expect(wilsonMood(a.set({ busy: false, speaking: true, chat: done }), { now: 600 })).toBe('speaking');
    expect(wilsonMood(a.set({ speaking: false }), { now: 2000 })).toBe('unsure');
    expect(wilsonMood(a.get(), { now: 2000 + UNSURE_MS - 1 })).toBe('unsure');
    expect(wilsonMood(a.get(), { now: 2000 + UNSURE_MS + 1 })).toBe('idle');
  });

  it('a failed answer also makes him unsure; an old decline he finds on first look does not', () => {
    const a = app({ chat: [reply('l1', NOT_IN_GUIDE)] });
    expect(wilsonMood(a.get(), { now: 0 })).toBe('idle');
    expect(wilsonMood(a.set({ chat: [reply('l1', NOT_IN_GUIDE), reply('l2', 'Something went wrong: offline', { error: true })] }), { now: 5 })).toBe('unsure');
  });

  it('starting to listen ends a happy or unsure moment', () => {
    const a = app({ chat: [] });
    wilsonMood(a.get(), { now: 0 });
    expect(wilsonMood(a.set({ chat: [reply('l1', NOT_IN_GUIDE)] }), { now: 10 })).toBe('unsure');
    expect(wilsonMood(a.set({ listening: true }), { now: 500 })).toBe('listening');
    expect(wilsonMood(a.set({ listening: false }), { now: 900 })).toBe('idle');
  });

  it('a quiet wait for a follow-up does not hold back the moment; speaking up turns him to listening', () => {
    const a = app({ trip: { stops: [] }, chat: [asked('l1', 'Add the Alcázar')] });
    wilsonMood(a.get(), { now: 0 });
    expect(wilsonMood(a.set({ busy: true, trip: { stops: [stop('alcazar')] } }), { now: 100 })).toBe('thinking');
    expect(wilsonMood(a.set({ busy: false, speaking: true }), { now: 900 })).toBe('speaking');
    // His answer has played; he listens for a follow-up (useBuddy's call and response), nothing heard yet.
    expect(wilsonMood(a.set({ speaking: false, listening: true, followUp: true, partial: '' }), { now: 3000 })).toBe('happy');
    // On the timeline the re-plan doesn't cut the moment short while he waits.
    expect(wilsonMood(a.set({ recsThinking: true }), { now: 3100, replan: true })).toBe('happy');
    expect(wilsonMood(a.set({ recsThinking: false }), { now: 3000 + HAPPY_MS + 1 })).toBe('listening');
    // Words arrive: listening at once, and the moment is over.
    const b = app({ trip: { stops: [] } });
    wilsonMood(b.get(), { now: 0 });
    expect(wilsonMood(b.set({ trip: { stops: [stop('x')] }, listening: true, followUp: true, partial: '' }), { now: 10 })).toBe('happy');
    expect(wilsonMood(b.set({ partial: 'And the' }), { now: 20 })).toBe('listening');
    expect(wilsonMood(b.set({ listening: false, followUp: false, partial: '' }), { now: 30 })).toBe('idle');
  });

  it('a moment still waiting when a new question is asked is dropped, not shown after the next answer', () => {
    const a = app({ trip: { stops: [] }, chat: [] });
    wilsonMood(a.get(), { now: 0 });
    // A stop lands while he is speaking; a tap stops him and listens for a new question at once.
    expect(wilsonMood(a.set({ speaking: true, trip: { stops: [stop('s1')] } }), { now: 10 })).toBe('speaking');
    expect(wilsonMood(a.set({ speaking: false, listening: true }), { now: 20 })).toBe('listening');
    const chat = [asked('l1', 'What time does it close?'), reply('l2', '', { pending: true })];
    expect(wilsonMood(a.set({ listening: false, busy: true, chat }), { now: 30 })).toBe('thinking');
    expect(wilsonMood(a.set({ busy: false, chat: [chat[0], reply('l2', 'At 17:00.')] }), { now: 40 })).toBe('idle');
  });

  it('wakes while the models load', () => {
    expect(wilsonMood(app({ ready: false }).get(), { now: 0 })).toBe('waking');
    expect(wilsonMood(app({ waking: true }).get(), { now: 0 })).toBe('waking');
    expect(wilsonMood(app({ ready: true }).get(), { now: 0 })).toBe('idle');
    expect(wilsonMood(app({ ready: false, listening: true }).get(), { now: 0 })).toBe('listening');
  });
});

describe('isDecline', () => {
  it('knows the companion\'s decline and its usual variants, and nothing else', () => {
    expect(isDecline(NOT_IN_GUIDE)).toBe(true);
    expect(isDecline("My guide doesn't cover that one. Want something nearby instead?")).toBe(true);
    expect(isDecline("Sorry, that's not in my guide.")).toBe(true);
    expect(isDecline('The Louvre isn’t in my guide for this trip.')).toBe(true);
    expect(isDecline('The Giralda is the cathedral’s bell tower, and it is in my guide.')).toBe(false);
    expect(isDecline('Added the Alcázar to your day at 10:00.')).toBe(false);
  });
});

describe('useWilsonMood', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('goes back to idle by itself when the happy moment is over', async () => {
    const a = app({ trip: { stops: [] } });
    const seen: WilsonMood[] = [];
    function Probe({ b }: { b: WilsonMoodSource }) {
      seen.push(useWilsonMood(b));
      return null;
    }
    let r: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      r = renderer.create(<Probe b={a.get()} />);
    });
    await act(async () => r!.update(<Probe b={a.set({ trip: { stops: [stop('s1')] } })} />));
    expect(seen.at(-1)).toBe('happy');
    await act(async () => {
      jest.advanceTimersByTime(HAPPY_MS + 100);
    });
    expect(seen.at(-1)).toBe('idle');
    act(() => r!.unmount());
  });
});

describe('useWilsonLevel', () => {
  it('follows b.levels: the microphone while listening, the voice while speaking, and lets go', async () => {
    let send: ((l: { mic: number; voice: number }) => void) | undefined;
    const off = jest.fn();
    const levels = {
      subscribe: jest.fn((cb: (l: { mic: number; voice: number }) => void) => {
        send = cb;
        return off;
      }),
    };
    let out: { level: Animated.Value; voice: boolean } | undefined;
    function Probe({ listening, speaking }: { listening: boolean; speaking: boolean }) {
      out = useWilsonLevel({ listening, speaking, levels, runtime: { audio: {} } });
      return null;
    }
    let r: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      r = renderer.create(<Probe listening speaking={false} />);
    });
    expect(levels.subscribe).toHaveBeenCalledTimes(1);
    expect(out!.voice).toBe(true);
    expect(() => send!({ mic: 0.7, voice: 0.1 })).not.toThrow();
    await act(async () => r!.update(<Probe listening={false} speaking />));
    expect(() => send!({ mic: 0.1, voice: 0.9 })).not.toThrow();
    act(() => r!.unmount());
    expect(off).toHaveBeenCalled();
  });

  it('without b.levels it chains onto the helper\'s onLevel slot and puts the old one back', async () => {
    const before = jest.fn();
    const audio: { onLevel?: (v: number) => void } = { onLevel: before };
    let out: { level: Animated.Value; voice: boolean } | undefined;
    function Probe() {
      out = useWilsonLevel({ listening: true, speaking: false, runtime: { audio } });
      return null;
    }
    let r: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      r = renderer.create(<Probe />);
    });
    expect(out!.voice).toBe(false);
    expect(audio.onLevel).not.toBe(before);
    audio.onLevel!(0.5);
    expect(before).toHaveBeenCalledWith(0.5);
    act(() => r!.unmount());
    expect(audio.onLevel).toBe(before);
  });
});

describe('Wilson', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('draws every mood at every size, with or without a level, and blinks without trouble', async () => {
    const level = new Animated.Value(0.4);
    for (const size of [WILSON_SIZE.welcome, WILSON_SIZE.timeline, WILSON_SIZE.inline, 64]) {
      for (const mood of WILSON_MOODS) {
        for (const lv of [undefined, 0.6, level]) {
          let r: renderer.ReactTestRenderer | undefined;
          await act(async () => {
            r = renderer.create(<Wilson size={size} mood={mood} level={lv} />);
          });
          await act(async () => {
            jest.advanceTimersByTime(6500); // a blink, a breath, a glance
          });
          const root = r!.root.findAll(n => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('Wilson, '))[0];
          expect(root).toBeTruthy();
          expect(JSON.stringify(r!.toJSON())).toContain(`"width":${size}`);
          act(() => r!.unmount());
        }
      }
    }
  });

  it('is a button when he can be tapped (VoiceOver too)', async () => {
    const onPress = jest.fn();
    let r: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      r = renderer.create(<Wilson size={48} mood="idle" onPress={onPress} />);
    });
    const button = r!.root.findAll(n => n.props.accessibilityRole === 'button' && typeof n.props.onAccessibilityTap === 'function')[0];
    expect(button.props.accessibilityLabel).toBe('Talk to Wilson');
    await act(async () => button.props.onAccessibilityTap());
    expect(onPress).toHaveBeenCalledTimes(1);
    act(() => r!.unmount());
  });

  it('mood changes swap the face (happy hops, waking dims) without throwing', async () => {
    let r: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      r = renderer.create(<Wilson size={120} mood="idle" />);
    });
    for (const mood of ['listening', 'thinking', 'speaking', 'happy', 'unsure', 'waking', 'idle'] as WilsonMood[]) {
      await act(async () => {
        r!.update(<Wilson size={120} mood={mood} />);
        jest.advanceTimersByTime(500);
      });
      expect(r!.root.findAll(n => n.props.accessibilityLabel === `Wilson, ${mood === 'idle' ? 'waiting' : mood === 'happy' ? 'added to your day' : mood === 'unsure' ? 'not in my guide' : mood === 'waking' ? 'waking up' : mood}`).length).toBeGreaterThan(0);
    }
    act(() => r!.unmount());
  });
});

describe('Floating Wilson: the liquid-glass drag', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** One finger on the orb, as React Native's responder system reports it. */
  function touch(x: number, y: number, px: number, py: number, t: number, t0: number) {
    const touchHistory = {
      numberActiveTouches: 1,
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: t,
      touchBank: [
        { touchActive: true, startPageX: 300, startPageY: 600, startTimeStamp: t0, currentPageX: x, currentPageY: y, currentTimeStamp: t, previousPageX: px, previousPageY: py, previousTimeStamp: t - 16 },
      ],
    };
    return { touchHistory, nativeEvent: { touches: [{ pageX: x, pageY: y }], changedTouches: [{ pageX: x, pageY: y }], pageX: x, pageY: y, timestamp: t } };
  }

  it('stretches along the drag, lights up, then lets go: no panel, no tap, he settles at a side', async () => {
    const talk = jest.fn();
    const b = {
      listening: false,
      speaking: false,
      busy: false,
      chat: [],
      partial: '',
      status: undefined,
      trip: undefined,
      tripLoaded: true,
      companion: {},
      index: { destination: { name: 'Seville' } },
      runtime: { audio: { info: { hasMicrophone: true, models: [], liveSpeakers: false } } },
      talk,
      stopSpeaking: jest.fn(),
      send: jest.fn(),
    } as unknown as Buddy;
    let r: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      r = renderer.create(<FloatingBuddy b={b} visible />);
    });
    const orb = () => r!.root.findAll(n => n.props.accessibilityHint === 'Drag to move it' && typeof n.props.onResponderMove === 'function')[0];
    const wilson = () => r!.root.findAll(n => n.props.motion !== undefined && typeof n.props.mood === 'string')[0];
    const value = (v: Animated.Value) => (v as unknown as { __getValue(): number }).__getValue();
    expect(wilson().props.size).toBe(64);
    expect(wilson().props.mood).toBe('idle');

    const t0 = Date.now();
    await act(async () => orb().props.onResponderGrant(touch(300, 600, 300, 600, t0, t0)));
    // A quick throw to the left: each move 16 ms and 30 px apart.
    let x = 300;
    for (let i = 1; i <= 6; i++) {
      jest.advanceTimersByTime(16);
      const px = x;
      x -= 30;
      await act(async () => orb().props.onResponderMove(touch(x, 600, px, 600, t0 + i * 16, t0)));
    }
    const motion = wilson().props.motion;
    expect(wilson().props.lifted).toBe(true);
    expect(value(motion.stretch)).toBeGreaterThan(0.1);
    expect(value(motion.stretch)).toBeLessThanOrEqual(0.3);
    expect(Math.abs(Math.abs(value(motion.angle)) - Math.PI)).toBeLessThan(0.05); // heading left
    expect(value(motion.moving)).toBeGreaterThan(0.5);

    await act(async () => orb().props.onResponderRelease(touch(x, 600, x, 600, t0 + 7 * 16, t0)));
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(wilson().props.lifted).toBe(false);
    // Thrown left of the middle (the test window is 390 wide): he rests at the left edge.
    const host = r!.root.findAll(n => typeof n.type === 'string' && n.props.accessibilityHint === 'Drag to move it')[0];
    expect([host.props.style].flat().find((s: { left?: number }) => s && typeof s.left === 'number')?.left).toBe(12);
    expect(talk).not.toHaveBeenCalled(); // a drag is not a tap
    expect(JSON.stringify(r!.toJSON())).not.toContain('Hi, I'); // and opens no panel
    act(() => r!.unmount());
  });

  it('a tap opens the panel with his greeting', async () => {
    const b = {
      listening: false,
      speaking: false,
      busy: false,
      chat: [],
      partial: '',
      status: undefined,
      trip: undefined,
      tripLoaded: true,
      companion: {},
      index: { destination: { name: 'Seville' } },
      runtime: { audio: { info: { hasMicrophone: true, models: [], liveSpeakers: false } } },
      talk: jest.fn(),
      stopSpeaking: jest.fn(),
      send: jest.fn(),
      wake: { enabled: true, setEnabled: jest.fn(), listening: true },
    } as unknown as Buddy;
    let r: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      r = renderer.create(<FloatingBuddy b={b} visible />);
    });
    const orb = r!.root.findAll(n => n.props.accessibilityHint === 'Drag to move it' && typeof n.props.onAccessibilityTap === 'function')[0];
    await act(async () => orb.props.onAccessibilityTap());
    expect(b.talk).toHaveBeenCalledTimes(1);
    const json = JSON.stringify(r!.toJSON());
    expect(json).toMatch(/Hi, I'm Wilson\. I live on this Mac, so I work without signal\. Tap me, or start with “Wilson,\s…”\./);
    expect(json).toContain('Wilson'); // the panel's heading
    act(() => r!.unmount());
  });

  it('while he listens for a follow-up the answer stays; closing cancels the exchange (cancelVoice)', async () => {
    const base = {
      speaking: false,
      busy: false,
      partial: '',
      status: undefined,
      trip: undefined,
      tripLoaded: true,
      companion: {},
      index: { destination: { name: 'Seville' } },
      runtime: { audio: { info: { hasMicrophone: true, models: [], liveSpeakers: false } } },
      talk: jest.fn(),
      stopSpeaking: jest.fn(),
      send: jest.fn(),
      cancelVoice: jest.fn(),
    };
    const idle = { ...base, listening: false, followUp: false, chat: [] } as unknown as Buddy;
    let r: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      r = renderer.create(<FloatingBuddy b={idle} visible />);
    });
    const orb = r!.root.findAll(n => n.props.accessibilityHint === 'Drag to move it' && typeof n.props.onAccessibilityTap === 'function')[0];
    await act(async () => orb.props.onAccessibilityTap());
    const chat = [asked('l1', 'Is the Alcázar open today?'), reply('l2', 'Yes, until 17:00.')];
    await act(async () => r!.update(<FloatingBuddy b={{ ...base, listening: true, followUp: true, chat } as unknown as Buddy} visible />));
    let json = JSON.stringify(r!.toJSON());
    expect(json).toContain('Is the Alcázar open today?');
    expect(json).toContain('Yes, until 17:00.');
    expect(json).toContain('Listening for a follow-up');
    await act(async () => r!.update(<FloatingBuddy b={{ ...base, listening: true, followUp: true, partial: 'And tomorrow', chat } as unknown as Buddy} visible />));
    json = JSON.stringify(r!.toJSON());
    expect(json).toContain('And tomorrow');
    expect(json).toContain('Yes, until 17:00.');
    const close = r!.root.findAll(n => n.props.accessibilityLabel === 'Close' && typeof n.props.onPress === 'function')[0];
    await act(async () => close.props.onPress());
    expect(base.cancelVoice).toHaveBeenCalledTimes(1);
    expect(base.talk).toHaveBeenCalledTimes(1); // only the tap that opened the panel
    expect(base.stopSpeaking).not.toHaveBeenCalled();
    act(() => r!.unmount());
  });

  it('closing while he is still writing a reply keeps it quiet; a failed answer is "Unsure", not "Not in my guide"', async () => {
    const base = {
      listening: false,
      speaking: false,
      partial: '',
      status: undefined,
      trip: undefined,
      tripLoaded: true,
      companion: {},
      index: { destination: { name: 'Seville' } },
      runtime: { audio: { info: { hasMicrophone: true, models: [], liveSpeakers: false } } },
      talk: jest.fn(),
      stopSpeaking: jest.fn(),
      send: jest.fn(),
      cancelVoice: jest.fn(),
    };
    const asking = [asked('l1', 'Is the Alcázar open?'), reply('l2', '', { pending: true })];
    let r: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      r = renderer.create(<FloatingBuddy b={{ ...base, busy: false, chat: [] } as unknown as Buddy} visible />);
    });
    const orb = () => r!.root.findAll(n => n.props.accessibilityHint === 'Drag to move it' && typeof n.props.onAccessibilityTap === 'function')[0];
    await act(async () => orb().props.onAccessibilityTap());
    await act(async () => r!.update(<FloatingBuddy b={{ ...base, busy: true, chat: asking } as unknown as Buddy} visible />));
    const close = () => r!.root.findAll(n => n.props.accessibilityLabel === 'Close' && typeof n.props.onPress === 'function')[0];
    await act(async () => close().props.onPress());
    expect(base.cancelVoice).toHaveBeenCalledTimes(1);
    expect(base.stopSpeaking).toHaveBeenCalledTimes(1);

    // The answer fails: he looks unsure, but the heading doesn't say the guide declined.
    const failed = [asking[0], reply('l2', 'Something went wrong: the model is not running', { error: true })];
    await act(async () => r!.update(<FloatingBuddy b={{ ...base, busy: false, chat: failed } as unknown as Buddy} visible />));
    await act(async () => orb().props.onAccessibilityTap());
    expect(orb().props.accessibilityValue.text).toBe('Wilson: unsure');
    const json = JSON.stringify(r!.toJSON());
    expect(json).toContain('Unsure');
    expect(json).not.toContain('Not in my guide');
    act(() => r!.unmount());
  });

  it('reduce motion: no droplet trail behind him', async () => {
    const spy = jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    const b = {
      listening: false,
      speaking: false,
      busy: false,
      chat: [],
      partial: '',
      status: undefined,
      trip: undefined,
      tripLoaded: true,
      companion: {},
      index: { destination: { name: 'Seville' } },
      runtime: { audio: { info: { hasMicrophone: true, models: [], liveSpeakers: false } } },
      talk: jest.fn(),
      stopSpeaking: jest.fn(),
      send: jest.fn(),
    } as unknown as Buddy;
    const drops = (r: renderer.ReactTestRenderer) =>
      r.root.findAll(n => {
        const t = n.type as { name?: string; type?: { name?: string } } | string;
        return typeof t !== 'string' && (t.name === 'Droplets' || t.type?.name === 'Droplets');
      });
    try {
      let r: renderer.ReactTestRenderer | undefined;
      await act(async () => {
        r = renderer.create(<FloatingBuddy b={b} visible />);
      });
      expect(drops(r!)).toHaveLength(0);
      act(() => r!.unmount());
      spy.mockResolvedValue(false);
      await act(async () => {
        r = renderer.create(<FloatingBuddy b={b} visible />);
      });
      expect(drops(r!).length).toBeGreaterThan(0);
      act(() => r!.unmount());
    } finally {
      spy.mockRestore();
    }
  });
});
