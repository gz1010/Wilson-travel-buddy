import React, { useId } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Text as SvgText } from 'react-native-svg';
import { useBox } from './Gradient';
import { dusk } from './tokens';

/** Manrope ExtraBold, in em: capital height and the tallest ascender (l, d, h, k). */
const CAP = 0.72;
const ASCENDER = 0.76;

/**
 * Rough Manrope ExtraBold advance widths in em, rounded up a little so a word sized from them
 * never runs past its box. Good enough to fit one word to a width; not a text layout engine.
 */
function advance(ch: string): number {
  if (/[iljI1.,'!|:;]/.test(ch)) return 0.3;
  if (/[ft]/.test(ch)) return 0.4;
  if (ch === ' ') return 0.27;
  if (/[mwMW]/.test(ch)) return 0.92;
  if (/[A-Z]/.test(ch)) return 0.7;
  return 0.62;
}

/** Width of `text` in em at the place-name tracking. */
export function glassWordEm(text: string): number {
  const chars = [...text];
  const tracking = dusk.font.placeName.tracking * Math.max(0, chars.length - 1);
  return chars.reduce((sum, ch) => sum + advance(ch), 0) + tracking;
}

/** The largest size, up to `max`, at which `text` fits in `width` px. */
export function glassWordSize(text: string, width: number, max: number): number {
  return Math.max(12, Math.floor(Math.min(max, width / Math.max(0.5, glassWordEm(text)))));
}

/** How far below its box's bottom edge a word's baseline sits when `cut` of its capital height is sunk. */
export function glassWordSink(size: number, cut: number): number {
  return size * CAP * cut;
}

/** How many px of a word drawn at `size` show above its box's bottom edge when `cut` of its capital height is sunk below it. */
export function glassWordVisible(size: number, cut: number): number {
  return size * (ASCENDER - CAP * cut);
}

/**
 * A word in 3D frosted-glass letters (the Panora card style), drawn in SVG because it renders on
 * macOS where clipping a blur to text does not:
 * - a soft drop shadow and a hard contact shadow under the letters,
 * - a thin glass body extruded a few px downward, lighter at its far edge,
 * - the face: white, bright at the top and nearly clear at the bottom, so the photo reads through,
 * - a rim that catches the light on the top edges.
 * `cut` sinks the word below its box's bottom edge by that share of the capital height: with
 * 0.25 three quarters of the letters show, as if the card's edge were in front of them.
 * Fills its box (give the box a size and position); the box's parent should clip.
 */
export function GlassWord({
  text,
  size,
  cut = 0,
  depth,
  align = 'center',
  inset = 0,
  label,
  style,
}: {
  text: string;
  size: number;
  /** Share of the capital height hidden below the bottom edge (0 to 1). */
  cut?: number;
  /** Extrusion in px; about 4 % of the size by default. */
  depth?: number;
  align?: 'center' | 'left';
  /** Left padding when align is 'left'. */
  inset?: number;
  /** Accessibility label; null leaves the word to a labelled parent. */
  label?: string | null;
  style?: StyleProp<ViewStyle>;
}) {
  const uid = useId().replace(/:/g, '');
  // Measured, not "100%": react-native-svg on macOS keeps its first drawing when the view is resized.
  const box = useBox();
  const w = box.size?.width ?? 0;
  const h = box.size?.height ?? 0;
  const tracking = size * dusk.font.placeName.tracking;
  const d = Math.max(1, Math.round(depth ?? size * 0.04));
  const sink = size * CAP * cut;
  const common = {
    x: align === 'center' ? w / 2 : inset,
    y: h,
    fontFamily: 'Manrope-ExtraBold',
    fontSize: size,
    letterSpacing: tracking,
    textAnchor: align === 'center' ? ('middle' as const) : ('start' as const),
  };
  // Back to front: the contact shadow, then the glass body from its far edge up to just under the face.
  const body: React.ReactNode[] = [
    <SvgText key="contact" {...common} dy={sink + d + 1.5} fill="#000" fillOpacity={0.28}>
      {text}
    </SvgText>,
  ];
  for (let i = d; i >= 1; i--) {
    body.push(
      <SvgText key={`b${i}`} {...common} dy={sink + i} fill="#fff" fillOpacity={i === d ? 0.16 : 0.07}>
        {text}
      </SvgText>,
    );
  }
  const a11y = label !== null;
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.shadow, style]}
      accessible={a11y}
      accessibilityRole={a11y ? 'header' : undefined}
      accessibilityLabel={a11y ? label ?? text : undefined}
      importantForAccessibility={a11y ? 'yes' : 'no-hide-descendants'}
      onLayout={box.onLayout}>
      {box.size ? (
        <Svg key={box.key} style={StyleSheet.absoluteFill} width={w} height={h}>
          <Defs>
            {/* The gradients span the whole letter, sunk part included: the cut line lands near 0.2. */}
            <LinearGradient id={`f${uid}`} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#fff" stopOpacity={0.96} />
              <Stop offset="0.45" stopColor="#fff" stopOpacity={0.62} />
              <Stop offset="0.78" stopColor="#fff" stopOpacity={0.24} />
              <Stop offset="1" stopColor="#fff" stopOpacity={0.1} />
            </LinearGradient>
            <LinearGradient id={`r${uid}`} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#fff" stopOpacity={0.95} />
              <Stop offset="0.5" stopColor="#fff" stopOpacity={0.4} />
              <Stop offset="1" stopColor="#fff" stopOpacity={0.15} />
            </LinearGradient>
          </Defs>
          {body}
          <SvgText {...common} dy={sink} fill={`url(#f${uid})`} stroke={`url(#r${uid})`} strokeWidth={1.1}>
            {text}
          </SvgText>
        </Svg>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  shadow: { shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 14, shadowOffset: { width: 0, height: 6 } },
});
