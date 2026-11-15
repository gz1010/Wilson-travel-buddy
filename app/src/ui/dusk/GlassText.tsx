import React, { useId } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Text as SvgText } from 'react-native-svg';
import { placeNameSize } from '../../core/look';
import type { Place } from '../../core/types';
import { dusk } from './tokens';

/**
 * A place name in frosted-glass letters, cut off by the card's bottom edge (AntNow cards, the map's
 * bottom card): a white gradient fill (bright at the top, nearly clear at the cut), a light outline
 * and a soft shadow, so the card's photo reads through the bottom of the letters. Drawn in SVG,
 * which renders on macOS (clipping a photo to text does not). Absolutely fills its card; put it
 * last inside the card.
 */
export function GlassText({ place, size, left = 10 }: { place: Place; size?: number; left?: number }) {
  const uid = useId().replace(/:/g, '');
  const s = size ?? placeNameSize(place.name);
  const tracking = s * dusk.font.placeName.tracking;
  // The baseline sits just above the bottom edge, so descenders and the base of the letters are cut.
  const lift = Math.round(s * 0.02);
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.shadow]} accessible accessibilityRole="header" accessibilityLabel={place.name}>
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs>
          <LinearGradient id={`w${uid}`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#fff" stopOpacity={0.92} />
            <Stop offset="0.55" stopColor="#fff" stopOpacity={0.55} />
            <Stop offset="1" stopColor="#fff" stopOpacity={0.12} />
          </LinearGradient>
        </Defs>
        <SvgText
          x={left}
          y="100%"
          dy={-lift}
          fontFamily="Manrope-ExtraBold"
          fontSize={s}
          letterSpacing={tracking}
          fill={`url(#w${uid})`}
          stroke="#fff"
          strokeOpacity={0.45}
          strokeWidth={1}>
          {place.name}
        </SvgText>
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  shadow: { shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 2 } },
});
