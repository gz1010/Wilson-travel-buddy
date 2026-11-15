import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Image,
  StyleSheet,
  View,
  type ImageSourcePropType,
  type ImageStyle,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
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

/** How long a new size must hold before the photo is decoded again for it (a window being dragged). */
const SETTLE_MS = 160;

/**
 * The size of a view, rounded, once it has stopped changing: the first size at once, later ones
 * after SETTLE_MS without a change.
 */
function useSettledSize() {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const first = useRef(true);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const next = { width: Math.round(e.nativeEvent.layout.width), height: Math.round(e.nativeEvent.layout.height) };
    if (next.width <= 0 || next.height <= 0) return;
    const apply = () => setSize(prev => (prev && prev.width === next.width && prev.height === next.height ? prev : next));
    if (timer.current) clearTimeout(timer.current);
    if (first.current) {
      first.current = false;
      apply();
    } else {
      timer.current = setTimeout(apply, SETTLE_MS);
    }
  }, []);
  return { size, onLayout };
}

/** A bundled photo's width / height, when React Native knows it (every require()d asset). */
function naturalAspect(source: ImageSourcePropType): number | undefined {
  try {
    const a = typeof source === 'number' ? Image.resolveAssetSource(source) : undefined;
    return a && a.width > 0 && a.height > 0 ? a.width / a.height : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Cover fit done by layout: the image box keeps the photo's own shape, is just big enough to
 * cover the "WxH" box and is centred on it (the parent clips), and the photo is stretched into it.
 * react-native-macos does cover by resampling the photo to the view's bounds when it arrives and
 * then drawing it unscaled; a photo already in the image cache can arrive before the view has its
 * frame, and is then drawn at full size: a few px of the middle of it, magnified (Now's stop
 * thumbnails showed a flat patch of sky). Stretch scales whatever arrives to the view's frame.
 */
function coverBox(k: string, aspect: number): ImageStyle {
  const [w, h] = k.split('x').map(Number);
  const width = Math.max(w, h * aspect);
  const height = Math.max(h, w / aspect);
  return { position: 'absolute', width, height, left: (w - width) / 2, top: (h - height) / 2 };
}

/**
 * A cover-fit photo drawn at its final size. react-native-macos decodes a photo for the size its
 * view has when it loads and resamples it to cover that size; when the view then grows or changes
 * shape (the window settles at its real size after launch, a card finishes its layout) it keeps
 * that copy and stretches it, so photos look soft and blocky. This measures its box and mounts the
 * Image only at a settled size, keyed on it, so each size gets its own decode from the full-size
 * file. The previous image stays underneath until the new one has loaded, so nothing flashes.
 * Fills its box; give the box a size.
 */
export function SharpImage({
  source,
  style,
  imageStyle,
  accessibilityLabel,
  blurRadius,
  onLoad,
}: {
  source: ImageSourcePropType;
  style?: StyleProp<ViewStyle>;
  imageStyle?: StyleProp<ImageStyle>;
  accessibilityLabel?: string;
  /** Blurs the decoded photo natively (vImage, off the main thread); AmbientBackdrop uses it. */
  blurRadius?: number;
  /** Called when the image for the current size is on screen (after its blur, if any). */
  onLoad?: () => void;
}) {
  const { size, onLayout } = useSettledSize();
  const key = size ? `${size.width}x${size.height}` : null;
  // The size whose image is on screen; while a new size loads, that image stays under it.
  const [shown, setShown] = useState<string | null>(null);
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;
  const loaded = useCallback(
    (k: string) => () => {
      setShown(k);
      onLoadRef.current?.();
    },
    [],
  );
  const layers = key === null ? [] : shown && shown !== key ? [shown, key] : [key];
  const aspect = useMemo(() => naturalAspect(source), [source]);
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.clip, style]} onLayout={onLayout}>
      {layers.map(k => (
        <Image
          key={k}
          source={source}
          resizeMode={aspect ? 'stretch' : 'cover'}
          blurRadius={blurRadius}
          onLoad={k === key ? loaded(k) : undefined}
          onError={k === key ? loaded(k) : undefined}
          style={[aspect ? coverBox(k, aspect) : StyleSheet.absoluteFill, imageStyle]}
          accessible={!!accessibilityLabel && k === key}
          accessibilityLabel={k === key ? accessibilityLabel : undefined}
          accessibilityIgnoresInvertColors
        />
      ))}
    </View>
  );
}

/** A place's photo, or its drawn scene tile when the pack has no photo. Fills its box. */
export function PlacePhoto({ place, style, imageStyle }: { place: Place; style?: StyleProp<ViewStyle>; imageStyle?: StyleProp<ImageStyle> }) {
  const src = placePhotoSource(place.id);
  return (
    <View style={[{ overflow: 'hidden', backgroundColor: dusk.color.raised }, style]}>
      {src !== undefined ? <SharpImage source={src} imageStyle={imageStyle} /> : <SceneTile scene={sceneFor(place)} style={StyleSheet.absoluteFill} />}
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
            {src !== undefined ? <SharpImage source={src} /> : <LinearGradient colors={HERO_FALLBACK[t]} style={StyleSheet.absoluteFill} />}
          </Animated.View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
});

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
