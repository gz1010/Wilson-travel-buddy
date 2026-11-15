import MaskedView from '@react-native-masked-view/masked-view';
import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import Svg, { Text as SvgText } from 'react-native-svg';
import { placeNameSize, sceneFor } from '../../core/look';
import type { Place } from '../../core/types';
import { placePhotoSource } from './Photos';
import { dusk, font, sceneColors, white } from './tokens';

/**
 * A place name in frosted-glass letters, cut off by the card's bottom edge (AntNow cards, the map's
 * bottom card). The letters are filled with a blurred, brightened copy of the card's own photo,
 * aligned with it, under a white gradient (60% → 4% top to bottom), with a 1 px white outline
 * and a soft shadow. Absolutely fills its card; put it last inside the card.
 */
export function GlassText({ place, size, left = 10 }: { place: Place; size?: number; left?: number }) {
  const s = size ?? placeNameSize(place.name);
  const tracking = s * dusk.font.placeName.tracking;
  const bottom = -Math.round(s * 0.2);
  const src = placePhotoSource(place.id);
  const scene = sceneColors[sceneFor(place)];
  const textStyle = [font('800'), { fontSize: s, lineHeight: s * 1.05, letterSpacing: tracking }];

  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.shadow]} accessible accessibilityRole="header" accessibilityLabel={place.name}>
      <MaskedView
        style={StyleSheet.absoluteFill}
        maskElement={
          <View style={StyleSheet.absoluteFill}>
            <Text numberOfLines={1} style={[textStyle, { position: 'absolute', left, bottom, color: '#000' }]}>
              {place.name}
            </Text>
          </View>
        }>
        {src !== undefined ? (
          <Image source={src} resizeMode="cover" blurRadius={8} style={StyleSheet.absoluteFill} />
        ) : (
          <LinearGradient colors={[scene.front, scene.back]} style={StyleSheet.absoluteFill} />
        )}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: white(0.14) }]} />
        <LinearGradient colors={[white(0.6), white(0.2), white(0.04)]} locations={[0, 0.6, 1]} style={StyleSheet.absoluteFill} />
      </MaskedView>
      {/* The outline: the same text, stroked. SVG because React Native text has no stroke. */}
      <Svg style={StyleSheet.absoluteFill}>
        <SvgText
          x={left}
          y="100%"
          dy={-bottom - s * 0.27}
          fontFamily="Manrope-ExtraBold"
          fontSize={s}
          letterSpacing={tracking}
          fill="none"
          stroke={white(0.42)}
          strokeWidth={1}>
          {place.name}
        </SvgText>
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  shadow: { shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 2 } },
});
