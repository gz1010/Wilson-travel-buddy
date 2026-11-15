import React, { createContext, useContext, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { dusk } from './tokens';

// The size of the app's own window content. React Native's useWindowDimensions() reports the whole
// display on macOS, not the window, which pushed every scaled position off to the right; this reads
// the real size from the root view's layout instead.
const ScreenSize = createContext({ width: dusk.layout.phoneWidth, height: dusk.layout.phoneHeight });

export function ScreenSizeProvider({ style, onStartShouldSetResponderCapture, children }: { style?: StyleProp<ViewStyle>; onStartShouldSetResponderCapture?: () => boolean; children: React.ReactNode }) {
  const [size, setSize] = useState({ width: dusk.layout.phoneWidth, height: dusk.layout.phoneHeight });
  return (
    <View
      style={[{ flex: 1 }, style]}
      onStartShouldSetResponderCapture={onStartShouldSetResponderCapture}
      onLayout={e => {
        const { width, height } = e.nativeEvent.layout;
        if (width > 0 && height > 0 && (width !== size.width || height !== size.height)) setSize({ width, height });
      }}>
      <ScreenSize.Provider value={size}>{children}</ScreenSize.Provider>
    </View>
  );
}

/** Width and height of the app's window content (use instead of useWindowDimensions). */
export function useScreenSize(): { width: number; height: number } {
  return useContext(ScreenSize);
}
