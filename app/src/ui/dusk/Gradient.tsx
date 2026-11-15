import React, { useCallback, useId, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
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
  // react-native-svg on macOS keeps its first drawing when the view is resized, so a gradient
  // drawn with "100%" stays at the size of the first layout (the window grows after launch).
  // Draw at the measured size instead, and redraw when it changes.
  const box = useBox();
  return (
    <View pointerEvents={pointerEvents} style={style} onLayout={box.onLayout}>
      {box.size ? (
        <Svg key={box.key} style={StyleSheet.absoluteFill} width={box.size.width} height={box.size.height}>
          <Defs>
            <SvgLinearGradient id={id} x1={start.x} y1={start.y} x2={end.x} y2={end.y}>
              {colors.map((c, i) => {
                const s = stop(c);
                const offset = locations?.[i] ?? (colors.length === 1 ? 0 : i / (colors.length - 1));
                return <Stop key={i} offset={offset} stopColor={s.color} stopOpacity={s.opacity} />;
              })}
            </SvgLinearGradient>
          </Defs>
          <Rect x={0} y={0} width={box.size.width} height={box.size.height} fill={`url(#${id})`} />
        </Svg>
      ) : null}
      {children}
    </View>
  );
}

/**
 * The measured size of a view, for SVG that must be drawn at its real size on macOS. `key`
 * changes with the size, so an Svg keyed on it is recreated (and redrawn) on every resize.
 */
export function useBox() {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    const h = Math.round(e.nativeEvent.layout.height);
    setSize(prev => (prev && prev.width === w && prev.height === h ? prev : { width: w, height: h }));
  }, []);
  return { size: size && size.width > 0 && size.height > 0 ? size : null, key: size ? `${size.width}x${size.height}` : 'none', onLayout };
}

export default LinearGradient;
