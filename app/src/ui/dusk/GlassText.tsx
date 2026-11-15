import React, { useId } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { ClipPath, Defs, G, Image as SvgImage, LinearGradient, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { placeNameSize, sceneFor } from '../../core/look';
import type { Place } from '../../core/types';
import { placePhotoSource } from './Photos';
import { dusk, sceneColors, white } from './tokens';

/**
 * A place name in frosted-glass letters, cut off by the card's bottom edge (AntNow cards, the map's
 * bottom card). The letters are clipped from a brightened copy of the card's own photo, aligned
 * with it, under a white gradient (60% → 4% top to bottom), with a 1 px white outline and a soft
 * shadow. Drawn in SVG: it works on macOS, where no masking library exists. Absolutely fills its
 * card; put it last inside the card.
 */
export function GlassText({ place, size, left = 10 }: { place: Place; size?: number; left?: number }) {
  const uid = useId().replace(/:/g, '');
  const s = size ?? placeNameSize(place.name);
  const tracking = s * dusk.font.placeName.tracking;
  // The baseline sits below the card edge so the bottom of the letters is cut off.
  const baselineFromBottom = Math.round(s * 0.2) - Math.round(s * 0.22);
  const src = placePhotoSource(place.id);
  const scene = sceneColors[sceneFor(place)];
  const textProps = {
    x: left,
    y: '100%',
    dy: -baselineFromBottom,
    fontFamily: 'Manrope-ExtraBold',
    fontSize: s,
    letterSpacing: tracking,
  } as const;

  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.shadow]} accessible accessibilityRole="header" accessibilityLabel={place.name}>
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs>
          <ClipPath id={`c${uid}`}>
            <SvgText {...textProps}>{place.name}</SvgText>
          </ClipPath>
          <LinearGradient id={`w${uid}`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#fff" stopOpacity={0.6} />
            <Stop offset="0.6" stopColor="#fff" stopOpacity={0.2} />
            <Stop offset="1" stopColor="#fff" stopOpacity={0.04} />
          </LinearGradient>
        </Defs>
        <G clipPath={`url(#c${uid})`}>
          {src !== undefined ? (
            <SvgImage href={src} x="0" y="0" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" />
          ) : (
            <Rect x="0" y="0" width="100%" height="100%" fill={scene.front} />
          )}
          <Rect x="0" y="0" width="100%" height="100%" fill="#fff" fillOpacity={0.16} />
          <Rect x="0" y="0" width="100%" height="100%" fill={`url(#w${uid})`} />
        </G>
        <SvgText {...textProps} fill="none" stroke={white(0.42)} strokeWidth={1}>
          {place.name}
        </SvgText>
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  shadow: { shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 2 } },
});
