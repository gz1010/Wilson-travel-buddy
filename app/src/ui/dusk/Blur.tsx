import React from 'react';
import { requireNativeComponent, UIManager, View, type StyleProp, type ViewStyle } from 'react-native';

// BuddyGlassView (app/macos/TravelBuddy-macOS/AppDelegate.mm): Apple's Liquid Glass on macOS 26,
// a light native blur on older macOS. Without the native view (another platform, an old build),
// a faint translucent fill stands in.
type NativeProps = {
  style?: StyleProp<ViewStyle>;
  cornerRadius?: number;
  glassStyle?: 'clear' | 'regular';
  /** Any CSS colour; processed to a native colour by the view config (the prop's type is UIColor). */
  tintColor?: string;
};
type Config = { Constants?: { liquidGlass?: boolean }; NativeProps?: Record<string, unknown> };
const config = UIManager.getViewManagerConfig?.('BuddyGlassView') as Config | undefined;
const NativeGlass = config ? requireNativeComponent<NativeProps>('BuddyGlassView') : undefined;

/** True on macOS 26+, where the native view is Apple's Liquid Glass with its own rim and refraction. */
export const hasLiquidGlass = !!config?.Constants?.liquidGlass;

/**
 * True when this build's native glass takes a tint: NSGlassEffectView's tintColor on macOS 26, a
 * coloured layer over the blur on older macOS. An app built before the prop existed (JS hot-loaded
 * onto an older binary) reports false, and Glass draws the tint in JS instead.
 */
export const hasNativeTint = !!NativeGlass && !!config?.NativeProps && 'tintColor' in config.NativeProps;

export function GlassBackdrop({
  style,
  radius,
  variant,
  tint,
}: {
  style?: StyleProp<ViewStyle>;
  radius: number;
  variant: 'clear' | 'regular';
  /** A CSS colour (with alpha) the glass leans toward; used only where hasNativeTint. */
  tint?: string;
}) {
  return NativeGlass ? (
    <NativeGlass style={style} cornerRadius={radius} glassStyle={variant} {...(hasNativeTint ? { tintColor: tint } : null)} />
  ) : (
    <View style={[style, { backgroundColor: 'rgba(26,27,34,0.35)' }]} />
  );
}
