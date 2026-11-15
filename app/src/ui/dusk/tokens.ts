// Dusk · liquid glass: design tokens, from the "Dusk · Antigua photos" canvas.
// No accent colour and no gold: a selected or primary thing is brighter glass.

export const dusk = {
  color: {
    ground: '#0E0F14',
    raised: '#1A1B22',
    text: '#F4EFE8',
    text2: '#B9B0A6',
    textSoft: '#E4DCD2',
    pending: '#6E6A70',
    you: '#8FB8FF',
    white: '#FFFFFF',
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
    family: 'Manrope',
    // Weights by role.
    clock: { size: 64, weight: '300' as const, letterSpacing: -3.2 },
    welcome: { size: 54, weight: '300' as const, letterSpacing: -2.4 },
    translation: { min: 32, max: 38, weight: '300' as const },
    transcript: { size: 27, weight: '300' as const },
    title: { min: 40, max: 44, weight: '600' as const },
    body: { min: 14, max: 15, weight: '500' as const },
    label: { size: 11, weight: '800' as const, letterSpacing: 1.3 }, // 0.12em
    placeName: { weight: '800' as const, tracking: -0.055 }, // em, multiply by size
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

/** Manrope by weight: iOS resolves the PostScript name of each bundled file reliably. */
const MANROPE: Record<string, string> = {
  '300': 'Manrope-Light',
  '400': 'Manrope-Regular',
  '500': 'Manrope-Medium',
  '600': 'Manrope-SemiBold',
  '700': 'Manrope-Bold',
  '800': 'Manrope-ExtraBold',
};
export const font = (weight: '300' | '400' | '500' | '600' | '700' | '800') => ({ fontFamily: MANROPE[weight] });

export const white = (a: number) => `rgba(255,255,255,${a})`;
export const ground = (a: number) => `rgba(14,15,20,${a})`;
