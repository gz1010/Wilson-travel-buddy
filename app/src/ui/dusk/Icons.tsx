import React from 'react';
import Svg, { Path, Rect } from 'react-native-svg';

// Stroke icons from the Dusk canvas. Decorative: the button around them carries the label.
type IconProps = { size?: number; color?: string; strokeWidth?: number };

export const MicIcon = ({ size = 20, color = '#fff', strokeWidth = 2.2 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round">
    <Rect x="9" y="3" width="6" height="12" rx="3" />
    <Path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Svg>
);

export const CloseIcon = ({ size = 14, color = '#fff', strokeWidth = 2.4 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round">
    <Path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const MapIcon = ({ size = 20, color = '#fff', strokeWidth = 1.8 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round">
    <Path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14" />
  </Svg>
);

export const WaveIcon = ({ size = 14, color = '#fff', strokeWidth = 2 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round">
    <Path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
  </Svg>
);

/** An arrow pointing to a compass bearing (0 = north, up). */
export const ArrowIcon = ({ size = 30, color = '#fff', strokeWidth = 2, bearing = 0 }: IconProps & { bearing?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" style={{ transform: [{ rotate: `${bearing}deg` }] }}>
    <Path d="M12 3v18M12 3l-5 5M12 3l5 5" />
  </Svg>
);

export const SearchIcon = ({ size = 16, color = '#fff', strokeWidth = 2 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round">
    <Path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" />
  </Svg>
);
