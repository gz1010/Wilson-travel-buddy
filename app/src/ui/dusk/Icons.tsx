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
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14" />
  </Svg>
);

export const WaveIcon = ({ size = 14, color = '#fff', strokeWidth = 2 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round">
    <Path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
  </Svg>
);

/**
 * An arrow pointing to a compass bearing (0 = north, up). The SVG turns the path itself: on macOS
 * AppKit resets a view's layer transform, so a `transform` style on the Svg view is lost.
 */
export const ArrowIcon = ({ size = 30, color = '#fff', strokeWidth = 2, bearing = 0 }: IconProps & { bearing?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round">
    <Path d="M12 3v18M12 3l-5 5M12 3l5 5" transform={bearing ? `rotate(${bearing} 12 12)` : undefined} />
  </Svg>
);

export const SearchIcon = ({ size = 16, color = '#fff', strokeWidth = 2 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round">
    <Path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" />
  </Svg>
);

// Tab bar icons (Nav.tsx): the same 24-unit grid, round caps and joins, a little lighter than the
// buttons' icons so five of them sit quietly in the bar.

/** Now: a sun whose disc is a clock (what to do at this hour). */
export const NowIcon = ({ size = 22, color = '#fff', strokeWidth = 1.8 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M12 5.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM12 9v3.2l2.2 1.4" />
    <Path d="M12 1.8v1.2M12 21v1.2M1.8 12H3M21 12h1.2M4.8 4.8l.85.85M18.35 18.35l.85.85M4.8 19.2l.85-.85M18.35 5.65l.85-.85" />
  </Svg>
);

/** Chat: a round speech bubble with three dots (voice mode and typed chat). */
export const ChatIcon = ({ size = 22, color = '#fff', strokeWidth = 1.8 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M12 3.5c4.7 0 8.5 3.4 8.5 7.7s-3.8 7.7-8.5 7.7c-1 0-2-.15-2.9-.45L4.5 20l1.2-3.6C4.4 15 3.5 13.2 3.5 11.2 3.5 6.9 7.3 3.5 12 3.5z" />
    <Path d="M8.4 11.3h.01M12 11.3h.01M15.6 11.3h.01" strokeWidth={strokeWidth * 1.45} />
  </Svg>
);

/** Translate: a character on the left, a Latin A on the right. */
export const TranslateIcon = ({ size = 22, color = '#fff', strokeWidth = 1.8 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M2.8 5.5h10M7.8 3v2.5M10.6 5.5c-.7 3.9-3 7-6.8 8.9M5.6 8.6c1.1 2.2 2.8 3.9 5.2 5.1" />
    <Path d="M12.6 21l4.1-9.2 4.1 9.2M14.1 17.8h5.2" />
  </Svg>
);

/** Scan: a viewfinder's four corners around a lens (what the camera sees). */
export const ScanIcon = ({ size = 22, color = '#fff', strokeWidth = 1.8 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M3.5 8V6.2a2.7 2.7 0 0 1 2.7-2.7H8M16 3.5h1.8a2.7 2.7 0 0 1 2.7 2.7V8M20.5 16v1.8a2.7 2.7 0 0 1-2.7 2.7H16M8 20.5H6.2a2.7 2.7 0 0 1-2.7-2.7V16" />
    <Path d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z" />
  </Svg>
);
