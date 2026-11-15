import React from 'react';
import { requireNativeComponent, UIManager, View, type StyleProp, type ViewStyle } from 'react-native';

// BuddyGlassView (app/macos/TravelBuddy-macOS/AppDelegate.mm): Apple's Liquid Glass on macOS 26,
// a light native blur on older macOS. Without the native view (another platform, an old build),
// a faint translucent fill stands in.
type NativeProps = { style?: StyleProp<ViewStyle>; cornerRadius?: number; glassStyle?: 'clear' | 'regular' };
const config = UIManager.getViewManagerConfig?.('BuddyGlassView') as { Constants?: { liquidGlass?: boolean } } | undefined;
const NativeGlass = config ? requireNativeComponent<NativeProps>('BuddyGlassView') : undefined;

/** True on macOS 26+, where the native view is Apple's Liquid Glass with its own rim and refraction. */
export const hasLiquidGlass = !!config?.Constants?.liquidGlass;

export function GlassBackdrop({ style, radius, variant }: { style?: StyleProp<ViewStyle>; radius: number; variant: 'clear' | 'regular' }) {
  return NativeGlass ? (
    <NativeGlass style={style} cornerRadius={radius} glassStyle={variant} />
  ) : (
    <View style={[style, { backgroundColor: 'rgba(26,27,34,0.35)' }]} />
  );
}
