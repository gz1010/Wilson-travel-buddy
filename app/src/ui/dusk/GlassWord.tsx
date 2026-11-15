import React, { useId } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Text as SvgText } from 'react-native-svg';
import { useBox } from './Gradient';
import { dusk } from './tokens';

// Glass letters are cut from SF Pro Heavy, the system font at weight 800: here through
// react-native-svg (which resolves the 'System' family like React Native's own text), in the
// WebGL page (liquidGlassPage.ts) as canvas '800 …px -apple-system'.

/** SF Pro Heavy, in em: capital height and the tallest ascender with its overshoot (l, d, S). */
const CAP = 0.705;
const ASCENDER = 0.72;

/** The weight the glass letters are drawn at (SF Pro Heavy). */
export const GLASS_WEIGHT = '800';

/**
 * SF Pro Heavy advance widths in em, measured at 32 pt (where the letters are a little wider than
 * at the 40-150 px the glass words are drawn at, so a word sized from them never runs past its
 * box). Kerning is left out: it only ever brings letters closer.
 */
const WIDTHS: [string, number][] = [
  [' ', 0.207],
  [',.:;’‘·', 0.268],
  ['|', 0.269],
  ['ij', 0.272],
  ['l', 0.276],
  ["'", 0.292],
  ['I', 0.299],
  ['/\\', 0.328],
  ['!¡', 0.356],
  ['ft', 0.397],
  ['r', 0.407],
  ['()[]{}', 0.427],
  ['-', 0.461],
  ['“”', 0.472],
  ['*', 0.488],
  ['"', 0.497],
  ['1`', 0.513],
  ['z', 0.538],
  ['s', 0.554],
  ['v', 0.565],
  ['L', 0.566],
  ['?¿', 0.571],
  ['Fx', 0.572],
  ['k', 0.579],
  ['y', 0.58],
  ['c', 0.581],
  ['a', 0.584],
  ['e', 0.591],
  ['E', 0.597],
  ['7', 0.599],
  ['J', 0.605],
  ['o', 0.608],
  ['_nu–', 0.615],
  ['h', 0.622],
  ['T', 0.626],
  ['q', 0.629],
  ['gp', 0.63],
  ['d', 0.631],
  ['b', 0.633],
  ['2', 0.636],
  ['PZ', 0.652],
  ['5', 0.66],
  ['3', 0.663],
  ['S', 0.664],
  ['#', 0.67],
  ['B', 0.672],
  ['R', 0.675],
  ['$+<=>^~', 0.683],
  ['469', 0.684],
  ['8', 0.688],
  ['K', 0.694],
  ['0', 0.695],
  ['Y', 0.706],
  ['V', 0.717],
  ['D', 0.724],
  ['X', 0.725],
  ['U', 0.727],
  ['&', 0.732],
  ['AN', 0.736],
  ['C', 0.739],
  ['G', 0.751],
  ['H', 0.759],
  ['Q', 0.776],
  ['O', 0.777],
  ['w', 0.843],
  ['M—', 0.89],
  ['@', 0.908],
  ['m', 0.909],
  ['%', 0.947],
  ['W', 1.001],
];
const ADVANCE = new Map<string, number>(WIDTHS.flatMap(([chars, w]) => [...chars].map(ch => [ch, w] as [string, number])));
/** Letters outside the table (other scripts, symbols): about a wide lowercase letter. */
const DEFAULT_ADVANCE = 0.66;

/** A letter's advance in em; accented letters (é, ñ, Á) take their base letter's. */
function advance(ch: string): number {
  const known = ADVANCE.get(ch);
  if (known !== undefined) return known;
  const base = ch.normalize('NFD')[0];
  return (base !== undefined && ADVANCE.get(base)) || DEFAULT_ADVANCE;
}

/**
 * Margin over the table: at 20-30 px, SF Pro's smaller optical sizes set a word up to 1 % wider
 * (checked against CoreText for every place name in the Seville pack at 20, 24, 30, 46 and 62 px).
 */
const WIDTH_MARGIN = 1.015;

/** Width of `text` in em at the place-name tracking (never less than SF Pro Heavy sets it). */
export function glassWordEm(text: string): number {
  const chars = [...text];
  const tracking = dusk.font.placeName.tracking * Math.max(0, chars.length - 1);
  return (chars.reduce((sum, ch) => sum + advance(ch), 0) + tracking) * WIDTH_MARGIN;
}

/** The largest size, up to `max`, at which `text` fits in `width` px. */
export function glassWordSize(text: string, width: number, max: number): number {
  return Math.max(12, Math.floor(Math.min(max, width / Math.max(0.5, glassWordEm(text)))));
}

/**
 * The room a glass line keeps from each side of its box: its inset, and never less than a few px
 * so the rim and the shadow are not cut off. liquidGlassPage.ts keeps the same.
 */
export function glassLinePad(inset: number): number {
  return Math.max(6, inset);
}

/**
 * The size a line of glass letters is drawn at in a box `width` px wide: `size`, or smaller so the
 * word fits between the pads on both sides. The sink below the edge is worked out from the drawn
 * size, so a sunk word keeps the same share of its height below the edge.
 */
export function glassWordFit(text: string, size: number, width: number, inset: number): number {
  const room = width - 2 * glassLinePad(inset);
  if (room <= 0) return size;
  return Math.max(8, Math.min(size, room / Math.max(0.5, glassWordEm(text))));
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
 * A word too long for its box is drawn smaller so it fits inside the inset on both sides.
 * Fills its box (give the box a size and position); the box's parent should clip.
 */
export function GlassWord({
  text,
  size,
  cut = 0,
  lift = 0,
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
  /** px the baseline sits above the bottom edge (at `size`; scaled with the word if it must shrink). */
  lift?: number;
  /** Extrusion in px; about 4 % of the size by default. */
  depth?: number;
  align?: 'center' | 'left';
  /** Left padding when align is 'left'; the room kept on both sides when the word must shrink. */
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
  const drawn = w > 0 ? glassWordFit(text, size, w, inset) : size;
  const shrink = drawn / size;
  const tracking = drawn * dusk.font.placeName.tracking;
  const d = Math.max(1, Math.round((depth ?? size * 0.04) * shrink));
  const sink = drawn * CAP * cut - lift * shrink;
  const common = {
    x: align === 'center' ? w / 2 : inset,
    y: h,
    fontFamily: dusk.font.family,
    fontWeight: GLASS_WEIGHT,
    fontSize: drawn,
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
