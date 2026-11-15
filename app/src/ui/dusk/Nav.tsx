import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { hasLiquidGlass } from './Blur';
import { axPress, Glass } from './Glass';
import { ChatIcon, MapIcon, MicIcon, NowIcon, ScanIcon, TranslateIcon } from './Icons';
import { useReduceMotion } from './motion';
import { useScreenSize } from './Screen';
import { dusk, white } from './tokens';

export type ScreenName = 'welcome' | 'setup' | 'now' | 'place' | 'map' | 'talk' | 'look';

/** The home (WelcomeScreen): Wilson, the cities he knows, and Plan your next journey. */
export const HOME: ScreenName = 'welcome';

export interface Nav {
  screen: ScreenName;
  go(screen: ScreenName): void;
  /** Opens the Place screen for a pack place. */
  openPlace(placeId: string): void;
  placeId?: string;
}

/** A chevron pointing left (decorative: HomeLink carries the label). */
const BackChevron = ({ size = 16, color = dusk.color.white }: { size?: number; color?: string }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M15 5l-7 7 7 7" />
  </Svg>
);

/**
 * The way home from inside a city's guide: wraps the city's name in a screen's header (Now) with a
 * small chevron before it, and takes it back to the cities Wilson knows when pressed.
 */
export function HomeLink({ nav, city, children, style }: { nav: Nav; city: string; children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const [hover, setHover] = useState(false);
  const go = () => nav.go(HOME);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${city} guide`}
      accessibilityHint="Back to the cities Wilson knows"
      onPress={go}
      {...axPress(go)}
      {...tooltip('Back to the cities Wilson knows')}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      hitSlop={8}
      style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 3, flexShrink: 1, opacity: pressed ? 0.7 : 1 }, style]}>
      <BackChevron size={17} color={hover ? dusk.color.white : dusk.color.text2} />
      {children}
    </Pressable>
  );
}

// The tab bar's smoke. Its clear glass takes the brightness of what is behind it, so over a bright
// screen (the Map's white layer) its white icons all but vanish; that screen smokes the bar with
// the same wash as its own glass while it shows, and clears it when it goes.
let barTint: string | undefined;
const barTintListeners = new Set<() => void>();
const subscribeBarTint = (listener: () => void) => {
  barTintListeners.add(listener);
  return () => {
    barTintListeners.delete(listener);
  };
};
const readBarTint = () => barTint;

/** Smokes (a wash colour) or clears (undefined) the floating tab bar's glass. */
export function setTabBarTint(tint: string | undefined) {
  if (tint === barTint) return;
  barTint = tint;
  barTintListeners.forEach(l => l());
}

/** The mic orb: tap to talk, tap again to stop. Shows live bars while listening. */
export function MicOrb({ listening, onPress, size = dusk.size.orb, style }: { listening: boolean; onPress: () => void; size?: number; style?: StyleProp<ViewStyle> }) {
  const bar = (h: number) => <View style={{ width: Math.max(3, size / 16), height: h, borderRadius: 3, backgroundColor: dusk.color.white }} />;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={listening ? 'Stop listening' : 'Ask your buddy'} onPress={onPress} {...axPress(onPress)} style={style}>
      <Glass
        kind="orb"
        radius={size / 2}
        style={[
          { width: size, height: size, alignItems: 'center', justifyContent: 'center' },
          listening && { shadowColor: dusk.color.white, shadowOpacity: 0.25, shadowRadius: size / 3 },
        ]}>
        {listening ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            {bar(size * 0.19)}
            {bar(size * 0.35)}
            {bar(size * 0.25)}
            {bar(size * 0.13)}
          </View>
        ) : (
          <MicIcon size={size * 0.43} />
        )}
      </Glass>
    </Pressable>
  );
}

type IconComponent = (p: { size?: number; color?: string; strokeWidth?: number }) => React.JSX.Element;

/** The tabs, left to right. Chat is the Plan screen's id ('setup'); Scan is Look's ('look'). */
export const TABS: { screen: ScreenName; label: string; Icon: IconComponent }[] = [
  { screen: 'now', label: 'Now', Icon: NowIcon },
  { screen: 'map', label: 'Map', Icon: MapIcon },
  { screen: 'setup', label: 'Chat', Icon: ChatIcon },
  { screen: 'talk', label: 'Translate', Icon: TranslateIcon },
  { screen: 'look', label: 'Scan', Icon: ScanIcon },
];

/** Where the bar sits: its bottom edge is this far above the window's bottom. */
export const TAB_BAR_BOTTOM = 26;
/** The bar's height (tabs plus padding). Screens keep their bottom ~100 px free for it. */
export const TAB_BAR_HEIGHT = dusk.size.tabBar;

const PAD = 5; // between the bar's edge and the tabs
const TAB_H = TAB_BAR_HEIGHT - PAD * 2; // 48
const ICON = 22;
/** How much the lens magnifies the icon under it. */
const MAGNIFY = 1.16;
/** The lens's glare at rest; it brightens while the lens slides. */
const GLARE_REST = 0.7;
/** The lens reaches this far past its tab on each side: a capsule a little wider than tall. */
const LENS_OUT = 3;

// macOS-only View props that react-native's types don't list: a hover tooltip (NSView toolTip).
const tooltip = (text: string) => ({ tooltip: text }) as object;

/**
 * The floating glass tab bar: five icons (Now · Map · Chat · Translate · Scan), no words, each with
 * an accessibility label and a hover tooltip. The selection is a liquid-glass lens that springs
 * from tab to tab and magnifies the icon it passes over, after the iOS 26 tab bar and
 * liquid-glass-studio (github.com/iyinchao/liquid-glass-studio). On macOS 26 the lens is Apple's
 * Liquid Glass laid over the icons, so it really refracts the icon under it; elsewhere it is a
 * brighter glass capsule under the icons (a blur over them would only smear them).
 * 290 px wide (280 below 420 px), so it fits a 390 px window with room on both sides.
 */
export function TabBar({ nav, style }: { nav: Nav; style?: StyleProp<ViewStyle> }) {
  const { width } = useScreenSize();
  const reduce = useReduceMotion();
  const tabW = width < 420 ? 54 : 56;
  const selected = TABS.findIndex(t => t.screen === nav.screen);
  const target = PAD + Math.max(0, selected) * tabW;
  const [hovered, setHovered] = useState<ScreenName>();

  // One value drives the lens (its `left`, a layout prop: AppKit keeps a view's frame, while a
  // translate transform can be reset) and, through it, how much each icon is magnified.
  const lensX = useRef(new Animated.Value(target)).current;
  const glare = useRef(new Animated.Value(GLARE_REST)).current;
  const tint = useSyncExternalStore(subscribeBarTint, readBarTint);
  const first = useRef(true);
  const targetRef = useRef(target);
  targetRef.current = target;
  /** True while the lens springs to a tab (the re-send below must not cut that short). */
  const sliding = useRef(false);

  useEffect(() => {
    if (first.current || reduce) {
      first.current = false;
      sliding.current = false;
      lensX.setValue(target);
      return;
    }
    lensX.stopAnimation();
    // A spring that overshoots a little: the lens sloshes into place like a drop of liquid.
    sliding.current = true;
    Animated.spring(lensX, { toValue: target, useNativeDriver: false, stiffness: 210, damping: 19, mass: 1 }).start(({ finished }) => {
      if (finished) sliding.current = false;
    });
    glare.stopAnimation();
    Animated.sequence([
      Animated.timing(glare, { toValue: 1, duration: 120, useNativeDriver: true }),
      Animated.timing(glare, { toValue: GLARE_REST, duration: 520, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start();
  }, [target, reduce, lensX, glare]);

  // AppKit sets a newly mounted view's layer transform back to identity a run-loop turn later,
  // which would drop the selected icon's magnification: send the values again shortly after mount.
  useEffect(() => {
    const again = () => {
      if (!sliding.current) lensX.setValue(targetRef.current);
    };
    const t1 = setTimeout(again, 90);
    const t2 = setTimeout(again, 400);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [lensX]);

  // Full magnification when the lens sits on a tab, none once it is a tab away.
  const scales = useMemo(
    () => TABS.map((_, i) => lensX.interpolate({ inputRange: [PAD + (i - 1) * tabW, PAD + i * tabW, PAD + (i + 1) * tabW], outputRange: [1, MAGNIFY, 1], extrapolate: 'clamp' })),
    [lensX, tabW],
  );

  // Seen on macOS 26: Liquid Glass laid over the bar's own Liquid Glass samples glass, not the
  // icons, and turns into an opaque grey capsule that hides the selected icon. So the lens sits
  // under the icons everywhere, and the magnification does the "lens" work.
  const lensOnTop = false && hasLiquidGlass;
  const lens = selected >= 0 && <Lens key="lens" x={lensX} tabWidth={tabW} glare={glare} onTop={lensOnTop} />;

  return (
    <View pointerEvents="box-none" style={[{ position: 'absolute', left: 0, right: 0, bottom: TAB_BAR_BOTTOM, alignItems: 'center' }, style]}>
      <Glass kind="clear" radius={999} wash={tint} style={{ flexDirection: 'row', alignItems: 'center', padding: PAD, height: TAB_BAR_HEIGHT }}>
        {!lensOnTop && lens}
        {TABS.map((t, i) => {
          const on = i === selected;
          const go = () => nav.go(t.screen);
          return (
            <Pressable
              key={t.screen}
              accessibilityRole="tab"
              accessibilityLabel={t.label}
              accessibilityState={{ selected: on }}
              onPress={go}
              {...axPress(go)}
              {...tooltip(t.label)}
              onHoverIn={() => setHovered(t.screen)}
              onHoverOut={() => setHovered(h => (h === t.screen ? undefined : h))}
              style={{ width: tabW, height: TAB_H, alignItems: 'center', justifyContent: 'center', borderRadius: TAB_H / 2 }}>
              <Magnified size={ICON} scale={scales[i]}>
                <t.Icon size={ICON} color={on || hovered === t.screen ? dusk.color.white : dusk.color.text2} strokeWidth={on ? 2 : 1.8} />
              </Magnified>
            </Pressable>
          );
        })}
        {lensOnTop && lens}
      </Glass>
    </View>
  );
}

/**
 * Scales its child about the child's centre. The scale sits on a zero-size view at the centre,
 * as TalkScreen's Flipped does: on macOS a layer's anchor is its top-left corner and RCTView
 * re-centres transforms only when it redraws, but a zero-size layer turns about its one point.
 */
function Magnified({ size, scale, children }: { size: number; scale: Animated.AnimatedInterpolation<number>; children: React.ReactNode }) {
  return (
    <View pointerEvents="none" style={{ width: size, height: size }}>
      <Animated.View style={{ position: 'absolute', left: size / 2, top: size / 2, width: 0, height: 0, transformOrigin: 'center', transform: [{ scale }] }}>
        <View style={{ position: 'absolute', left: -size / 2, top: -size / 2, width: size, height: size }}>{children}</View>
      </Animated.View>
    </View>
  );
}

/**
 * The selection lens: a glass capsule a little wider than one tab, with a glare after
 * liquid-glass-studio's fragment shader: light concentrated in the rim, brightest at the top-left
 * (its 45° glare angle), weaker on the far side, and faint colour fringes at the two ends where
 * the edge disperses light.
 */
function Lens({ x, tabWidth, glare, onTop }: { x: Animated.Value; tabWidth: number; glare: Animated.Value; onTop: boolean }) {
  const h = TAB_H;
  const width = tabWidth + LENS_OUT * 2;
  // Its ends stay inside the bar's rounded ends, even on the first and last tab.
  const left = useRef(Animated.add(x, -LENS_OUT)).current;
  return (
    <Animated.View pointerEvents="none" style={{ position: 'absolute', left, top: PAD, width, height: h }}>
      {/* Over the icons it must stay clear; under them it can be the brighter, prominent glass. */}
      <Glass kind={onTop ? 'clear' : 'prominent'} radius={h / 2} blur={onTop} tint={onTop ? white(0.06) : undefined} style={{ width, height: h }} />
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: glare }]}>
        <Glare width={width} height={h} />
      </Animated.View>
    </Animated.View>
  );
}

/** The lens's highlights, drawn once at its fixed size (SVG on macOS keeps its first drawing). */
function Glare({ width, height }: { width: number; height: number }) {
  const id = useId().replace(/:/g, '');
  const r = height / 2;
  return (
    <Svg key={`${width}x${height}`} width={width} height={height} style={StyleSheet.absoluteFill}>
      <Defs>
        {/* The rim: bright at the top-left, dim across the middle, a weaker glint bottom-right. */}
        <SvgLinearGradient id={`${id}rim`} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={dusk.color.white} stopOpacity={0.95} />
          <Stop offset="0.3" stopColor={dusk.color.white} stopOpacity={0.18} />
          <Stop offset="0.62" stopColor={dusk.color.white} stopOpacity={0.06} />
          <Stop offset="1" stopColor={dusk.color.white} stopOpacity={0.55} />
        </SvgLinearGradient>
        {/* Dispersion at the ends: cyan on the left, warm magenta on the right. */}
        <SvgLinearGradient id={`${id}chroma`} x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor={dusk.color.fringeCool} stopOpacity={0.5} />
          <Stop offset="0.2" stopColor={dusk.color.fringeCool} stopOpacity={0} />
          <Stop offset="0.8" stopColor={dusk.color.fringePink} stopOpacity={0} />
          <Stop offset="1" stopColor={dusk.color.fringeWarm} stopOpacity={0.45} />
        </SvgLinearGradient>
        {/* A soft sheen across the top third, as light caught by the lens's curved face. */}
        <RadialGradient id={`${id}sheen`} cx="38%" cy="8%" rx="62%" ry="55%">
          <Stop offset="0" stopColor={dusk.color.white} stopOpacity={0.22} />
          <Stop offset="1" stopColor={dusk.color.white} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x={0} y={0} width={width} height={height} rx={r} fill={`url(#${id}sheen)`} />
      <Rect x={1.6} y={1.6} width={width - 3.2} height={height - 3.2} rx={r - 1.6} fill="none" stroke={`url(#${id}chroma)`} strokeWidth={1.4} />
      <Rect x={0.6} y={0.6} width={width - 1.2} height={height - 1.2} rx={r - 0.6} fill="none" stroke={`url(#${id}rim)`} strokeWidth={1.2} />
    </Svg>
  );
}
