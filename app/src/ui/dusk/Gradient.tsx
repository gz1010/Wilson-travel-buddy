import React, { useId } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect, Stop } from 'react-native-svg';

/** Splits "rgba(r,g,b,a)" into an SVG colour and opacity; other colours pass through. */
function stop(color: string): { color: string; opacity: number } {
  const m = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(color);
  return m ? { color: `rgb(${m[1]},${m[2]},${m[3]})`, opacity: Number(m[4]) } : { color, opacity: 1 };
}

interface Props {
  colors: string[];
  /** 0–1 positions for each colour; evenly spaced if left out. */
  locations?: number[];
  start?: { x: number; y: number };
  end?: { x: number; y: number };
  style?: StyleProp<ViewStyle>;
  pointerEvents?: 'none' | 'auto' | 'box-none' | 'box-only';
  children?: React.ReactNode;
}

/**
 * A linear gradient drawn with react-native-svg, which works on macOS (the usual gradient
 * libraries are iOS/Android only). Same props as react-native-linear-gradient; top to bottom by
 * default.
 */
export function LinearGradient({ colors, locations, start = { x: 0, y: 0 }, end = { x: 0, y: 1 }, style, pointerEvents = 'none', children }: Props) {
  const id = `g${useId().replace(/:/g, '')}`;
  return (
    <View pointerEvents={pointerEvents} style={style}>
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs>
          <SvgLinearGradient id={id} x1={start.x} y1={start.y} x2={end.x} y2={end.y}>
            {colors.map((c, i) => {
              const s = stop(c);
              const offset = locations?.[i] ?? (colors.length === 1 ? 0 : i / (colors.length - 1));
              return <Stop key={i} offset={offset} stopColor={s.color} stopOpacity={s.opacity} />;
            })}
          </SvgLinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
      {children}
    </View>
  );
}

export default LinearGradient;
