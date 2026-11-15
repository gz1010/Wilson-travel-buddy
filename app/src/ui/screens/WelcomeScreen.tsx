import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { AmbientBackdrop } from '../dusk/AmbientBackdrop';
import { Glass, GlassButton, OfflineChip } from '../dusk/Glass';
import { useBox } from '../dusk/Gradient';
import { useReduceMotion } from '../dusk/motion';
import { GlassWord, glassWordSink, glassWordSize, glassWordVisible } from '../dusk/GlassWord';
import { LiquidGlass } from '../dusk/LiquidGlass';
import { tidyModel } from '../dusk/modelNames';
import { HeroPhoto, PhotoFade } from '../dusk/Photos';
import { heroPhotos } from '../../pack/seville/photos';
import { dusk, font, typeStyle, white } from '../dusk/tokens';
import type { WelcomeProps } from './types';
import { useScreenSize } from '../dusk/Screen';

// AntWelcome: the city at dusk with "Welcome to <city>" in liquid-glass letters across the bottom
// of the photo, a line on what the guide is, what was prepared, a glass panel with the on-device
// models getting ready, and Get started. One column: the photo card takes whatever height the
// text, the panel and the button leave, so it fits any window from 390 × 700 up. Everything below
// the card has a fixed height (the status line keeps two lines' room), so the card, and the glass
// letters drawn at its size, never move while the models connect.

const W = dusk.layout.phoneWidth;

type Step = WelcomeProps['steps'][number];

/** The photo card starts below the window's traffic lights and runs nearly edge to edge. */
const CARD_TOP = 44;
const CARD_INSET = 14;
/** Share of the city name's capital height sunk below the card's edge: three quarters show. */
const CITY_CUT = 0.25;
/** Dark behind the chip at the top and behind the letters at the bottom. */
const WELCOME_FADE: [number, number][] = [
  [0, 0.32],
  [0.2, 0],
  [0.5, 0],
  [0.78, 0.3],
  [1, 0.6],
];
/** Under the Offline chip, the letters need this much of the card to stay clear of it. */
const CHIP_ROOM = 56;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NBSP = '\u00A0';

/**
 * "Seville guide prepared Nov 14 · 60 places · 247 facts · 62 photos", from prepared.json, or how to
 * prepare it. The date is the preparer's own calendar day, read straight from the ISO string.
 * Photos count the place photos and the time-of-day city photos together.
 */
export function preparedLine(city: string, p: NonNullable<WelcomeProps['prepared']>): string {
  const m = p.preparedAt ? /^(\d{4})-(\d{2})-(\d{2})/.exec(p.preparedAt) : null;
  if (!m) return 'Not prepared yet: run node scripts/prepare-pack.mjs while online';
  const day = `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
  const photos = p.photos + (p.heroes ?? 0);
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  return `${city} guide prepared ${day} · ${n(p.places, 'place')} · ${n(p.facts, 'fact')} · ${n(photos, 'photo')}`;
}

/** The prepared line, allowed to break only after the date, so a narrow screen shows the counts together. */
function wrapAfterDate(line: string): string {
  const cut = line.indexOf(' · ');
  if (cut < 0 || !/ prepared /.test(line)) return line;
  const keep = (s: string) => s.replace(/ /g, NBSP);
  return `${keep(line.slice(0, cut))}${NBSP}· ${keep(line.slice(cut + 3))}`;
}

/** "3 of 4 ready" over the panel; "Ready" once everything is. */
function readyCount(steps: Step[]): string {
  const n = steps.filter(s => s.state === 'ready').length;
  return n === steps.length ? 'Ready' : `${n} of ${steps.length} ready`;
}

export function WelcomeScreen({ city, steps, status, models, ready, onStart, prepared }: WelcomeProps) {
  const { width } = useScreenSize();
  const sx = width / W;
  const preparedText = prepared ? preparedLine(city, prepared) : undefined;
  const card = useBox();

  // The city name as large as fits across the card (and, on a short window, under the chip), with
  // "Welcome to" above it at about a third of its size.
  const inset = Math.round(CARD_INSET * sx);
  const cardW = width - 2 * inset;
  // Height the letters take per px of the city's size: the visible three quarters, the gap, the lead line.
  const perPx = glassWordVisible(1, CITY_CUT) + 0.08 + 0.36 * 1.2;
  const byHeight = card.size ? Math.max(40, (card.size.height - CHIP_ROOM) / perPx) : Infinity;
  const word = glassWordSize(city, cardW - 24, Math.min(150 * sx, byHeight));
  const lead = Math.round(word * 0.36);
  const wordShows = glassWordVisible(word, CITY_CUT);
  const leadBottom = wordShows + Math.round(word * 0.08);

  const side = Math.round(22 * sx);
  return (
    <View style={styles.root}>
      {/* The same dusk photo, blurred and darkened behind everything, so the panel and the button
          are glass over colour rather than over black. */}
      <AmbientBackdrop source={heroPhotos.dusk} strength={0.8} />
      <View style={[styles.card, { marginHorizontal: inset }]} onLayout={card.onLayout}>
        <HeroPhoto tod="dusk" style={StyleSheet.absoluteFill} />
        <PhotoFade stops={WELCOME_FADE} />
        {/* The photo again with the welcome in 3D liquid glass (WebGL); the SVG letters show until it has drawn. */}
        <LiquidGlass
          photo={heroPhotos.dusk}
          lines={[
            { text: 'Welcome to', size: lead, baseline: leadBottom },
            { text: city, size: word, baseline: -glassWordSink(word, CITY_CUT) },
          ]}
          fade={WELCOME_FADE}
          interactive
          fallback={
            <View style={[styles.titleBox, { height: leadBottom + lead * 1.2 }]}>
              <View style={{ position: 'absolute', left: 0, right: 0, bottom: leadBottom, height: lead * 1.2 }}>
                <GlassWord text="Welcome to" size={lead} label={null} />
              </View>
              <GlassWord text={city} size={word} cut={CITY_CUT} label={null} />
            </View>
          }
        />
        <View style={styles.chipRow} pointerEvents="none">
          <OfflineChip />
        </View>
        <View
          pointerEvents="none"
          style={[styles.titleBox, { height: leadBottom + lead * 1.2 }]}
          accessible
          accessibilityRole="header"
          accessibilityLabel={`Welcome to ${city}`}
        />
      </View>

      <View style={[styles.intro, { paddingHorizontal: Math.round(28 * sx) }]}>
        <Text style={[styles.subtitle, { maxWidth: 320 * sx }]}>{`All of ${city} on this Mac, and a guide that never needs a signal.`}</Text>
        {preparedText ? (
          <Text numberOfLines={2} style={[styles.prepared, { maxWidth: 330 * sx }]} accessibilityLabel={preparedText}>
            {wrapAfterDate(preparedText)}
          </Text>
        ) : null}
      </View>

      <Glass kind="clear" radius={24} style={[styles.panel, { marginHorizontal: side }]}>
        <View style={styles.panelHead}>
          <Text style={styles.panelLabel} accessibilityRole="header">
            On device
          </Text>
          {steps.length > 0 ? <Text style={styles.panelCount}>{readyCount(steps)}</Text> : null}
        </View>
        {steps.length > 0 ? (
          <View accessible accessibilityLabel={`Getting ready: ${steps.map(describe).join(', ')}`} style={styles.grid}>
            {steps.map(s => (
              <View key={s.label} style={styles.cell}>
                <StepDot state={s.state} />
                <Text numberOfLines={1} style={[styles.cellText, s.state === 'off' && styles.cellOff]}>
                  {s.state === 'off' ? `${s.label} (off)` : s.label}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        <View style={styles.rule} />
        {/* While connecting: the latest status. Once ready: every on-device model by name. */}
        <View style={styles.footer}>
          {!ready ? (
            <Text numberOfLines={2} style={styles.status} accessibilityLiveRegion="polite">
              {status}
            </Text>
          ) : models && models.length > 0 ? (
            <Text numberOfLines={2} style={styles.status} accessibilityLabel={`On this Mac: ${models.join(', ')}`}>
              {/* "(Argmax)" once at the end rather than after every audio model, so the line fits. */}
              {models.map(m => tidyModel(m).replace(/\s*\(Argmax\)$/, '')).join(' · ')}
              {models.some(m => /\(Argmax\)$/.test(m)) ? ' · Argmax' : ''}
            </Text>
          ) : null}
        </View>
      </Glass>

      <View style={[styles.buttonRow, { paddingHorizontal: side }]}>
        <GlassButton
          label="Get started"
          onPress={onStart}
          disabled={!ready}
          accessibilityLabel={ready ? 'Get started' : 'Get started, available once the models are ready'}
          style={styles.button}
          textStyle={styles.buttonText}
        />
      </View>
    </View>
  );
}

function describe(s: Step): string {
  return `${s.label} ${s.state === 'ready' ? 'ready' : s.state === 'loading' ? 'loading' : 'off'}`;
}

/** Ready: a solid glowing white dot. Loading: a ring that pulses. Off: a hollow, dim ring. */
function StepDot({ state }: { state: Step['state'] }) {
  const reduce = useReduceMotion();
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (state !== 'loading' || reduce) {
      pulse.stopAnimation();
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [state, reduce, pulse]);

  if (state === 'ready') return <View style={styles.dotReady} />;
  if (state === 'off') return <View style={[styles.ring, { borderColor: white(0.4) }]} />;
  const scale = pulse.interpolate({ inputRange: [0.35, 1], outputRange: [0.8, 1] });
  return <Animated.View style={[styles.ring, { opacity: pulse, transform: [{ scale }] }]} />;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: dusk.color.ground, overflow: 'hidden', paddingTop: CARD_TOP, paddingBottom: 26 },
  card: {
    flex: 1,
    minHeight: 180,
    borderRadius: 32,
    overflow: 'hidden',
    backgroundColor: dusk.color.raised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: white(0.12),
  },
  chipRow: { position: 'absolute', top: 14, left: 0, right: 0, alignItems: 'center' },
  titleBox: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  intro: { marginTop: 18, alignItems: 'center' },
  subtitle: { ...typeStyle('callout'), fontSize: 17, lineHeight: 23, color: dusk.color.textSoft, textAlign: 'center' },
  prepared: { ...typeStyle('caption'), marginTop: 8, color: dusk.color.text2, textAlign: 'center', fontVariant: ['tabular-nums'] },
  panel: { marginTop: 20, paddingTop: 13, paddingBottom: 10, paddingHorizontal: 16 },
  panelHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 11 },
  panelLabel: { ...typeStyle('label'), color: dusk.color.text2 },
  panelCount: { ...typeStyle('caption'), color: dusk.color.text2, fontVariant: ['tabular-nums'] },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 10, columnGap: 14 },
  // Two columns: half the row minus half the 14 px column gap.
  cell: { width: '47%', flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 18 },
  cellText: { ...typeStyle('body'), ...font('600'), fontSize: 14, lineHeight: 18, color: dusk.color.text, flexShrink: 1 },
  cellOff: { color: dusk.color.text2 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: white(0.14), marginTop: 12, marginBottom: 8 },
  // Two lines' room whatever the status says, so nothing above it moves.
  footer: { height: 32, justifyContent: 'center' },
  status: { ...typeStyle('caption'), color: dusk.color.text2, textAlign: 'center' },
  dotReady: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: dusk.color.white,
    shadowColor: dusk.color.white,
    shadowOpacity: 0.6,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 0 },
  },
  ring: { width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: white(0.75) },
  buttonRow: { marginTop: 16, alignItems: 'center' },
  button: { width: '100%', maxWidth: 380 },
  buttonText: { fontSize: 17, letterSpacing: -0.2 },
});
