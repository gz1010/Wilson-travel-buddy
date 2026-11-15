import React, { useEffect, useId, useMemo, useReducer, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, Ellipse, Line, LinearGradient as SvgLinearGradient, Path, RadialGradient, Stop } from 'react-native-svg';
import { NOT_IN_GUIDE } from '../../core/prompts';
import { axPress, Glass } from './Glass';
import { useReduceMotion } from './motion';
import { dusk, ground, sceneColors, white } from './tokens';

// Wilson, the app's companion ("Meet Wilson", the Dusk companion spec): a liquid-glass orb (the
// dusk Glass orb recipe: Apple's own Liquid Glass on macOS 26) with two eyes and a mouth made of
// light, drawn with react-native-svg. He has no colour of his own; each mood is an app state:
//   idle       tab bar, waiting: a small smile; breathes (scale 1 → 1.02, 4 s) and blinks every 4–6 s
//   listening  rings around him grow with the microphone level (Argmax), an open "o" mouth
//   thinking   Bonsai-2 is working: a flat mouth, the eyes glance up and across
//   speaking   the mouth opens with the voice's level (TTS)
//   happy      added to your day: closed-eye arcs, a big smile, a warm tint
//   unsure     "not in my guide": one eye half shut under a tilted line, a wavy mouth, a cool tint
//   waking     models loading: sleepy half-closed eyes, dimmer
// Sizes: 120 (welcome, translator), 48 (timeline), 32 (inline); the strokes scale with him.
// Motion is Animated with the native driver (Reanimated is not installed). Reduce motion: no
// breathing, glancing or bouncing; the voice still moves his mouth and rings.

export type WilsonMood = 'idle' | 'listening' | 'thinking' | 'speaking' | 'happy' | 'unsure' | 'waking';
export const WILSON_MOODS: readonly WilsonMood[] = ['idle', 'listening', 'thinking', 'speaking', 'happy', 'unsure', 'waking'];

/** The spec's three sizes. Any other number works too. */
export const WILSON_SIZE = { welcome: 120, timeline: 48, inline: 32 } as const;

/** What each mood means, for labels and VoiceOver. */
export const WILSON_MOOD_LABEL: Record<WilsonMood, string> = {
  idle: 'Waiting',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  happy: 'Added to your day',
  unsure: 'Not in my guide',
  waking: 'Waking up',
};

const hexRGB = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const lift = (c: string, k: number) => `#${hexRGB(c).map(v => Math.min(255, Math.round(v * k)).toString(16).padStart(2, '0')).join('')}`;
const alpha = (c: string, a: number) => `rgba(${hexRGB(c).join(',')},${a})`;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The warm awning amber (happy) and the cool arches blue (unsure), from the Dusk scene colours. */
const WARM = lift(sceneColors.awnings.front, 1.9);
const COOL = lift(sceneColors.arches.front, 1.05);

/**
 * Per mood: the glass tint (only happy and unsure lean to a colour, warm and cool), a wash that
 * dims him while waking, the colour of his face (always white light; softer while waking), and an
 * accent for things beside him (a status dot).
 */
export function wilsonTint(mood: WilsonMood): { tint?: string; wash?: string; face: string; light: string } {
  switch (mood) {
    case 'happy':
      return { tint: alpha(WARM, 0.42), face: dusk.color.white, light: WARM };
    case 'unsure':
      return { tint: alpha(COOL, 0.55), face: dusk.color.white, light: COOL };
    case 'waking':
      return { wash: ground(0.32), face: dusk.color.text2, light: dusk.color.text2 };
    default:
      return { face: dusk.color.white, light: dusk.color.white };
  }
}

// ---------------------------------------------------------------------------
// The mood from the app's state.

/** The parts of the Buddy object (ui/useBuddy.ts) the mood is read from; Buddy itself fits. */
export interface WilsonMoodSource {
  listening?: boolean;
  speaking?: boolean;
  busy?: boolean;
  recsThinking?: boolean;
  /** useBuddy's call and response: true while he listens for a follow-up after his answer (listening is true too). */
  followUp?: boolean;
  /** The words heard so far in the current listen. */
  partial?: string;
  chat?: readonly { id: string; who: 'you' | 'buddy'; text: string; pending?: boolean; error?: boolean }[];
  trip?: { stops: readonly { id: string }[] } | undefined;
  tripLoaded?: boolean;
  /** Stable objects the moment-to-moment memory is kept against (the companion, else the runtime). */
  companion?: unknown;
  runtime?: unknown;
  /** Set by the voice side while the models load (either spelling); false / true means waking. */
  ready?: unknown;
  waking?: unknown;
}

/** How long Wilson is happy after a stop lands in the day, and unsure after "not in my guide". */
export const HAPPY_MS = 2000;
export const UNSURE_MS = 4000;

const DECLINES = [
  /(?:\bnot|n['’]t) (?:covered )?in (?:my|the|this|your) guide\b/i,
  /\b(?:my|the) guide (?:doesn['’]?t|does not|can['’]?t|cannot) (?:cover|have|include|mention|say|tell)\b/i,
  /\bnothing (?:about|on) (?:that|this|it) in my guide\b/i,
];

/** True for an answer that declines because the guide doesn't cover it ("That isn't in my guide…"). */
export function isDecline(text: string): boolean {
  const t = text.trim();
  return t === NOT_IN_GUIDE || DECLINES.some(r => r.test(t));
}

interface Seen {
  /** The trip had been read from storage at the last look (stops seen before that aren't "added"). */
  loaded: boolean;
  stops: Set<string>;
  /** The latest finished buddy line already looked at. */
  lastLine?: string;
  /** The latest question ("you" line) already looked at: a new one drops moments still waiting from before it. */
  lastAsk?: string;
  happyPending: boolean;
  unsurePending: boolean;
  happyUntil: number;
  unsureUntil: number;
}
const memory = new WeakMap<object, Seen>();

function keyOf(b: WilsonMoodSource): object {
  if (b.companion && typeof b.companion === 'object') return b.companion;
  if (b.runtime && typeof b.runtime === 'object') return b.runtime;
  return b;
}

function latestReply(b: WilsonMoodSource) {
  const chat = b.chat ?? [];
  for (let i = chat.length - 1; i >= 0; i--) if (chat[i].who === 'buddy' && !chat[i].pending) return chat[i];
  return undefined;
}

function latestAsk(b: WilsonMoodSource): string | undefined {
  const chat = b.chat ?? [];
  for (let i = chat.length - 1; i >= 0; i--) if (chat[i].who === 'you') return chat[i].id;
  return undefined;
}

/**
 * After his spoken answer he waits a few seconds for a follow-up (useBuddy's call and response):
 * until the person starts talking, that wait doesn't hold back his happy or unsure moment, which
 * shows over it.
 */
function quietFollowUp(b: WilsonMoodSource): boolean {
  return !!b.listening && b.followUp === true && !b.partial;
}

/**
 * Looks at the app's state and remembers what changed: a stop that wasn't in the day before makes
 * him happy, a reply that declines (or failed) makes him unsure. Each starts once he has settled
 * (not listening, speaking or thinking; a quiet wait for a follow-up counts as settled), so a
 * spoken "Added it" or "not in my guide" finishes first. A new question drops one still waiting.
 */
function observe(b: WilsonMoodSource, now: number): Seen {
  const key = keyOf(b);
  const stops = new Set((b.trip?.stops ?? []).map(s => s.id));
  const last = latestReply(b);
  const ask = latestAsk(b);
  let s = memory.get(key);
  if (!s) {
    s = { loaded: b.tripLoaded !== false, stops, lastLine: last?.id, lastAsk: ask, happyPending: false, unsurePending: false, happyUntil: 0, unsureUntil: 0 };
    memory.set(key, s);
    return s;
  }
  if (ask !== s.lastAsk) {
    // A new question: a moment from the exchange before it is stale now.
    s.lastAsk = ask;
    s.happyPending = false;
    s.unsurePending = false;
  }
  if (s.loaded) {
    for (const id of stops) {
      if (!s.stops.has(id)) {
        s.happyPending = true;
        break;
      }
    }
  }
  s.stops = stops;
  s.loaded = b.tripLoaded !== false;
  if (last && last.id !== s.lastLine) {
    s.lastLine = last.id;
    if (last.error || isDecline(last.text)) s.unsurePending = true;
  }
  if (b.speaking || b.busy || (b.listening && !quietFollowUp(b))) {
    // Busy again: a happy or unsure face from before gives way (the pending ones wait).
    s.happyUntil = 0;
    s.unsureUntil = 0;
    return s;
  }
  if (s.unsurePending) {
    s.unsurePending = false;
    s.unsureUntil = now + UNSURE_MS;
  }
  if (s.happyPending) {
    s.happyPending = false;
    s.happyUntil = now + HAPPY_MS;
  }
  return s;
}

/** Waking while the voice side says the models are still loading. */
function isWaking(b: WilsonMoodSource): boolean {
  return b.waking === true || b.ready === false;
}

/**
 * Wilson's mood from the Buddy object: listening, speaking, thinking (busy; with `replan` also
 * while the day's recommendations are being re-planned), then unsure for ~4 s after a "not in my
 * guide" reply, happy for ~2 s after a stop is added, waking while the models load, else idle.
 * While he quietly waits for a follow-up (nothing heard yet) a happy or unsure moment shows
 * first, then listening. It remembers what it saw last time (per companion), so call it on each
 * render; useWilsonMood also re-renders when a happy or unsure moment ends.
 */
export function wilsonMood(b: WilsonMoodSource, opts: { now?: number; replan?: boolean } = {}): WilsonMood {
  const now = opts.now ?? Date.now();
  const s = observe(b, now);
  const quiet = quietFollowUp(b);
  if (b.listening && !quiet) return 'listening';
  if (b.speaking) return 'speaking';
  if (b.busy || (!quiet && opts.replan && b.recsThinking)) return 'thinking';
  if (now < s.unsureUntil) return 'unsure';
  if (now < s.happyUntil) return 'happy';
  if (b.listening) return 'listening';
  if (isWaking(b)) return 'waking';
  return 'idle';
}

/** When the current happy or unsure moment ends (ms since 1970), if one is showing or due. */
export function wilsonMoodUntil(b: WilsonMoodSource, now = Date.now()): number | undefined {
  const s = memory.get(keyOf(b));
  if (!s) return undefined;
  const ends = [s.unsureUntil, s.happyUntil].filter(t => t > now);
  return ends.length ? Math.min(...ends) : undefined;
}

/** wilsonMood for a component: re-renders when a happy or unsure moment is over. */
export function useWilsonMood(b: WilsonMoodSource, opts: { replan?: boolean } = {}): WilsonMood {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const now = Date.now();
  const mood = wilsonMood(b, { now, replan: opts.replan });
  const until = wilsonMoodUntil(b, now);
  useEffect(() => {
    if (!until) return;
    const t = setTimeout(bump, Math.max(0, until - Date.now()) + 30);
    return () => clearTimeout(t);
  }, [until]);
  return mood;
}

// ---------------------------------------------------------------------------
// The voice levels.

type Levels = { subscribe(cb: (l: { mic: number; voice: number }) => void): () => void };
interface LevelSource {
  listening?: boolean;
  speaking?: boolean;
  levels?: unknown;
  runtime?: { audio?: unknown };
}

function levelsOf(b: LevelSource): Levels | undefined {
  const l = b.levels as Partial<Levels> | undefined;
  return l && typeof l.subscribe === 'function' ? (l as Levels) : undefined;
}

/**
 * The level that moves Wilson, 0–1, as an Animated.Value driven natively: the microphone while
 * listening, the voice while speaking (b.levels, from the helper), else 0. Without b.levels it
 * chains onto the helper client's onLevel slot (microphone only). `voice` says whether a voice
 * level arrives at all; without one, leave Wilson's level out while speaking and he talks by himself.
 */
export function useWilsonLevel(b: LevelSource): { level: Animated.Value; voice: boolean } {
  const level = useRef(new Animated.Value(0)).current;
  const state = useRef({ listening: !!b.listening, speaking: !!b.speaking });
  state.current = { listening: !!b.listening, speaking: !!b.speaking };
  const levels = levelsOf(b);
  const audio = b.runtime?.audio as { onLevel?: (v: number) => void } | undefined;
  /** The level last sent to the value (also when it was sent back to rest), so small changes are skipped. */
  const last = useRef(0);

  useEffect(() => {
    const to = (v: number) => {
      const x = clamp(Number.isFinite(v) ? v : 0, 0, 1);
      if (Math.abs(x - last.current) < 0.02) return;
      last.current = x;
      Animated.timing(level, { toValue: x, duration: 90, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    };
    if (levels) {
      const off = levels.subscribe(l => {
        const { listening, speaking } = state.current;
        to(listening ? l.mic : speaking ? l.voice : 0);
      });
      return () => {
        if (typeof off === 'function') off();
      };
    }
    if (!audio || typeof audio !== 'object') return;
    // The helper client has one onLevel slot: chain onto it, and put the one before back.
    const before = audio.onLevel;
    const mine = (v: number) => {
      before?.(v);
      if (state.current.listening) to(v);
    };
    audio.onLevel = mine;
    return () => {
      if (audio.onLevel === mine) audio.onLevel = before;
    };
  }, [levels, audio, level]);

  // Back to rest when neither listening nor speaking.
  const active = !!b.listening || !!b.speaking;
  useEffect(() => {
    if (active) return;
    last.current = 0;
    Animated.timing(level, { toValue: 0, duration: 240, useNativeDriver: true }).start();
  }, [active, level]);

  return { level, voice: !!levels };
}

// ---------------------------------------------------------------------------
// The face: two eyes and a mouth of light, in unit coordinates (the orb is 1 × 1).

/** Where the eyes sit (their centre line) and where the mouth sits, per mood. */
const EYE_Y: Record<WilsonMood, number> = { idle: 0.45, listening: 0.44, thinking: 0.405, speaking: 0.45, happy: 0.445, unsure: 0.45, waking: 0.465 };
const MOUTH_Y = 0.64;
const EYE_DX = 0.12;
/** The speaking mouth: drawn nearly closed (half-height 0.018), the voice opens it up to this many times taller. */
const SPEAK_REST_RY = 0.018;
const SPEAK_OPEN = 3.3;
/** The listening rings: resting size (× his size) and how much a loud voice grows them. */
const RINGS = [
  { base: 1.14, grow: 0.22 },
  { base: 1.32, grow: 0.46 },
];

function eyesOf(mood: WilsonMood, D: number, sw: number, color: string): React.ReactNode {
  const u = (v: number) => v * D;
  const dot = (cx: number, cy: number, rx: number, ry: number, key: string) => (
    <Ellipse key={key} cx={u(cx)} cy={u(cy)} rx={Math.max(1.3, u(rx))} ry={Math.max(1.9, u(ry))} fill={color} />
  );
  const arc = (cx: number, cy: number, w: number, h: number, key: string) => (
    <Path key={key} d={`M ${u(cx - w)} ${u(cy)} Q ${u(cx)} ${u(cy + h)} ${u(cx + w)} ${u(cy)}`} stroke={color} strokeWidth={sw} strokeLinecap="round" fill="none" />
  );
  const y = EYE_Y[mood];
  switch (mood) {
    case 'listening':
      return [dot(0.5 - EYE_DX, y, 0.047, 0.07, 'l'), dot(0.5 + EYE_DX, y, 0.047, 0.07, 'r')];
    case 'thinking':
      // Drawn glancing up and to the right; the glance animation looks across and back.
      return [dot(0.5 - EYE_DX + 0.04, y, 0.034, 0.05, 'l'), dot(0.5 + EYE_DX + 0.04, y, 0.034, 0.05, 'r')];
    case 'happy':
      // Closed, smiling eyes: arcs bowed upwards.
      return [arc(0.5 - EYE_DX, y + 0.02, 0.058, -0.075, 'l'), arc(0.5 + EYE_DX, y + 0.02, 0.058, -0.075, 'r')];
    case 'unsure':
      // One eye open; the other half shut under a tilted line.
      return [
        dot(0.5 - EYE_DX - 0.008, y, 0.04, 0.058, 'l'),
        <Line key="r" x1={u(0.5 + 0.07)} y1={u(y + 0.008)} x2={u(0.5 + 0.18)} y2={u(y - 0.01)} stroke={color} strokeWidth={sw} strokeLinecap="round" />,
      ];
    case 'waking':
      // Sleepy: lower lids only, bowed downwards.
      return [arc(0.5 - EYE_DX, y - 0.02, 0.055, 0.06, 'l'), arc(0.5 + EYE_DX, y - 0.02, 0.055, 0.06, 'r')];
    default:
      return [dot(0.5 - EYE_DX, y, 0.04, 0.058, 'l'), dot(0.5 + EYE_DX, y, 0.04, 0.058, 'r')];
  }
}

function mouthOf(mood: WilsonMood, D: number, sw: number, color: string): React.ReactNode {
  const u = (v: number) => v * D;
  const line = (x1: number, x2: number, y: number) => <Line x1={u(x1)} y1={u(y)} x2={u(x2)} y2={u(y)} stroke={color} strokeWidth={sw} strokeLinecap="round" />;
  switch (mood) {
    case 'listening':
      return <Circle cx={u(0.5)} cy={u(MOUTH_Y)} r={Math.max(1.8, u(0.036))} stroke={color} strokeWidth={sw * 0.85} fill="none" />;
    case 'thinking':
      return line(0.44, 0.58, MOUTH_Y);
    case 'speaking':
      return <Ellipse cx={u(0.5)} cy={u(MOUTH_Y)} rx={Math.max(2.4, u(0.066))} ry={Math.max(0.9, u(SPEAK_REST_RY))} fill={color} />;
    case 'happy':
      return <Path d={`M ${u(0.355)} ${u(0.585)} Q ${u(0.5)} ${u(0.735)} ${u(0.645)} ${u(0.585)}`} stroke={color} strokeWidth={sw * 1.1} strokeLinecap="round" fill="none" />;
    case 'unsure':
      return <Path d={`M ${u(0.39)} ${u(0.648)} Q ${u(0.4425)} ${u(0.6)} ${u(0.495)} ${u(0.648)} T ${u(0.6)} ${u(0.648)}`} stroke={color} strokeWidth={sw} strokeLinecap="round" fill="none" />;
    case 'waking':
      return line(0.445, 0.555, MOUTH_Y - 0.005);
    default:
      return <Path d={`M ${u(0.39)} ${u(0.6)} Q ${u(0.5)} ${u(0.69)} ${u(0.61)} ${u(0.6)}`} stroke={color} strokeWidth={sw} strokeLinecap="round" fill="none" />;
  }
}

/**
 * A zero-size view at (x, y) that carries a transform for its children, so they scale and turn
 * about that point. On macOS a layer turns about its top-left corner and RCTView re-centres
 * transforms only when it redraws; a zero-size layer has one point to turn about (see TalkScreen's
 * Flipped and Nav's Magnified).
 */
export function Pivot({ x, y, style, children }: { x: number; y: number; style?: Animated.WithAnimatedValue<StyleProp<ViewStyle>>; children: React.ReactNode }) {
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: x, top: y, width: 0, height: 0, transformOrigin: 'center' }, style]}>
      {children}
    </Animated.View>
  );
}

/** A D × D box placed so that (ax, ay) of it sits on its Pivot's point. */
function Around({ D, ax, ay, children }: { D: number; ax: number; ay: number; children: React.ReactNode }) {
  return <View style={{ position: 'absolute', left: -ax, top: -ay, width: D, height: D }}>{children}</View>;
}

// ---------------------------------------------------------------------------
// Wilson.

/** Values a host animates to make Wilson feel like liquid glass while he is dragged (Buddy.tsx). */
export interface WilsonMotion {
  /** Stretch along the direction of travel: 0 at rest, up to ~0.3 moving fast; below 0 squashes (the wobble on release). */
  stretch: Animated.Value;
  /** Direction of travel, radians, screen coordinates (atan2 of the velocity). */
  angle: Animated.Value;
  /** 0 at rest, 1 moving fast: the glare, rim light and colour fringes come up with it. */
  moving: Animated.Value;
  /** 0 resting, 1 picked up: he grows a little. */
  lift: Animated.Value;
}

export function createWilsonMotion(): WilsonMotion {
  return { stretch: new Animated.Value(0), angle: new Animated.Value(0), moving: new Animated.Value(0), lift: new Animated.Value(0) };
}

export interface WilsonProps {
  /** 120 (welcome, translator), 48 (timeline), 32 (inline), or any size. Default 48. */
  size?: number;
  mood: WilsonMood;
  /**
   * 0–1: the microphone level while listening, the voice's level while speaking. A number (he
   * eases to it) or an Animated.Value driven with the native driver (useWilsonLevel). Left out
   * while speaking, his mouth moves by itself; left out while listening, his rings pulse softly.
   */
  level?: number | Animated.Value;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  /** The liquid-glass drag (FloatingBuddy): stretch, direction, glare and lift. */
  motion?: WilsonMotion;
  /** Held up: a deeper shadow under him. */
  lifted?: boolean;
  /** Breathing and blinking. Default true; turn off where many small Wilsons sit in a list. */
  alive?: boolean;
  /** Inside a control that speaks for him (the floating Wilson's button): not an element of his own for VoiceOver. */
  decorative?: boolean;
}

/** Wilson: a liquid-glass orb with a face of light. */
export const Wilson = React.memo(function Wilson({ size = WILSON_SIZE.timeline, mood, level, onPress, style, accessibilityLabel, motion, lifted, alive = true, decorative }: WilsonProps) {
  const D = Math.max(16, Math.round(size));
  const reduce = useReduceMotion();
  const look = wilsonTint(mood);

  // --- Animated values (all native-driven).
  const breath = useRef(new Animated.Value(0)).current;
  const blink = useRef(new Animated.Value(1)).current;
  const glance = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  const pop = useRef(new Animated.Value(0)).current;
  const face = useRef(new Animated.Value(1)).current;
  const own = useRef(new Animated.Value(typeof level === 'number' ? clamp(level, 0, 1) : 0)).current;
  const one = useRef(new Animated.Value(1)).current;

  const levelNumber = typeof level === 'number' ? clamp(level, 0, 1) : undefined;
  useEffect(() => {
    if (levelNumber !== undefined) Animated.timing(own, { toValue: levelNumber, duration: 90, useNativeDriver: true }).start();
  }, [levelNumber, own]);
  const hasLevel = level !== undefined;
  const lv: Animated.Value = typeof level === 'object' && level ? level : hasLevel ? own : pulse;

  // Breathing: calm moods only, scale 1 → 1.02 over 4 s (slower while waking).
  const calm = mood === 'idle' || mood === 'waking' || mood === 'happy' || mood === 'unsure';
  useEffect(() => {
    breath.stopAnimation();
    if (reduce || !alive || !calm) {
      breath.setValue(0);
      return;
    }
    const half = mood === 'waking' ? 3000 : 2000;
    const ease = Easing.inOut(Easing.sin);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, { toValue: 1, duration: half, easing: ease, useNativeDriver: true }),
        Animated.timing(breath, { toValue: 0, duration: half, easing: ease, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [mood, calm, reduce, alive, breath]);

  // Blinking every 4–6 s while his eyes are open dots.
  const blinks = alive && (mood === 'idle' || mood === 'listening' || mood === 'speaking' || mood === 'thinking');
  useEffect(() => {
    if (!blinks) {
      blink.setValue(1);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = () => {
      timer = setTimeout(() => {
        if (!live) return;
        Animated.sequence([
          Animated.timing(blink, { toValue: 0.08, duration: 70, easing: Easing.in(Easing.quad), useNativeDriver: true }),
          Animated.timing(blink, { toValue: 1, duration: 130, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        ]).start(() => {
          if (live) next();
        });
      }, 4000 + Math.random() * 2000);
    };
    next();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      blink.stopAnimation();
      blink.setValue(1);
    };
  }, [blinks, blink]);

  // Thinking: the eyes glance across and back.
  useEffect(() => {
    glance.stopAnimation();
    glance.setValue(0);
    if (mood !== 'thinking' || reduce || !alive) return;
    const ease = Easing.inOut(Easing.quad);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(700),
        Animated.timing(glance, { toValue: 1, duration: 320, easing: ease, useNativeDriver: true }),
        Animated.delay(900),
        Animated.timing(glance, { toValue: 0, duration: 320, easing: ease, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [mood, reduce, alive, glance]);

  // No level given: listening pulses softly, speaking chatters by itself.
  useEffect(() => {
    pulse.stopAnimation();
    pulse.setValue(0);
    if (hasLevel || reduce) return;
    let steps: Animated.CompositeAnimation[] = [];
    if (mood === 'listening') {
      const ease = Easing.inOut(Easing.sin);
      steps = [
        Animated.timing(pulse, { toValue: 0.55, duration: 900, easing: ease, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.1, duration: 900, easing: ease, useNativeDriver: true }),
      ];
    } else if (mood === 'speaking') {
      steps = [0.85, 0.25, 0.7, 0.15, 0.95, 0.35, 0.6, 0.1].map((v, i) => Animated.timing(pulse, { toValue: v, duration: 100 + (i % 3) * 35, useNativeDriver: true }));
    } else return;
    const loop = Animated.loop(Animated.sequence(steps));
    loop.start();
    return () => loop.stop();
  }, [mood, hasLevel, reduce, pulse]);

  // Happy: a little hop. Every mood change: the new face comes up quickly.
  const lastMood = useRef(mood);
  useEffect(() => {
    if (lastMood.current === mood) return;
    lastMood.current = mood;
    if (reduce) {
      face.setValue(1);
      return;
    }
    face.setValue(0.2);
    Animated.timing(face, { toValue: 1, duration: 160, useNativeDriver: true }).start();
    if (mood === 'happy') {
      pop.setValue(0);
      Animated.sequence([
        Animated.timing(pop, { toValue: 1, duration: 140, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.spring(pop, { toValue: 0, stiffness: 260, damping: 12, mass: 1, useNativeDriver: true }),
      ]).start();
    }
  }, [mood, reduce, face, pop]);

  // --- Transforms, built once per input so the native driver keeps running across re-renders.
  const body = useMemo(() => {
    const calmScale = Animated.multiply(
      breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1.02] }),
      pop.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] }),
    );
    if (!motion) return [{ scale: calmScale }];
    const scale = Animated.multiply(calmScale, motion.lift.interpolate({ inputRange: [0, 1], outputRange: [1, 1.07] }));
    // Stretch along the direction of travel: turn to it, scale, turn back (so the face isn't turned).
    // A little more than area-preserving across, so he bulges a touch as he flies (the lens grows).
    const turn = motion.angle.interpolate({ inputRange: [-Math.PI, Math.PI], outputRange: ['-180deg', '180deg'] });
    const back = motion.angle.interpolate({ inputRange: [-Math.PI, Math.PI], outputRange: ['180deg', '-180deg'] });
    const along = motion.stretch.interpolate({ inputRange: [-0.4, 0, 0.4], outputRange: [0.64, 1, 1.38], extrapolate: 'clamp' });
    const across = motion.stretch.interpolate({ inputRange: [-0.4, -0.2, 0, 0.2, 0.4], outputRange: [1.36, 1.15, 1, 0.88, 0.8], extrapolate: 'clamp' });
    return [{ rotate: turn }, { scaleX: along }, { scaleY: across }, { rotate: back }, { scale }];
  }, [breath, pop, motion]);

  const glare = useMemo(
    () => (motion ? { turn: motion.angle.interpolate({ inputRange: [-Math.PI, Math.PI], outputRange: ['-180deg', '180deg'] }) } : undefined),
    [motion],
  );

  // Every transform rests at identity: the rings are laid out at their resting size and the level
  // only grows them. (AppKit can drop a layer's transform a turn after the view mounts; a ring
  // resting on a transform would then hide behind him until the microphone moved it again.)
  const rings = useMemo(
    () =>
      RINGS.map(r => ({
        size: r.base,
        scale: lv.interpolate({ inputRange: [0, 1], outputRange: [1, (r.base + r.grow) / r.base], extrapolate: 'clamp' }),
        // Seen at rest too (the spec's listening halo): on a dark map or the home they had vanished.
        opacity: lv.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1], extrapolate: 'clamp' }),
      })),
    [lv],
  );

  const eyes = useMemo(
    () => [{ translateX: glance.interpolate({ inputRange: [0, 1], outputRange: [0, -0.08 * D] }) }, { scaleY: blink }],
    [glance, blink, D],
  );

  const mouth = useMemo(() => {
    if (mood === 'speaking') {
      // Drawn nearly closed; the voice opens it (taller, a little narrower).
      return [
        { scaleX: lv.interpolate({ inputRange: [0, 1], outputRange: [1, 0.84], extrapolate: 'clamp' }) },
        { scaleY: lv.interpolate({ inputRange: [0, 1], outputRange: [1, SPEAK_OPEN], extrapolate: 'clamp' }) },
      ];
    }
    if (mood === 'listening') {
      const s = lv.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35], extrapolate: 'clamp' });
      return [{ scaleX: s }, { scaleY: s }];
    }
    return [{ scaleX: one }, { scaleY: one }];
  }, [mood, lv, one]);

  const faceOpacity = useMemo(() => (mood === 'waking' ? Animated.multiply(face, 0.7) : face), [mood, face]);

  // --- The drawing.
  const sw = Math.max(1.2, D * 0.027);
  const light = look.face;
  const eyeY = EYE_Y[mood] * D;
  const mouthY = MOUTH_Y * D;
  // A soft glow round the face of light, only where he is big (a shape-following shadow costs an
  // offscreen pass each frame he breathes; at 64 px and below it can't be seen anyway).
  const glow: ViewStyle | undefined = D >= 80 ? { shadowColor: light, shadowOpacity: 0.55, shadowRadius: Math.max(1.5, D * 0.03), shadowOffset: { width: 0, height: 0 } } : undefined;
  const half = D / 2;

  const content = (
    <Pivot x={half} y={half} style={{ transform: body }}>
      <Around D={D} ax={half} ay={half}>
        {mood === 'listening' &&
          rings.map((r, i) => {
            const d = Math.round(D * r.size);
            return (
              <Pivot key={i} x={half} y={half} style={{ opacity: r.opacity, transform: [{ scale: r.scale }] }}>
                <View style={[styles.ring, { left: -d / 2, top: -d / 2, width: d, height: d, borderRadius: d / 2, backgroundColor: white(i ? 0.05 : 0.09), borderColor: white(i ? 0.15 : 0.26) }]} />
              </Pivot>
            );
          })}
        <Glass
          kind="orb"
          radius={half}
          tint={look.tint}
          wash={look.wash}
          style={[
            { width: D, height: D, shadowRadius: Math.max(5, D * 0.17), shadowOffset: { width: 0, height: Math.max(2, D * 0.09) } },
            lifted && { shadowOpacity: 0.5, shadowRadius: D * 0.4, shadowOffset: { width: 0, height: D * 0.24 } },
          ]}
        />
        <View pointerEvents="none" style={[styles.box, { width: D, height: D, opacity: mood === 'waking' ? 0.55 : 1 }]}>
          <Lens D={D} />
        </View>
        {motion && glare && (
          <Animated.View pointerEvents="none" style={[styles.box, { width: D, height: D, opacity: motion.moving }]}>
            <Pivot x={half} y={half} style={{ transform: [{ rotate: glare.turn }] }}>
              <Around D={D} ax={half} ay={half}>
                <DragGlare D={D} />
              </Around>
            </Pivot>
          </Animated.View>
        )}
        <Animated.View pointerEvents="none" style={[styles.box, { width: D, height: D, opacity: faceOpacity }, glow]}>
          <Pivot x={half} y={eyeY} style={{ transform: eyes }}>
            <Around D={D} ax={half} ay={eyeY}>
              <Svg key={`e-${mood}-${D}`} width={D} height={D}>
                {eyesOf(mood, D, sw, light)}
              </Svg>
            </Around>
          </Pivot>
          <Pivot x={half} y={mouthY} style={{ transform: mouth }}>
            <Around D={D} ax={half} ay={mouthY}>
              <Svg key={`m-${mood}-${D}`} width={D} height={D}>
                {mouthOf(mood, D, sw, light)}
              </Svg>
            </Around>
          </Pivot>
        </Animated.View>
      </Around>
    </Pivot>
  );

  if (onPress) {
    const slop = Math.max(0, Math.ceil((dusk.size.touch - D) / 2));
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? 'Talk to Wilson'}
        accessibilityValue={{ text: WILSON_MOOD_LABEL[mood] }}
        onPress={onPress}
        {...axPress(onPress)}
        hitSlop={slop}
        style={[{ width: D, height: D }, style]}>
        <View pointerEvents="none" style={{ width: D, height: D }}>
          {content}
        </View>
      </Pressable>
    );
  }
  return (
    <View
      pointerEvents="none"
      accessible={!decorative}
      accessibilityRole={decorative ? undefined : 'image'}
      accessibilityLabel={decorative ? undefined : accessibilityLabel ?? `Wilson, ${WILSON_MOOD_LABEL[mood].toLowerCase()}`}
      style={[{ width: D, height: D }, style]}>
      {content}
    </View>
  );
});

/**
 * What makes the orb read as a sphere of glass anywhere, after the spec's orbs: the edge darkens a
 * little where the glass bends the light away, the light it gathers pools at the bottom, and a thin
 * rim of light runs round it, brightest at the top left and the bottom right. Apple's Liquid Glass
 * lights its own edge, but over a dark, even backdrop (the home, the Chat dock) that barely shows
 * and he looked like a flat grey disc. White light only: he has no colour of his own. Drawn once at
 * his size (react-native-svg on macOS keeps its first drawing).
 */
function Lens({ D }: { D: number }) {
  const id = useId().replace(/:/g, '');
  const r = D / 2;
  const w = Math.max(0.8, D * 0.011);
  return (
    <Svg key={`l${D}`} width={D} height={D}>
      <Defs>
        <RadialGradient id={`${id}edge`} cx="46%" cy="40%" r="60%">
          <Stop offset="0.72" stopColor="#000" stopOpacity={0} />
          <Stop offset="1" stopColor="#000" stopOpacity={0.2} />
        </RadialGradient>
        <RadialGradient id={`${id}pool`} cx="52%" cy="100%" r="55%">
          <Stop offset="0" stopColor={dusk.color.white} stopOpacity={0.2} />
          <Stop offset="1" stopColor={dusk.color.white} stopOpacity={0} />
        </RadialGradient>
        <SvgLinearGradient id={`${id}rim`} x1="0.1" y1="0" x2="0.9" y2="1">
          <Stop offset="0" stopColor={dusk.color.white} stopOpacity={0.55} />
          <Stop offset="0.45" stopColor={dusk.color.white} stopOpacity={0.1} />
          <Stop offset="1" stopColor={dusk.color.white} stopOpacity={0.45} />
        </SvgLinearGradient>
      </Defs>
      <Circle cx={r} cy={r} r={r} fill={`url(#${id}edge)`} />
      <Circle cx={r} cy={r} r={r} fill={`url(#${id}pool)`} />
      <Circle cx={r} cy={r} r={r - w / 2} fill="none" stroke={`url(#${id}rim)`} strokeWidth={w} />
    </Svg>
  );
}

/**
 * The light on moving glass, after liquid-glass-studio's fragment shader: a Fresnel rim that
 * brightens toward the leading edge (+x here; the layer is turned to the direction of travel), a
 * weaker glint on the trailing edge, colour fringes where the edge disperses light (cool ahead,
 * warm behind), and a sheen on the face meeting the light. Drawn once at its size.
 */
function DragGlare({ D }: { D: number }) {
  const id = useId().replace(/:/g, '');
  const r = D / 2;
  return (
    <Svg key={`g${D}`} width={D} height={D}>
      <Defs>
        <SvgLinearGradient id={`${id}rim`} x1="0" y1="0.5" x2="1" y2="0.5">
          <Stop offset="0" stopColor={dusk.color.white} stopOpacity={0.55} />
          <Stop offset="0.42" stopColor={dusk.color.white} stopOpacity={0.1} />
          <Stop offset="0.7" stopColor={dusk.color.white} stopOpacity={0.3} />
          <Stop offset="1" stopColor={dusk.color.white} stopOpacity={1} />
        </SvgLinearGradient>
        <SvgLinearGradient id={`${id}chroma`} x1="0" y1="0.5" x2="1" y2="0.5">
          <Stop offset="0" stopColor={dusk.color.fringeWarm} stopOpacity={0.6} />
          <Stop offset="0.16" stopColor={dusk.color.fringePink} stopOpacity={0.25} />
          <Stop offset="0.32" stopColor={dusk.color.fringePink} stopOpacity={0} />
          <Stop offset="0.7" stopColor={dusk.color.fringeCool} stopOpacity={0} />
          <Stop offset="1" stopColor={dusk.color.fringeCool} stopOpacity={0.7} />
        </SvgLinearGradient>
        <RadialGradient id={`${id}sheen`} cx="76%" cy="36%" r="42%">
          <Stop offset="0" stopColor={dusk.color.white} stopOpacity={0.32} />
          <Stop offset="1" stopColor={dusk.color.white} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx={r} cy={r} r={r} fill={`url(#${id}sheen)`} />
      <Circle cx={r} cy={r} r={Math.max(1, r - 2.4)} fill="none" stroke={`url(#${id}chroma)`} strokeWidth={Math.max(1.4, D * 0.03)} />
      <Circle cx={r} cy={r} r={Math.max(1, r - 0.8)} fill="none" stroke={`url(#${id}rim)`} strokeWidth={Math.max(1.2, D * 0.022)} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  box: { position: 'absolute', left: 0, top: 0 },
  ring: { position: 'absolute', borderWidth: 1 },
});
