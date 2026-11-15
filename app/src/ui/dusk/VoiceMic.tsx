import React, { useEffect, useId, useMemo, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';
import type { AudioClient } from '../../core/types';
import { axPress, Glass } from './Glass';
import { MicIcon } from './Icons';
import { LIGHTS, MOOD_RGB, moodColor, type Mood } from './LiquidBackground';
import { useReduceMotion } from './motion';
import { dusk } from './tokens';

// The Chat tab's microphone: a slim glass ring (64 px) holding a small liquid blob. At rest the
// blob breathes and drifts; while listening it takes the "you" blue, flows with the microphone
// level and the ring shows a live waveform; while thinking it turns violet and spreads; while the
// buddy speaks it turns warm amber and pulses with a speaking rhythm. Every animation runs on the
// native driver (transforms and opacity only), so a busy JS thread (the reply streaming in)
// never stutters it. Reduce motion keeps it still and shows the state by colour alone.

export type MicState = Mood;

/** The orbit samples: a circle, as the piecewise-linear path native interpolation can follow. */
const STEPS = Array.from({ length: 17 }, (_, i) => i / 16);
/** Orbit period of each of the three blob lobes, in ms (unrelated, so the shape never repeats). */
const PERIODS = [5300, 7100, 8900];
/** A speaking rhythm: syllable-like peaks, looped. */
const BEATS = [0.55, 0.2, 0.85, 0.35, 0.7, 0.15, 0.95, 0.3, 0.6, 0.1];

const LABELS: Record<MicState, string> = {
  idle: 'Talk to your buddy',
  listening: 'Stop listening and send',
  thinking: 'Talk to your buddy',
  speaking: 'Interrupt and talk',
};

/**
 * Each lobe's colour and opacity per state: at rest a small drop of the Chat sky (its blue, pink
 * and warm lights), the mood's colour when active.
 */
const WHITE: [number, number, number] = [255, 255, 255];

function lobeColors(state: MicState): { rgb: [number, number, number]; a: number }[] {
  const direction = MOOD_RGB.idle;
  const you = MOOD_RGB.listening;
  const violet = MOOD_RGB.thinking;
  const amber = MOOD_RGB.speaking;
  const whiteRgb = WHITE;
  switch (state) {
    case 'listening':
      return [{ rgb: you, a: 0.85 }, { rgb: direction, a: 0.55 }, { rgb: whiteRgb, a: 0.4 }];
    case 'thinking':
      return [{ rgb: violet, a: 0.75 }, { rgb: you, a: 0.45 }, { rgb: whiteRgb, a: 0.3 }];
    case 'speaking':
      return [{ rgb: amber, a: 0.8 }, { rgb: violet, a: 0.45 }, { rgb: whiteRgb, a: 0.35 }];
    default:
      return [{ rgb: LIGHTS[0], a: 0.5 }, { rgb: LIGHTS[1], a: 0.36 }, { rgb: LIGHTS[2], a: 0.36 }];
  }
}

interface Props {
  state: MicState;
  /** The microphone level, 0-1 (useMicLevel().value). */
  level: Animated.Value;
  onPress: () => void;
  /** The ring's diameter. */
  size?: number;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

export function VoiceMic({ state, level, onPress, size = 64, accessibilityLabel, style }: Props) {
  const reduce = useReduceMotion();
  const orbit = useRef(PERIODS.map(() => new Animated.Value(0))).current;
  const breath = useRef(new Animated.Value(0.5)).current;
  const talk = useRef(new Animated.Value(0)).current;
  const spread = useRef(new Animated.Value(1)).current;
  const glow = useRef(new Animated.Value(0)).current;

  // The lobes' orbits and the breath: always running (they are what makes it feel alive).
  useEffect(() => {
    if (reduce) {
      orbit.forEach(o => o.setValue(0));
      breath.setValue(0.5);
      return;
    }
    const loops = [
      ...orbit.map((o, i) => Animated.loop(Animated.timing(o, { toValue: 1, duration: PERIODS[i], easing: Easing.linear, useNativeDriver: true }))),
      Animated.loop(
        Animated.sequence([
          Animated.timing(breath, { toValue: 1, duration: 2400, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          Animated.timing(breath, { toValue: 0, duration: 2400, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        ]),
      ),
    ];
    loops.forEach(l => l.start());
    return () => loops.forEach(l => l.stop());
  }, [reduce, orbit, breath]);

  // How far the lobes wander and how much the halo glows, per state.
  useEffect(() => {
    const [toSpread, toGlow] = state === 'listening' ? [1.25, 1] : state === 'thinking' ? [1.6, 0.6] : state === 'speaking' ? [1.2, 0.85] : [1, 0];
    if (reduce) {
      spread.setValue(toSpread);
      glow.setValue(toGlow);
      return;
    }
    const a = Animated.parallel([
      Animated.timing(spread, { toValue: toSpread, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(glow, { toValue: toGlow, duration: 400, useNativeDriver: true }),
    ]);
    a.start();
    return () => a.stop();
  }, [state, reduce, spread, glow]);

  // The speaking rhythm (the microphone is muted while the buddy speaks, so it has no level).
  useEffect(() => {
    if (state !== 'speaking' || reduce) {
      talk.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence(BEATS.map((b, i) => Animated.timing(talk, { toValue: b, duration: 110 + (i % 3) * 45, useNativeDriver: true }))),
    );
    loop.start();
    return () => {
      loop.stop();
      talk.setValue(0);
    };
  }, [state, reduce, talk]);

  // 0-1: the microphone level while listening, the rhythm while speaking.
  const energy = useMemo(
    () => Animated.add(level, talk).interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' }),
    [level, talk],
  );

  // The animated styles, built once per size: the screen re-renders on every streamed word, and
  // new animated nodes each time would detach and re-attach them on the native side.
  const anim = useMemo(() => {
    const lobe = Math.round(size * 0.56);
    const amp = size * 0.1;
    const halo = Math.round(size * 1.7);
    return {
      lobe,
      halo,
      haloStyle: {
        left: (size - halo) / 2,
        top: (size - halo) / 2,
        width: halo,
        height: halo,
        opacity: Animated.add(
          glow.interpolate({ inputRange: [0, 1], outputRange: [0, 0.75] }),
          breath.interpolate({ inputRange: [0, 1], outputRange: [0.18, 0.32] }),
        ),
        transform: [
          {
            scale: Animated.add(
              breath.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1.02] }),
              energy.interpolate({ inputRange: [0, 1], outputRange: [0, 0.22] }),
            ),
          },
        ],
      },
      lobeStyles: orbit.map((o, i) => {
        const phase = (i * 2 * Math.PI) / 3;
        const dir = i % 2 ? -1 : 1;
        const x = o.interpolate({ inputRange: STEPS, outputRange: STEPS.map(t => Math.cos(2 * Math.PI * t * dir + phase) * amp) });
        const y = o.interpolate({ inputRange: STEPS, outputRange: STEPS.map(t => Math.sin(2 * Math.PI * t * dir + phase) * amp * 0.8) });
        const swell = breath.interpolate({ inputRange: [0, 1], outputRange: i === 1 ? [1.06, 0.9] : [0.9, 1.06] });
        return {
          left: (size - lobe) / 2,
          top: (size - lobe) / 2,
          width: lobe,
          height: lobe,
          transform: [
            { translateX: Animated.multiply(x, spread) },
            { translateY: Animated.multiply(y, spread) },
            { scale: Animated.multiply(swell, energy.interpolate({ inputRange: [0, 1], outputRange: [1, 1.45 - i * 0.08] })) },
          ],
        };
      }),
    };
  }, [size, orbit, breath, spread, glow, energy]);

  const colors = lobeColors(state);
  const label = accessibilityLabel ?? LABELS[state];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      {...axPress(onPress)}
      style={({ pressed }) => [{ width: size, height: size, opacity: pressed ? 0.88 : 1 }, style]}>
      {/* The halo: a soft ring of the mood's light around the glass, swelling with the voice. */}
      <Animated.View pointerEvents="none" style={[styles.abs, anim.haloStyle]}>
        <SoftDisc size={anim.halo} rgb={MOOD_RGB[state]} peak={0.55} hole={0.5} />
      </Animated.View>

      <Glass kind="clear" radius={size / 2} tint={state === 'idle' ? undefined : moodColor(state, 0.2)} style={{ width: size, height: size }}>
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.clip, { borderRadius: size / 2 }]}>
          {colors.map((c, i) => (
            <Animated.View key={i} style={[styles.abs, anim.lobeStyles[i]]}>
              <SoftDisc size={anim.lobe} rgb={c.rgb} peak={c.a} />
            </Animated.View>
          ))}
        </View>
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
          {state === 'idle' ? (
            <MicIcon size={Math.round(size * 0.33)} strokeWidth={1.6} color={dusk.color.white} />
          ) : state === 'thinking' ? (
            <Dots size={size} reduce={reduce} />
          ) : (
            <Bars size={size} energy={energy} />
          )}
        </View>
      </Glass>
    </Pressable>
  );
}

/** A soft round glow (radial gradient), optionally hollow in the middle (`hole`, 0-1 of the radius). */
const SoftDisc = React.memo(function SoftDisc({ size, rgb, peak, hole = 0 }: { size: number; rgb: [number, number, number]; peak: number; hole?: number }) {
  const id = `vm${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const color = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  // [offset, opacity]: a filled glow, or a ring of light with a clear middle.
  const stops: [number, number][] =
    hole > 0
      ? [[0, 0], [hole, 0], [Math.min(0.95, hole + 0.14), peak], [1, 0]]
      : [[0, peak], [0.45, peak * 0.8], [1, 0]];
  return (
    <Svg key={size} width={size} height={size}>
      <Defs>
        <RadialGradient id={id} cx="50%" cy="50%" r="50%">
          {stops.map(([offset, opacity]) => (
            <Stop key={offset} offset={offset} stopColor={color} stopOpacity={opacity} />
          ))}
        </RadialGradient>
      </Defs>
      <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${id})`} />
    </Svg>
  );
});

const BAR_SHAPE = [0.45, 0.75, 1, 0.75, 0.45];
const BAR_FLOOR = [0.4, 0.3, 0.22, 0.3, 0.4];

/** Five thin bars that follow the voice (listening: the microphone; speaking: the rhythm). */
function Bars({ size, energy }: { size: number; energy: Animated.AnimatedInterpolation<number> }) {
  const bars = useMemo(
    () =>
      BAR_SHAPE.map((h, i) => ({
        width: 2.5,
        height: Math.round(size * 0.34 * h),
        borderRadius: 1.25,
        backgroundColor: dusk.color.white,
        transform: [{ scaleY: energy.interpolate({ inputRange: [0, 1], outputRange: [BAR_FLOOR[i], 1] }) }],
      })),
    [size, energy],
  );
  return (
    <View style={styles.bars}>
      {bars.map((style, i) => (
        <Animated.View key={i} style={style} />
      ))}
    </View>
  );
}

/** Three dots that glow one after another while the model thinks. */
function Dots({ size, reduce }: { size: number; reduce: boolean }) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) {
      t.setValue(0.5);
      return;
    }
    const loop = Animated.loop(Animated.timing(t, { toValue: 1, duration: 1200, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [reduce, t]);
  const dots = useMemo(() => {
    const d = Math.max(4, Math.round(size * 0.075));
    return [0, 1, 2].map(i => ({
      width: d,
      height: d,
      borderRadius: d / 2,
      backgroundColor: dusk.color.white,
      // Each dot glows a little after the one before; every range stays inside 0-1 (an input range
      // past 1 isn't monotonic and makes Animated throw).
      opacity: reduce
        ? 0.8
        : t.interpolate({ inputRange: [0, i * 0.22, i * 0.22 + 0.17, i * 0.22 + 0.34, 1], outputRange: [0.35, 0.35, 1, 0.35, 0.35], extrapolate: 'clamp' }),
    }));
  }, [size, reduce, t]);
  return (
    <View style={styles.bars}>
      {dots.map((style, i) => (
        <Animated.View key={i} style={style} />
      ))}
    </View>
  );
}

// --- The microphone level.

export interface MicLevel {
  /** 0-1, animated on the native driver: for VoiceMic's `level`. */
  value: Animated.Value;
  /** Raw levels as they arrive (about ten a second while listening), e.g. for LiquidBackground. */
  subscribe(fn: (v: number) => void): () => void;
}

/** HelperAudioClient (the Argmax helper) reports the microphone level through this callback. */
type LevelSource = { onLevel?: (value: number) => void };

/**
 * The microphone level while `active` (listening), from the Argmax helper's level events. The
 * typed stand-in sends none, so each new partial word gives a short pulse instead. Chains onto
 * any existing onLevel callback and restores it when done, so other listeners keep working.
 */
export function useMicLevel(audio: AudioClient, active: boolean, partial: string): MicLevel {
  const reduce = useReduceMotion();
  const value = useRef(new Animated.Value(0)).current;
  const listeners = useRef(new Set<(v: number) => void>()).current;
  const lastLevelAt = useRef(0);
  const activeRef = useRef(active);
  const reduceRef = useRef(reduce);
  activeRef.current = active;
  reduceRef.current = reduce;

  useEffect(() => {
    const src = audio as AudioClient & LevelSource;
    const prev = src.onLevel;
    let alive = true;
    const mine = (v: number) => {
      prev?.(v);
      if (!alive || !activeRef.current) return;
      lastLevelAt.current = Date.now();
      const to = Math.max(0, Math.min(1, v));
      if (!reduceRef.current) Animated.timing(value, { toValue: to, duration: 90, useNativeDriver: true }).start();
      listeners.forEach(fn => fn(to));
    };
    src.onLevel = mine;
    return () => {
      alive = false;
      if (src.onLevel === mine) src.onLevel = prev;
    };
  }, [audio, value, listeners]);

  // No level events (the typed stand-in): a pulse per new partial word.
  useEffect(() => {
    if (!active || !partial || reduceRef.current || Date.now() - lastLevelAt.current < 600) return;
    const peak = 0.45 + Math.random() * 0.45;
    Animated.sequence([
      Animated.timing(value, { toValue: peak, duration: 90, useNativeDriver: true }),
      Animated.timing(value, { toValue: 0.12, duration: 260, useNativeDriver: true }),
    ]).start();
    listeners.forEach(fn => fn(peak));
  }, [active, partial, value, listeners]);

  // Settle when the microphone stops.
  useEffect(() => {
    if (active) return;
    if (reduceRef.current) value.setValue(0);
    else Animated.timing(value, { toValue: 0, duration: 320, useNativeDriver: true }).start();
    listeners.forEach(fn => fn(0));
  }, [active, value, listeners]);

  return useMemo(
    () => ({
      value,
      subscribe: (fn: (v: number) => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    }),
    [value, listeners],
  );
}

const styles = StyleSheet.create({
  abs: { position: 'absolute' },
  clip: { overflow: 'hidden' },
  center: { alignItems: 'center', justifyContent: 'center' },
  bars: { flexDirection: 'row', alignItems: 'center', gap: 3 },
});
