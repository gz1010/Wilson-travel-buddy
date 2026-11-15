import React from 'react';
import { requireNativeComponent, UIManager, View, type StyleProp, type ViewStyle } from 'react-native';
import { dusk } from './tokens';

// The Mac's own blur (NSVisualEffectView), registered as BuddyBlurView in
// app/macos/TravelBuddy-macOS/AppDelegate.mm. If the native view is missing (an older build),
// a dark translucent fill stands in so the glass still reads.
const hasNative = !!UIManager.getViewManagerConfig?.('BuddyBlurView');
const NativeBlur = hasNative ? requireNativeComponent<{ style?: StyleProp<ViewStyle> }>('BuddyBlurView') : undefined;

export function Blur({ style }: { style?: StyleProp<ViewStyle> }) {
  return NativeBlur ? <NativeBlur style={style} /> : <View style={[style, { backgroundColor: 'rgba(26,27,34,0.55)' }]} />;
}

export const blurIsNative = hasNative;
export const blurFallbackColor = dusk.color.raised;
