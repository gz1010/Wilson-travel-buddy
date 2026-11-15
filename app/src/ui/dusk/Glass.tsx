import { BlurView } from '@react-native-community/blur';
import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { useReduceMotion } from './motion';
import { dusk, font, glass, white, type GlassKind } from './tokens';

// Liquid glass, five layers back to front (see the AntGlass board):
// 1 refraction: a native blur of what is behind
// 2 body: a 135° white wash (an off-centre radial highlight for orbs)
// 3 rim light: a bright 1 px line along the top edge
// 4 chromatic edges: a faint red line on the left, blue on the right
// 5 lift: a soft dark shadow
// A selected or primary thing uses the "prominent" kind; it is never a colour.

interface GlassProps {
  kind?: GlassKind;
  radius?: number;
  /** Turn the blur off where nothing is behind (saves GPU). */
  blur?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

export function Glass({ kind = 'clear', radius = dusk.radius.card, blur = true, style, children }: GlassProps) {
  const g = glass[kind];
  return (
    <View style={[{ borderRadius: radius, shadowColor: '#000', shadowOpacity: g.shadow, shadowRadius: 16, shadowOffset: { width: 0, height: 12 } }, style]}>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden' }]}>
        {blur && <BlurView style={StyleSheet.absoluteFill} blurType="ultraThinMaterialDark" blurAmount={g.blur} reducedTransparencyFallbackColor={dusk.color.raised} />}
        {kind === 'orb' ? (
          <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
            <Defs>
              <RadialGradient id="orb" cx="32%" cy="24%" r="80%">
                <Stop offset="0" stopColor="#fff" stopOpacity={glass.orb.stops[0]} />
                <Stop offset="0.24" stopColor="#fff" stopOpacity={glass.orb.stops[1]} />
                <Stop offset="0.58" stopColor="#fff" stopOpacity={glass.orb.stops[2]} />
                <Stop offset="1" stopColor="#fff" stopOpacity={glass.orb.stops[3]} />
              </RadialGradient>
            </Defs>
            <Rect width="100%" height="100%" fill="url(#orb)" />
          </Svg>
        ) : (
          <LinearGradient
            style={StyleSheet.absoluteFill}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            colors={[white((g as typeof glass.clear).from), white((g as typeof glass.clear).to)]}
          />
        )}
        {/* Rim light along the top, and the chromatic left and right edges. */}
        <View style={[styles.rimTop, { backgroundColor: white(g.highlight) }]} />
        <View style={[styles.edgeLeft, { backgroundColor: `rgba(255,140,140,${g.red})` }]} />
        <View style={[styles.edgeRight, { backgroundColor: `rgba(140,190,255,${g.blue})` }]} />
        <View style={[StyleSheet.absoluteFill, { borderRadius: radius, borderWidth: 1, borderColor: white(g.border) }]} />
      </View>
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

/** A pill button. Primary actions use the prominent kind. */
export function GlassButton({ label, onPress, kind = 'prominent', height = dusk.size.button, style, textStyle, disabled, accessibilityLabel }: ButtonProps) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} onPress={onPress} disabled={disabled} style={({ pressed }) => [{ opacity: disabled ? 0.45 : pressed ? 0.85 : 1 }, style]}>
      <Glass kind={kind} radius={999} style={{ height, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 22 }}>
        <Text style={[onGlass, font('800'), { fontSize: 15 }, textStyle]}>{label}</Text>
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
    <Pressable accessibilityRole="radio" accessibilityState={{ selected: !!selected }} onPress={onPress} style={[{ minHeight: dusk.size.touch, justifyContent: 'center' }, style]}>
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

const styles = StyleSheet.create({
  rimTop: { position: 'absolute', left: 8, right: 8, top: 0, height: 1 },
  edgeLeft: { position: 'absolute', left: 0, top: 6, bottom: 6, width: 1 },
  edgeRight: { position: 'absolute', right: 0, top: 6, bottom: 6, width: 1 },
});
