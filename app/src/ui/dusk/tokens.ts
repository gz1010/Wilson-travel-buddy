// Dusk · liquid glass: design tokens, from the "Dusk · Antigua photos" canvas.
// No accent colour and no gold: a selected or primary thing is brighter glass.
//
// Type is Apple's system font, SF Pro: font() and typeStyle() ask for the 'System' family by weight,
// and macOS picks the optical size (Text below 20 pt, Display above) and its tracking from the
// point size. The bundled Manrope files are no longer used by the UI.
// Colours: every text colour passes WCAG AA (4.5:1) on clear glass over a darkened photo, measured
// against #3C3B40 ("mid glass": the glass and fade over the brightest parts of the pack's photos),
// and stays in the warm Dusk palette. Ratios below are against the ground / mid glass.

import type { TextStyle } from 'react-native';

export const dusk = {
  color: {
    ground: '#0E0F14',
    raised: '#1A1B22',
    /** Primary text: 17:1 / 9.9:1. */
    text: '#F5F1EA',
    /** Secondary text (captions, hints, the off state): 11.6:1 / 6.7:1 (was #B9B0A6, 5.2:1 on mid glass). */
    text2: '#D0C8BE',
    /** Body text a step below primary (subtitles, summaries): 15:1 / 8.7:1. */
    textSoft: '#EAE3DA',
    /** Not yet said or not yet answered (placeholders, streaming): 8:1 / 4.7:1 (was #6E6A70, 2.1:1). */
    pending: '#ABA6AE',
    you: '#8FB8FF',
    /** The cool white of distance and direction lines (AntPlace). */
    direction: '#DCE6F5',
    white: '#FFFFFF',
    /** Colour fringes where a glass edge disperses light (the tab bar's lens): cool, pink, warm. */
    fringeCool: '#7FE3FF',
    fringePink: '#FF8FD8',
    fringeWarm: '#FF9F7A',
  },
  map: {
    background: '#12141B',
    streets: '#2B2F3B',
    buildings: '#1B1E27',
    parks: '#17221D',
    water: '#1A2632',
    label: '#7A7F92',
  },
  font: {
    /** RCTFont maps 'System' plus a weight to SF Pro (NSFont systemFontOfSize:weight:). */
    family: 'System',
    // Weights by role, as font() takes them (it maps them to SF Pro weights).
    clock: { size: 64, weight: '300' as const, letterSpacing: -1.6 },
    welcome: { size: 54, weight: '300' as const, letterSpacing: -1.4 },
    translation: { min: 32, max: 38, weight: '300' as const },
    transcript: { size: 27, weight: '300' as const },
    title: { min: 40, max: 44, weight: '600' as const },
    body: { min: 14, max: 15, weight: '500' as const },
    /** Small capitals over sections: SF Pro Semibold, tracked +0.07 em. */
    label: { size: 11, weight: '700' as const, letterSpacing: 0.8 },
    /**
     * Place names in glass letters (SF Pro Heavy, GlassWord and the WebGL page) and on the map card,
     * tightened a little (glassWordEm and the WebGL page both apply this tracking).
     */
    placeName: { weight: '800' as const, tracking: -0.022 }, // em, multiply by size
  },
  radius: { card: 28, sheet: 30, pill: 999 },
  size: { button: 54, buttonSmall: 50, touch: 44, tabBar: 58, orb: 46, micOrb: 80 },
  motion: { heroFade: 600, replan: 240, selectScale: 1.04 },
  layout: { phoneWidth: 390, phoneHeight: 844, heroHeight: 330, placeHeroHeight: 470, cardHeight: 140 },
};

/** The three glass materials. Gradients run at 135°; numbers are white opacities. */
export const glass = {
  clear: { from: 0.16, to: 0.04, border: 0.24, highlight: 0.6, blur: 10, red: 0.14, blue: 0.16, shadow: 0.4 },
  prominent: { from: 0.46, to: 0.16, border: 0.58, highlight: 1, blur: 10, red: 0.24, blue: 0.26, shadow: 0.35 },
  orb: { stops: [0.8, 0.28, 0.1, 0.2], border: 0.5, highlight: 0.95, blur: 10, red: 0.22, blue: 0.24, shadow: 0.35 },
} as const;

export type GlassKind = keyof typeof glass;

/** Drawn scene tiles for places without a photo: ground colour, then shape colours. */
export const sceneColors = {
  arches: { ground: '#2D4A63', back: '#3E6587', front: '#5C86A8' },
  awnings: { ground: '#5A3A2A', back: '#6B4430', front: '#7A4E36' },
  cup: { ground: '#3F3A2B', back: '#4E4733', front: '#5E563D' },
  tower: { ground: '#3D2F45', back: '#4C3B56', front: '#6D5577' },
  river: { ground: '#1F3D44', back: '#2E5A63', front: '#5B8E98' },
} as const;

/** The weights screens ask font() for (named after the old Manrope files). */
export type FontWeight = '300' | '400' | '500' | '600' | '700' | '800';
type SFWeight = '200' | '300' | '400' | '500' | '600' | '700' | '800';

/**
 * SF Pro is denser than Manrope at the same weight (taller x-height, heavier strokes), so each
 * weight the screens ask for lands one step lighter: body text is Regular, emphasis Medium, chips
 * and titles Semibold, the heaviest labels and buttons Bold. Light stays Light for big numbers.
 */
const SF_WEIGHT: Record<FontWeight, SFWeight> = {
  '300': '300',
  '400': '400',
  '500': '400',
  '600': '500',
  '700': '600',
  '800': '700',
};

/** The system font (SF Pro) at the weight for this role. Set fontSize (and lineHeight) after it. */
export const font = (weight: FontWeight) => ({ fontFamily: dusk.font.family, fontWeight: SF_WEIGHT[weight] });

/**
 * The type scale, after Apple's text styles for a phone: sizes and line heights in px, weights
 * as SF Pro weights, tracking in px (left out where SF Pro's own size-specific tracking is right).
 */
export const typeScale = {
  /** Big titles over photos (a place's name). */
  display: { size: 40, lineHeight: 44, weight: '700' as SFWeight, tracking: -0.8 },
  /** Screen and card titles. */
  title: { size: 26, lineHeight: 31, weight: '700' as SFWeight, tracking: -0.4 },
  /** A line that leads a group: a card's heading, a button. */
  headline: { size: 17, lineHeight: 22, weight: '600' as SFWeight },
  /** An introduction or a spoken line: a little larger than body. */
  callout: { size: 16, lineHeight: 22, weight: '400' as SFWeight },
  /** Reading text. */
  body: { size: 15, lineHeight: 21, weight: '400' as SFWeight },
  /** Secondary lines: counts, sources, model names, hints. */
  caption: { size: 12, lineHeight: 16, weight: '500' as SFWeight },
  /** Small capitals over a section. */
  label: { size: 11, lineHeight: 14, weight: '600' as SFWeight, tracking: 0.8, caps: true },
} as const;

export type TypeRole = keyof typeof typeScale;

/** A complete text style for a role in the type scale; colour is left to the caller. */
export function typeStyle(role: TypeRole): TextStyle {
  const t: { size: number; lineHeight: number; weight: SFWeight; tracking?: number; caps?: boolean } = typeScale[role];
  return {
    fontFamily: dusk.font.family,
    fontWeight: t.weight,
    fontSize: t.size,
    lineHeight: t.lineHeight,
    ...(t.tracking !== undefined ? { letterSpacing: t.tracking } : null),
    ...(t.caps ? { textTransform: 'uppercase' as const } : null),
  };
}

export const white = (a: number) => `rgba(255,255,255,${a})`;
export const ground = (a: number) => `rgba(14,15,20,${a})`;
