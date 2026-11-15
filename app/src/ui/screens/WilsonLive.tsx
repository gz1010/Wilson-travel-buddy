import React, { useEffect, useRef, useState } from 'react';
import { Animated, View, type StyleProp, type ViewStyle } from 'react-native';
import { NOT_IN_GUIDE } from '../../core/prompts';
import { Glass } from '../dusk/Glass';
import { useMicLevel } from '../dusk/VoiceMic';
import { white } from '../dusk/tokens';
import type { Buddy, ChatLine } from '../useBuddy';

// Wilson on Now, Chat, Translate and Place: the one place these screens reach his face and mood
// (dusk/Wilson.tsx) and his voice (useBuddy's levels and wake word). Both are read defensively, so
// the screens keep working while either side changes: without the face module a plain glass orb
// with two eyes stands in, and without useBuddy's levels the microphone level comes from the
// helper's onLevel (useMicLevel).

export type WilsonMood = 'idle' | 'listening' | 'thinking' | 'speaking' | 'happy' | 'unsure' | 'waking';

const MOODS: readonly WilsonMood[] = ['idle', 'listening', 'thinking', 'speaking', 'happy', 'unsure', 'waking'];
const isMood = (m: unknown): m is WilsonMood => typeof m === 'string' && (MOODS as readonly string[]).includes(m);

export interface WilsonFaceProps {
  size: number;
  mood: WilsonMood;
  /** 0-1: the microphone while listening, the voice while speaking; a number or a natively driven value. */
  level?: number | Animated.Value;
  /** Breathing and blinking (off for the many small Wilsons in a conversation). */
  alive?: boolean;
  /** Inside a control that speaks for him: no VoiceOver element of his own. */
  decorative?: boolean;
  /** Held up (dragged): a deeper shadow under him. */
  lifted?: boolean;
  /** The liquid-glass drag (stretch, direction, glare, lift): useWilsonMotion. */
  motion?: WilsonMotion;
  style?: StyleProp<ViewStyle>;
}

/** The values that make him feel like liquid glass while he is dragged (dusk/Wilson.tsx's WilsonMotion). */
export interface WilsonMotion {
  stretch: Animated.Value;
  angle: Animated.Value;
  moving: Animated.Value;
  lift: Animated.Value;
}

interface WilsonKit {
  Wilson?: React.ComponentType<WilsonFaceProps>;
  useWilsonMood?: (b: Buddy, opts?: { replan?: boolean }) => unknown;
  useWilsonLevel?: (b: Buddy) => { level: Animated.Value; voice: boolean };
  isDecline?: (text: string) => boolean;
  createWilsonMotion?: () => WilsonMotion;
}

function loadKit(): WilsonKit {
  // In a try block Metro treats the module as optional (as mapHtml.ts does for buddy-aerial).
  try {
    return require('../dusk/Wilson') as WilsonKit;
  } catch {
    return {};
  }
}
const kit = loadKit();

/** Stand-in face: an orb of glass with two eyes and a mouth of light. */
function PlainWilson({ size, mood, style }: WilsonFaceProps) {
  const eye = Math.max(3, Math.round(size * 0.08));
  const closed = mood === 'happy' || mood === 'waking';
  const mouthH = mood === 'speaking' ? Math.max(3, size * 0.1) : Math.max(2, size * 0.04);
  return (
    <Glass kind="orb" radius={size / 2} blur={false} style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}>
      <View style={{ flexDirection: 'row', gap: Math.round(size * 0.16), marginTop: -Math.round(size * 0.04) }}>
        {[0, 1].map(i => (
          <View key={i} style={{ width: eye, height: closed ? Math.max(2, eye / 2) : Math.round(eye * 1.25), borderRadius: eye, backgroundColor: white(0.95) }} />
        ))}
      </View>
      <View style={{ marginTop: Math.round(size * 0.1), width: Math.round(size * (mood === 'unsure' || mood === 'thinking' ? 0.16 : 0.26)), height: mouthH, borderRadius: size, backgroundColor: white(0.9) }} />
    </Glass>
  );
}

/** His drag motion values, made once; undefined without dusk/Wilson.tsx's (he then just moves). */
export function useWilsonMotion(): WilsonMotion | undefined {
  const [m] = useState(() => (typeof kit.createWilsonMotion === 'function' ? kit.createWilsonMotion() : undefined));
  return m;
}

/** Wilson's face (dusk/Wilson.tsx), or the stand-in. Presentational: callers wrap him in their own press handling. */
export const WilsonFace: React.ComponentType<WilsonFaceProps> = kit.Wilson ?? PlainWilson;

/** A declining answer: the guide doesn't cover the question ("That isn't in my guide…"). */
export function isDeclined(text: string | undefined): boolean {
  if (!text) return false;
  return typeof kit.isDecline === 'function' ? kit.isDecline(text) : text.trim() === NOT_IN_GUIDE;
}

/** What he says, on screen, when the guide declined a question. */
export const UNSURE_LINE = "My guide doesn't cover that one. Want something nearby instead?";
/** What "something nearby" asks: Chat's own suggestion, which the companion answers with right-now picks. */
export const NEARBY_QUESTION = 'What should I do right now?';

const lastBuddyLine = (chat: ChatLine[]) => {
  for (let i = chat.length - 1; i >= 0; i--) if (chat[i].who === 'buddy') return chat[i];
  return undefined;
};

/** The mood without dusk/Wilson.tsx: listening, speaking, thinking, unsure after a declined answer, else idle. */
function plainMood(b: Buddy): WilsonMood {
  if (b.listening) return 'listening';
  if (b.speaking) return 'speaking';
  if (b.busy) return 'thinking';
  const last = lastBuddyLine(b.chat);
  return last && !last.pending && isDeclined(last.text) ? 'unsure' : 'idle';
}

/** His mood from the app state (a hook: it re-renders when a happy or unsure moment ends). Chosen once, so the hooks never change order. */
export const useMood: (b: Buddy, opts?: { replan?: boolean }) => WilsonMood =
  typeof kit.useWilsonMood === 'function'
    ? (b, opts) => {
        const m = kit.useWilsonMood!(b, opts);
        return isMood(m) ? m : plainMood(b);
      }
    : b => plainMood(b);

// --- The voice side (useBuddy), read loosely.

export interface WilsonLevels {
  subscribe(cb: (l: { mic: number; voice: number }) => void): () => void;
}
export interface WilsonWake {
  enabled: boolean;
  setEnabled(v: boolean): void;
  /** True while he listens for his name. */
  listening: boolean;
  /** False without the helper's microphone or with a helper build that has no wake word. */
  available?: boolean;
  /** Keeps the wake word off until the returned release() (Translate, while it is open). */
  hold?: (reason: string) => () => void;
}

export function levelsOf(b: Buddy): WilsonLevels | undefined {
  const l = (b as unknown as { levels?: Partial<WilsonLevels> }).levels;
  return l && typeof l.subscribe === 'function' ? (l as WilsonLevels) : undefined;
}

export function wakeOf(b: Buddy): WilsonWake | undefined {
  const w = (b as unknown as { wake?: Partial<WilsonWake> }).wake;
  return w && typeof w.setEnabled === 'function' && typeof w.enabled === 'boolean' ? (w as WilsonWake) : undefined;
}

export interface WilsonLevel {
  /** 0-1, natively driven: the microphone while he listens, his voice while he speaks. */
  level: Animated.Value;
  /** Whether a voice level arrives at all (without one his mouth moves by itself). */
  voice: boolean;
}

/** One per screen: the level his face follows. */
export const useLevel: (b: Buddy) => WilsonLevel =
  typeof kit.useWilsonLevel === 'function'
    ? b => kit.useWilsonLevel!(b)
    : b => {
        const mic = useMicLevel(b.runtime.audio, b.listening, b.partial);
        return { level: mic.value, voice: false };
      };

/** The level to give his face in this mood: the microphone while listening, the voice while speaking (when there is one). */
export const levelFor = (mood: WilsonMood, l: WilsonLevel): Animated.Value | undefined => (mood === 'listening' || (mood === 'speaking' && l.voice) ? l.level : undefined);

/**
 * His voice's level while `active` (Translate speaks its translations itself, outside useBuddy's
 * speaking state), from useBuddy's levels; undefined when there are none.
 */
export function useVoiceLevel(b: Buddy, active: boolean): Animated.Value | undefined {
  const value = useRef(new Animated.Value(0)).current;
  const levels = levelsOf(b);
  const on = useRef(active);
  on.current = active;
  useEffect(() => {
    if (!levels) return undefined;
    let last = -1;
    const off = levels.subscribe(l => {
      const v = on.current && Number.isFinite(l.voice) ? Math.max(0, Math.min(1, l.voice)) : 0;
      if (Math.abs(v - last) < 0.02) return;
      last = v;
      Animated.timing(value, { toValue: v, duration: 90, useNativeDriver: true }).start();
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, [levels, value]);
  useEffect(() => {
    if (!active) value.setValue(0);
  }, [active, value]);
  return levels ? value : undefined;
}
