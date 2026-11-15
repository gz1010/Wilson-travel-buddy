import React, { useEffect, useId, useRef, useState } from 'react';
import { Animated, StyleSheet, View, type ImageSourcePropType, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, Image as SvgImage, LinearGradient, Mask, RadialGradient, Rect, Stop } from 'react-native-svg';
import { useBox } from './Gradient';
import { useReduceMotion } from './motion';
import { SharpImage } from './Photos';
import { dusk, ground } from './tokens';

// An ambient backdrop for a whole screen: a photo scaled to fill it, heavily blurred and darkened,
// with a soft vignette, so the screen has colour behind it instead of flat black. Liquid glass
// needs something behind it to bend and tint; this gives the cards and the tab bar that, while
// the darkening keeps text on it readable.
// Optionally the photo stays sharp at the top (a hero) and melts into the blur further down: the
// sharp copy is drawn in SVG through a gradient mask, aligned with the blurred copy (both cover the
// same box, centred), so there is no seam.
// A new photo (another time of day, another place) crossfades in once its blur is ready; with
// reduce motion it swaps at once.

/** How far the photo recedes, 0-1: the blur radius and the dark wash both follow it. */
const DEFAULT_STRENGTH = 0.6;
/** The sharp top melts into the blur over this many px. */
const DEFAULT_MELT = 150;
/** If the new photo's blur takes longer than this, fade it in anyway. */
const LOAD_WAIT_MS = 500;

type Layer = { id: number; source: ImageSourcePropType; fade: Animated.Value };

export function AmbientBackdrop({
  source,
  strength = DEFAULT_STRENGTH,
  sharpTo = 0,
  melt = DEFAULT_MELT,
  style,
}: {
  /** The photo (a bundled asset). Without one, the plain ground shows. */
  source: ImageSourcePropType | undefined;
  /** 0-1: how blurred and how dark the photo is. 0.6 by default. */
  strength?: number;
  /** px from the top down to which the photo still shows sharp (0: blurred everywhere). */
  sharpTo?: number;
  /** px over which the sharp top melts into the blur, ending at sharpTo. */
  melt?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const reduce = useReduceMotion();
  const box = useBox();
  const nextId = useRef(1);
  const [layers, setLayers] = useState<Layer[]>(() => (source !== undefined ? [{ id: 0, source, fade: new Animated.Value(1) }] : []));

  // A new photo goes on top, transparent until its blur is ready (see onReady).
  useEffect(() => {
    setLayers(prev => {
      const top = prev[prev.length - 1];
      if (top?.source === source) return prev;
      if (source === undefined) return [];
      const fade = new Animated.Value(prev.length === 0 || reduce ? 1 : 0);
      const next = { id: nextId.current++, source, fade };
      return reduce ? [next] : [...prev.slice(-1), next];
    });
  }, [source, reduce]);

  // Fade the top layer in, then drop the ones under it.
  const top = layers[layers.length - 1];
  const [readyId, setReadyId] = useState<number>(-1);
  useEffect(() => {
    if (!top || layers.length < 2) return;
    const wait = setTimeout(() => setReadyId(id => Math.max(id, top.id)), LOAD_WAIT_MS);
    return () => clearTimeout(wait);
  }, [top, layers.length]);
  useEffect(() => {
    if (!top || layers.length < 2 || readyId < top.id) return;
    const run = Animated.timing(top.fade, { toValue: 1, duration: dusk.motion.heroFade, useNativeDriver: true });
    run.start(({ finished }) => {
      if (finished) setLayers(prev => prev.filter(l => l.id >= top.id));
    });
    return () => run.stop();
  }, [top, layers.length, readyId]);

  const s = Math.max(0, Math.min(1, strength));
  const blur = Math.round(16 + 34 * s);
  const wash = 0.18 + 0.5 * s;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.root, style]} onLayout={box.onLayout}>
      {layers.map(l => (
        <Animated.View key={l.id} style={[StyleSheet.absoluteFill, { opacity: l.fade }]}>
          <SharpImage source={l.source} blurRadius={blur} onLoad={() => setReadyId(id => Math.max(id, l.id))} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: ground(wash) }]} />
          {box.size && sharpTo > 0 ? <SharpTop source={l.source} width={box.size.width} height={box.size.height} to={Math.min(sharpTo, box.size.height)} melt={melt} /> : null}
        </Animated.View>
      ))}
      {box.size ? <Vignette width={box.size.width} height={box.size.height} alpha={0.28 + 0.4 * s} /> : null}
    </View>
  );
}

/**
 * A photo that fills its box (cover fit) and fades out over its last `melt` px, so whatever is
 * behind it (an AmbientBackdrop of the same photo) shows through instead of a dark band. For a
 * hero that scrolls with its page (Place), where the backdrop's own fixed sharp top can't follow.
 */
export function MeltingPhoto({ source, melt, style }: { source: ImageSourcePropType; melt: number; style?: StyleProp<ViewStyle> }) {
  const box = useBox();
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, style]} onLayout={box.onLayout}>
      {box.size ? <SharpTop source={source} width={box.size.width} height={box.size.height} to={box.size.height} melt={melt} /> : null}
    </View>
  );
}

/**
 * The photo, sharp, from the top down to `to`, fading out over the last `melt` px. Cover-fit to
 * the whole backdrop (width × height) and centred, exactly like the blurred copy under it.
 * Keyed on its size: react-native-svg on macOS keeps its first drawing when the view is resized.
 */
function SharpTop({ source, width, height, to, melt }: { source: ImageSourcePropType; width: number; height: number; to: number; melt: number }) {
  const uid = useId().replace(/:/g, '');
  if (to <= 0) return null;
  const from = Math.max(0, to - melt) / to;
  // An eased fade (smoothstep), so the melt has no visible start or end.
  const steps = [0, 0.2, 0.4, 0.6, 0.8, 1];
  return (
    <Svg key={`${width}x${height}/${Math.round(to)}`} style={[styles.top, { width, height: to }]} width={width} height={to}>
      <Defs>
        <LinearGradient id={`f${uid}`} x1="0" y1="0" x2="0" y2="1">
          {steps.map(t => (
            <Stop key={t} offset={from + (1 - from) * t} stopColor={dusk.color.white} stopOpacity={1 - t * t * (3 - 2 * t)} />
          ))}
        </LinearGradient>
        <Mask id={`m${uid}`} maskUnits="userSpaceOnUse" x={0} y={0} width={width} height={to}>
          <Rect x={0} y={0} width={width} height={to} fill={`url(#f${uid})`} />
        </Mask>
      </Defs>
      <SvgImage href={source} x={0} y={0} width={width} height={height} preserveAspectRatio="xMidYMid slice" mask={`url(#m${uid})`} />
    </Svg>
  );
}

/** Darker toward the edges and corners, so the eye goes to the middle and edge text stays readable. */
function Vignette({ width, height, alpha }: { width: number; height: number; alpha: number }) {
  const uid = useId().replace(/:/g, '');
  return (
    <Svg key={`${width}x${height}`} style={StyleSheet.absoluteFill} width={width} height={height}>
      <Defs>
        <RadialGradient id={`v${uid}`} cx="50%" cy="46%" rx="72%" ry="62%" fx="50%" fy="46%">
          <Stop offset="0" stopColor={dusk.color.ground} stopOpacity={0} />
          <Stop offset="0.55" stopColor={dusk.color.ground} stopOpacity={0} />
          <Stop offset="0.8" stopColor={dusk.color.ground} stopOpacity={alpha * 0.55} />
          <Stop offset="1" stopColor={dusk.color.ground} stopOpacity={alpha} />
        </RadialGradient>
      </Defs>
      <Rect x={0} y={0} width={width} height={height} fill={`url(#v${uid})`} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: dusk.color.ground, overflow: 'hidden' },
  top: { position: 'absolute', left: 0, top: 0 },
});
