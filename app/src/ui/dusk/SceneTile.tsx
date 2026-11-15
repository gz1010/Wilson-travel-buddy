import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, G, Path, Rect } from 'react-native-svg';
import type { Scene } from '../../core/look';
import { sceneColors } from './tokens';

/**
 * The two-tone drawn scene a place gets when the pack has no photo for it (Dusk design system,
 * "Scene tiles"): arches, awnings, cup, tower or river. Fills its box, cropped like a cover photo.
 */
export function SceneTile({ scene, style }: { scene: Scene; style?: StyleProp<ViewStyle> }) {
  const c = sceneColors[scene];
  return (
    <View style={[{ backgroundColor: c.ground, overflow: 'hidden' }, style]}>
      <Svg width="100%" height="100%" viewBox="0 0 220 110" preserveAspectRatio="xMidYMid slice">
        {scene === 'arches' && (
          <>
            <Path d="M0 70 C60 58 120 66 220 60 L220 110 L0 110 Z" fill={c.back} />
            <G fill={c.front}>
              <Path d="M16 110 L16 80 A18 18 0 0 1 52 80 L52 110 Z" />
              <Path d="M92 110 L92 80 A18 18 0 0 1 128 80 L128 110 Z" />
              <Path d="M168 110 L168 80 A18 18 0 0 1 204 80 L204 110 Z" />
            </G>
          </>
        )}
        {scene === 'awnings' && (
          <>
            <G fill={c.front}>
              <Path d="M0 58 L36 38 L72 58 Z" />
              <Path d="M74 58 L110 38 L146 58 Z" />
              <Path d="M148 58 L184 38 L220 58 Z" />
            </G>
            <Rect x="0" y="58" width="220" height="52" fill={c.back} />
          </>
        )}
        {scene === 'cup' && (
          <>
            <Circle cx="170" cy="36" r="22" fill={c.front} />
            <Rect x="0" y="84" width="220" height="26" fill={c.back} />
            <Path d="M60 84 L63 60 L95 60 L98 84 Z" fill={c.front} />
            <Path d="M96 65 C108 65 108 78 96 78" fill="none" stroke={c.front} strokeWidth={4} />
          </>
        )}
        {scene === 'tower' && (
          <>
            <Rect x="0" y="84" width="220" height="26" fill={c.back} />
            <Path d="M150 84 L150 30 L155 30 L155 20 L160 12 L165 20 L165 30 L170 30 L170 84 Z" fill={c.front} />
            <Path d="M70 84 L70 66 C78 54 98 54 106 66 L106 84 Z" fill={c.front} />
          </>
        )}
        {scene === 'river' && (
          <>
            <Path d="M0 66 C50 56 100 76 150 66 C190 58 210 70 220 66 L220 110 L0 110 Z" fill={c.back} />
            <Path d="M0 88 C50 78 100 98 150 88 C190 80 210 92 220 88" fill="none" stroke={c.front} strokeWidth={3} />
          </>
        )}
      </Svg>
    </View>
  );
}
