import React, { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient as SvgLinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';
import { GlassBackdrop, hasLiquidGlass } from './Blur';
import { useReduceMotion } from './motion';
import { dusk, font, glass, type GlassKind } from './tokens';

// Liquid glass, after liquid-glass-react (github.com/rdev/liquid-glass-react): nearly clear, no
// grey tint, the content behind stays readable.
// - On macOS 26 the backdrop is Apple's own Liquid Glass (refraction and edge light built in), so
//   only a soft shadow and, for prominent glass, a little extra light are added.
// - Elsewhere: a light native blur, a faint body wash, a 1.5 px rim whose highlight sweeps across
//   at 135° (transparent → bright → transparent), a 0.5 px hairline, and a soft shadow.
// A selected or primary thing uses the "prominent" kind; it is never a colour.

interface GlassProps {
  kind?: GlassKind;
  radius?: number;
  /** Turn the blur off where nothing is behind (saves GPU). */
  blur?: boolean;
  /**
   * Colour the glass, e.g. while someone is speaking: any CSS colour, used at the alpha it
   * carries ('rgba(255,170,90,0.35)'). Leave it out for clear glass.
   */
  tint?: string;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

/** The rim: a rounded-rect stroke with a 135° highlight sweep, like liquid-glass-react's border layers. */
function Rim({ width, height, radius, strength }: { width: number; height: number; radius: number; strength: number }) {
  const id = useRef(`rim${Math.random().toString(36).slice(2)}`).current;
  if (width <= 0 || height <= 0) return null;
  const r = Math.min(radius, height / 2, width / 2);
  return (
    <Svg pointerEvents="none" style={StyleSheet.absoluteFill} width={width} height={height}>
      <Defs>
        <SvgLinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#fff" stopOpacity={0.55 * strength} />
          <Stop offset="0.33" stopColor="#fff" stopOpacity={0.12 * strength} />
          <Stop offset="0.66" stopColor="#fff" stopOpacity={0.4 * strength} />
          <Stop offset="1" stopColor="#fff" stopOpacity={0.05 * strength} />
        </SvgLinearGradient>
      </Defs>
      <Rect x={0.75} y={0.75} width={width - 1.5} height={height - 1.5} rx={Math.max(0, r - 0.75)} fill="none" stroke={`url(#${id})`} strokeWidth={1.5} />
      <Rect x={0.25} y={0.25} width={width - 0.5} height={height - 0.5} rx={r} fill="none" stroke="#fff" strokeOpacity={0.22} strokeWidth={0.5} />
    </Svg>
  );
}

export function Glass({ kind = 'clear', radius = dusk.radius.card, blur = true, tint, style, children }: GlassProps) {
  const g = glass[kind];
  const [size, setSize] = useState({ width: 0, height: 0 });
  const prominent = kind === 'prominent';
  const native = blur && hasLiquidGlass;
  // Body light: almost nothing for clear glass; more for prominent; a top-left radial glint for orbs.
  const body = native ? (prominent ? 0.14 : 0) : prominent ? 0.22 : 0.06;
  // Pills pass 999: native glass needs the real radius, at most half the shorter side.
  const r = size.width > 0 && size.height > 0 ? Math.min(radius, size.width / 2, size.height / 2) : radius;
  return (
    <View
      onLayout={e => {
        const { width, height } = e.nativeEvent.layout;
        if (width !== size.width || height !== size.height) setSize({ width, height });
      }}
      style={[{ borderRadius: radius, shadowColor: '#000', shadowOpacity: g.shadow * 0.7, shadowRadius: 20, shadowOffset: { width: 0, height: 12 } }, style]}>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden' }]}>
        {blur && <GlassBackdrop style={StyleSheet.absoluteFill} radius={r} variant={prominent ? 'regular' : 'clear'} />}
        {kind === 'orb' ? (
          <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
            <Defs>
              <RadialGradient id="orb" cx="32%" cy="24%" r="80%">
                <Stop offset="0" stopColor="#fff" stopOpacity={glass.orb.stops[0] * 0.7} />
                <Stop offset="0.24" stopColor="#fff" stopOpacity={glass.orb.stops[1] * 0.6} />
                <Stop offset="0.58" stopColor="#fff" stopOpacity={0.02} />
                <Stop offset="1" stopColor="#fff" stopOpacity={0.1} />
              </RadialGradient>
            </Defs>
            <Rect width="100%" height="100%" fill="url(#orb)" />
          </Svg>
        ) : body > 0 ? (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(255,255,255,${body})` }]} />
        ) : null}
        {tint ? <View style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} /> : null}
      </View>
      {/* Apple's Liquid Glass draws its own edge light; elsewhere, draw the rim. */}
      {!native && <Rim width={size.width} height={size.height} radius={radius} strength={prominent || kind === 'orb' ? 1.4 : 1} />}
      {children}
    </View>
  );
}

/** Text on glass: white, bold, with a soft shadow so it reads over bright photos. */
export const onGlass: TextStyle = {
  color: dusk.color.white,
  textShadowColor: 'rgba(0,0,0,0.35)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 2,
};

interface ButtonProps {
  label: string;
  onPress?: () => void;
  kind?: GlassKind;
  height?: number;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  disabled?: boolean;
  accessibilityLabel?: string;
}

/**
 * VoiceOver's press (AXPress) on macOS. react-native-macos hands it only to onAccessibilityTap,
 * which Pressable never sets, so without this no Dusk button can be pressed with VoiceOver (or by
 * any assistive tool that presses buttons). Spread it on a Pressable next to its onPress.
 */
export function axPress(onPress?: () => void, disabled?: boolean): { onAccessibilityTap?: () => void } {
  return onPress && !disabled ? { onAccessibilityTap: () => onPress() } : {};
}

/** A pill button. Primary actions use the prominent kind. */
export function GlassButton({ label, onPress, kind = 'prominent', height = dusk.size.button, style, textStyle, disabled, accessibilityLabel }: ButtonProps) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} onPress={onPress} {...axPress(onPress, disabled)} disabled={disabled} style={({ pressed }) => [{ opacity: disabled ? 0.45 : pressed ? 0.85 : 1 }, style]}>
      <Glass kind={kind} radius={999} style={{ height, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 22 }}>
        <Text style={[onGlass, font('800'), { fontSize: 15 }, textStyle]}>{label}</Text>
      </Glass>
    </Pressable>
  );
}

interface IconButtonProps {
  onPress?: () => void;
  accessibilityLabel: string;
  /** The visible circle; the touch target grows to at least 44 around it. */
  size?: number;
  kind?: GlassKind;
  blur?: boolean;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}

/** A round glass button holding an icon (close, map...). Orb glass by default. */
export function GlassIconButton({ onPress, accessibilityLabel, size = dusk.size.orb, kind = 'orb', blur, style, children }: IconButtonProps) {
  const slop = Math.max(0, Math.ceil((dusk.size.touch - size) / 2));
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} {...axPress(onPress)} hitSlop={slop} style={({ pressed }) => [{ opacity: pressed ? 0.85 : 1 }, style]}>
      <Glass kind={kind} radius={size / 2} blur={blur} style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        {children}
      </Glass>
    </Pressable>
  );
}

interface ChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  height?: number;
}

/** A pill chip. Selected = prominent glass, scaled to 1.04 over 240 ms (snaps with reduce-motion). */
export function GlassChip({ label, selected, onPress, style, height = 40 }: ChipProps) {
  const reduce = useReduceMotion();
  const scale = useRef(new Animated.Value(selected ? dusk.motion.selectScale : 1)).current;
  useEffect(() => {
    const to = selected ? dusk.motion.selectScale : 1;
    if (reduce) scale.setValue(to);
    else Animated.timing(scale, { toValue: to, duration: dusk.motion.replan, useNativeDriver: true }).start();
  }, [selected, reduce, scale]);
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ selected: !!selected }} onPress={onPress} {...axPress(onPress)} style={[{ minHeight: dusk.size.touch, justifyContent: 'center' }, style]}>
      <Animated.View style={{ transform: [{ scale }] }}>
        <Glass kind={selected ? 'prominent' : 'clear'} radius={999} style={{ height, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 }}>
          <Text style={[onGlass, font('700'), { fontSize: 13 }]}>{label}</Text>
        </Glass>
      </Animated.View>
    </Pressable>
  );
}

/** The "Offline" chip: always visible on the main screens. */
export function OfflineChip({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <Glass kind="clear" radius={999} style={[{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, height: 28, gap: 6 }, style]}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff', shadowColor: '#fff', shadowOpacity: 0.8, shadowRadius: 4 }} />
      <Text style={[onGlass, font('700'), { fontSize: 11 }]}>Offline</Text>
    </Glass>
  );
}

