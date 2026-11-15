import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { Glass, GlassButton, OfflineChip } from '../dusk/Glass';
import { useReduceMotion } from '../dusk/motion';
import { GlassWord, glassWordSink, glassWordSize, glassWordVisible } from '../dusk/GlassWord';
import { LiquidGlass } from '../dusk/LiquidGlass';
import { HeroPhoto, PhotoFade } from '../dusk/Photos';
import { heroPhotos } from '../../pack/seville/photos';
import { dusk, font, white } from '../dusk/tokens';
import type { WelcomeProps } from './types';
import { useScreenSize } from '../dusk/Screen';

// AntWelcome: the city at dusk, a welcome, and the on-device models getting ready on clear glass.
// Positions come from the 390 × 844 mockup: horizontal ones scale with the width, and the lower
// block (title, models, button) keeps its distance from the bottom so it fits any phone height.

const W = dusk.layout.phoneWidth;
const H = dusk.layout.phoneHeight;

type Step = WelcomeProps['steps'][number];

/** Room the prepared line takes under the subtitle (up to two 15 px lines and its margin). */
const PREPARED_ROOM = 36;
/** The subtitle: up to two 22 px lines. */
const SUBTITLE_ROOM = 44;
/** Between the text under the card and the glass grid of models. */
const TEXT_GAP = 16;
/** Between the photo card's bottom edge and the subtitle. */
const CARD_GAP = 14;
/** The photo card starts below the window's traffic lights and runs nearly edge to edge. */
const CARD_TOP = 44;
const CARD_INSET = 14;
/** Share of the city name's capital height sunk below the card's edge: three quarters show. */
const CITY_CUT = 0.25;
/** Dark behind the chip at the top and behind the letters at the bottom. */
const WELCOME_FADE: [number, number][] = [
  [0, 0.3],
  [0.2, 0],
  [0.5, 0],
  [0.8, 0.3],
  [1, 0.55],
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NBSP = ' ';

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

export function WelcomeScreen({ city, steps, status, models, ready, onStart, prepared }: WelcomeProps) {
  const { width, height } = useScreenSize();
  const sx = width / W;
  // Shift for everything below the photo's middle: positive on taller phones, negative on shorter.
  const dy = height - H;
  const preparedText = prepared ? preparedLine(city, prepared) : undefined;
  const gridTop = 640 + dy;

  // The dusk photo is a rounded card from under the Offline chip down to the subtitle, and the
  // welcome is written across its bottom in 3D glass letters, the city name sunk a quarter of its
  // capital height below the card's edge so three quarters of it show (GlassWord).
  const inset = CARD_INSET * sx;
  const cardW = width - 2 * inset;
  const textTop = gridTop - TEXT_GAP - SUBTITLE_ROOM - (preparedText ? PREPARED_ROOM : 0);
  const cardH = Math.max(0, textTop - CARD_GAP - CARD_TOP);
  const word = glassWordSize(city, cardW - 24, 150 * sx);
  const lead = Math.round(word * 0.36);
  const wordShows = glassWordVisible(word, CITY_CUT);
  const leadBottom = wordShows + Math.round(word * 0.08);

  return (
    <View style={styles.root}>
      {/* Keyed on its size: on macOS the photo and the SVG inside keep their first layout when the
          window settles at its real size after launch, so the card is rebuilt at each new size. */}
      <View key={`${Math.round(cardW)}x${Math.round(cardH)}`} style={[styles.card, { left: inset, width: cardW, top: CARD_TOP, height: cardH }]}>
        <HeroPhoto tod="dusk" style={StyleSheet.absoluteFill} />
        {/* Dark behind the chip at the top and behind the letters at the bottom. */}
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
        <View style={[styles.chipRow, { top: 58 - CARD_TOP }]} pointerEvents="none">
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

      <View style={{ position: 'absolute', left: 28 * sx, right: 28 * sx, top: textTop, alignItems: 'center' }}>
        <Text style={[styles.subtitle, { maxWidth: 300 * sx }]}>
          {`All of ${city} on this phone, and a guide that never needs a signal.`}
        </Text>
        {preparedText ? (
          <Text numberOfLines={2} style={[styles.prepared, { maxWidth: 320 * sx }]} accessibilityLabel={preparedText}>
            {wrapAfterDate(preparedText)}
          </Text>
        ) : null}
      </View>

      <View style={{ position: 'absolute', left: 22 * sx, right: 22 * sx, top: gridTop }}>
        <Glass kind="clear" radius={22} style={styles.grid}>
          <View accessible accessibilityLabel={`Getting ready: ${steps.map(describe).join(', ')}`} style={styles.gridInner}>
            {steps.map(s => (
              <View key={s.label} style={styles.cell}>
                <StepDot state={s.state} />
                <Text numberOfLines={1} style={[styles.cellText, s.state === 'off' && { color: dusk.color.text2 }]}>
                  {s.state === 'off' ? `${s.label} (off)` : s.label}
                </Text>
              </View>
            ))}
          </View>
        </Glass>
        {/* While connecting: the latest status. Once ready: every on-device model by name. */}
        {!ready ? (
          <Text numberOfLines={2} style={styles.status} accessibilityLiveRegion="polite">
            {status}
          </Text>
        ) : models && models.length > 0 ? (
          <Text numberOfLines={2} style={styles.status} accessibilityLabel={`On this phone: ${models.join(', ')}`}>
            {/* "(Argmax)" once at the end rather than after every audio model, so the line fits. */}
            {models.map(m => m.replace(/\s*\(Argmax\)$/, '')).join(' · ')}
            {models.some(m => /\(Argmax\)$/.test(m)) ? ' · Argmax' : ''}
          </Text>
        ) : null}
      </View>

      <View style={[styles.buttonRow, { bottom: 34 }]}>
        <GlassButton
          label="Get started"
          onPress={onStart}
          disabled={!ready}
          accessibilityLabel={ready ? 'Get started' : 'Get started, available once the models are ready'}
          style={{ width: 230 }}
          textStyle={{ fontSize: 16 }}
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
  if (state === 'off') return <View style={[styles.ring, { borderColor: white(0.35) }]} />;
  const scale = pulse.interpolate({ inputRange: [0.35, 1], outputRange: [0.8, 1] });
  return <Animated.View style={[styles.ring, { opacity: pulse, transform: [{ scale }] }]} />;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: dusk.color.ground, overflow: 'hidden' },
  chipRow: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  card: {
    position: 'absolute',
    borderRadius: dusk.radius.sheet,
    overflow: 'hidden',
    backgroundColor: dusk.color.raised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: white(0.1),
  },
  titleBox: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  subtitle: {
    ...font('500'),
    fontSize: 15,
    lineHeight: 22,
    color: dusk.color.textSoft,
    textAlign: 'center',
  },
  prepared: { ...font('500'), marginTop: 6, fontSize: 12, lineHeight: 15, color: dusk.color.text2, textAlign: 'center' },
  grid: { paddingVertical: 12, paddingHorizontal: 16 },
  gridInner: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 8, columnGap: 14 },
  // Two columns: half the row minus half the 14 px column gap.
  cell: { width: '47%', flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 16 },
  cellText: { ...font('600'), fontSize: 12, color: dusk.color.text, flexShrink: 1 },
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
  ring: { width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: white(0.7) },
  status: { ...font('500'), marginTop: 8, fontSize: 11, lineHeight: 15, color: dusk.color.text2, textAlign: 'center' },
  buttonRow: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
});
