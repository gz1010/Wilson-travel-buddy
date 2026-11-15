import React, { useEffect, useRef } from 'react';
import { Animated, Image, StyleSheet, View, type ImageStyle, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from './Gradient';
import { sceneFor, TIMES_OF_DAY } from '../../core/look';
import type { Place, TimeOfDay } from '../../core/types';
import { heroPhotos, placePhotos } from '../../pack/seville/photos';
import { useReduceMotion } from './motion';
import { SceneTile } from './SceneTile';
import { dusk } from './tokens';

/** The bundled photo for a place, if the pack has one (scripts/build-photos.mjs). */
export function placePhotoSource(placeId: string): number | undefined {
  return placePhotos[placeId];
}

/** A place's photo, or its drawn scene tile when the pack has no photo. Fills its box. */
export function PlacePhoto({ place, style, imageStyle }: { place: Place; style?: StyleProp<ViewStyle>; imageStyle?: StyleProp<ImageStyle> }) {
  const src = placePhotoSource(place.id);
  return (
    <View style={[{ overflow: 'hidden', backgroundColor: dusk.color.raised }, style]}>
      {src !== undefined ? (
        <Image source={src} resizeMode="cover" style={[StyleSheet.absoluteFill, { width: '100%', height: '100%' }, imageStyle]} accessibilityIgnoresInvertColors />
      ) : (
        <SceneTile scene={sceneFor(place)} style={StyleSheet.absoluteFill} />
      )}
    </View>
  );
}

/** Stand-ins for the hero photos until the pack has them: a sky per time of day. */
const HERO_FALLBACK: Record<TimeOfDay, string[]> = {
  midday: ['#4A7398', '#2D4A63', dusk.color.ground],
  afternoon: ['#8A6A4A', '#5A3A2A', dusk.color.ground],
  dusk: ['#7A5A7E', '#3D2F45', dusk.color.ground],
  night: ['#1F2A44', '#12141B', dusk.color.ground],
};

/**
 * The city photo for the current time of day, crossfading over 600 ms when it changes (snaps
 * with reduce-motion). All four stay mounted so the fade has both images ready.
 */
export function HeroPhoto({ tod, style }: { tod: TimeOfDay; style?: StyleProp<ViewStyle> }) {
  const reduce = useReduceMotion();
  const opacities = useRef(Object.fromEntries(TIMES_OF_DAY.map(t => [t, new Animated.Value(t === tod ? 1 : 0)])) as Record<TimeOfDay, Animated.Value>).current;
  useEffect(() => {
    for (const t of TIMES_OF_DAY) {
      const to = t === tod ? 1 : 0;
      if (reduce) opacities[t].setValue(to);
      else Animated.timing(opacities[t], { toValue: to, duration: dusk.motion.heroFade, useNativeDriver: true }).start();
    }
  }, [tod, reduce, opacities]);
  return (
    <View style={[{ overflow: 'hidden', backgroundColor: dusk.color.ground }, style]} pointerEvents="none">
      {TIMES_OF_DAY.map(t => {
        const src = heroPhotos[t];
        return (
          <Animated.View key={t} style={[StyleSheet.absoluteFill, { opacity: opacities[t] }]}>
            {src !== undefined ? (
              <Image source={src} resizeMode="cover" style={StyleSheet.absoluteFill} />
            ) : (
              <LinearGradient colors={HERO_FALLBACK[t]} style={StyleSheet.absoluteFill} />
            )}
          </Animated.View>
        );
      })}
    </View>
  );
}

/** A dark fade over a photo: behind the header at the top, behind text at the bottom. */
export function PhotoFade({ stops, style }: { stops: [number, number][]; style?: StyleProp<ViewStyle> }) {
  return (
    <LinearGradient
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, style]}
      locations={stops.map(s => s[0])}
      colors={stops.map(s => `rgba(14,15,20,${s[1]})`)}
    />
  );
}
