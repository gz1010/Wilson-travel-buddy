import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Keyboard,
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { addDays, weekday, WEEKDAY_KEYS, WEEKDAY_NAMES } from '../../core/time';
import { tripDay } from '../../core/trip';
import type { Trip } from '../../core/types';
import { Glass, GlassButton, GlassIconButton, onGlass } from '../dusk/Glass';
import { CloseIcon, SendIcon } from '../dusk/Icons';
import { MicOrb } from '../dusk/Nav';
import { HeroPhoto, PhotoFade } from '../dusk/Photos';
import { useReduceMotion } from '../dusk/motion';
import { dusk, font, white } from '../dusk/tokens';
import type { Buddy } from '../useBuddy';
import type { ScreenProps } from './types';
import { useScreenSize } from '../dusk/Screen';

// AntSetup: trip setup by voice, also the "Plan" tab. The transcript shows what the traveller
// said, with the words the model understood in small glass pills; the "Your trip" card shows
// the itinerary Bonsai-2 built from it.

const PLACEHOLDER = "Tell me how long you're here, where you're staying and what you love.";
const TRANSCRIPT_SIZE = dusk.font.transcript.size;
const TRANSCRIPT_LINE = Math.round(TRANSCRIPT_SIZE * 1.32);
const MAX_DAY_TILES = 5;
// react-native-macos draws a focus ring round a focused field; the glass pill is the field. The
// prop is macOS-only, so it isn't in react-native's TextInput types.
const NO_FOCUS_RING = { enableFocusRing: false } as object;
// Narrow no-break space: pads a pill without letting the line break between the padding and the word.
const THIN_SPACE = '\u202F';

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen'];

// --- Tokenising: which words of the transcript the model understood.

/** Lower case without accents, one UTF-16 unit per unit, so indexes match the original text. */
function foldKeepLength(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i].normalize('NFD')[0] ?? s[i];
    out += c.toLowerCase()[0] ?? c;
  }
  return out;
}

const isWordChar = (c: string | undefined) => !!c && /[a-z0-9]/.test(c);

/** The words and names the trip says the model understood. */
function understoodTerms(trip: Trip, b: Buddy): string[] {
  const terms: string[] = [];
  for (const interest of trip.interests) {
    const word = interest.replace(/-/g, ' ');
    terms.push(word);
    if (word.endsWith('s') && word.length > 4) terms.push(word.slice(0, -1));
  }
  if (trip.base?.name) terms.push(trip.base.name);
  if (trip.base?.placeId) {
    const p = b.index.place(trip.base.placeId);
    if (p) terms.push(p.name, ...(p.localName ? [p.localName] : []));
  }
  for (const s of trip.stops) {
    terms.push(s.title);
    const p = s.placeId ? b.index.place(s.placeId) : undefined;
    if (p) terms.push(p.name, ...(p.localName ? [p.localName] : []));
  }
  const unit = trip.days === 1 ? 'day' : 'days';
  terms.push(`${trip.days} ${unit}`);
  if (NUMBER_WORDS[trip.days]) terms.push(`${NUMBER_WORDS[trip.days]} ${unit}`);
  if (trip.days === 1) terms.push('a day', 'one day');
  if (trip.days === 7) terms.push('a week');
  const folded = [...new Set(terms.map(t => foldKeepLength(t.trim())).filter(t => t.length >= 2))];
  return folded.sort((a, c) => c.length - a.length); // longest first, so "plaza de españa" beats "plaza"
}

interface Piece {
  text: string;
  hit: boolean;
}

/** Splits text into plain runs and understood terms (case- and accent-insensitive, whole words). */
function tokenise(text: string, terms: string[]): Piece[] {
  if (!terms.length) return [{ text, hit: false }];
  const hay = foldKeepLength(text);
  const pieces: Piece[] = [];
  let plain = '';
  let i = 0;
  while (i < text.length) {
    let end = -1;
    if (!isWordChar(hay[i - 1])) {
      for (const term of terms) {
        if (!hay.startsWith(term, i)) continue;
        let j = i + term.length;
        if (hay[j] === 's' && !isWordChar(hay[j + 1])) j++; // "market" matches "markets"
        if (!isWordChar(hay[j])) {
          end = j;
          break;
        }
      }
    }
    if (end > i) {
      if (plain) pieces.push({ text: plain, hit: false });
      plain = '';
      pieces.push({ text: text.slice(i, end), hit: true });
      i = end;
    } else {
      plain += text[i];
      i++;
    }
  }
  if (plain) pieces.push({ text: plain, hit: false });
  return pieces;
}

// --- Keyboard height (for the typed-input stand-in), with a layout ease that respects reduce-motion.

function useKeyboardHeight(reduce: boolean): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const ease = (duration?: number) => {
      if (!reduce) LayoutAnimation.configureNext(LayoutAnimation.create(duration || 250, 'keyboard', 'opacity'));
    };
    const show = Keyboard.addListener(showEvent, e => {
      ease(e.duration);
      setHeight(e.endCoordinates.height);
    });
    const hide = Keyboard.addListener(hideEvent, e => {
      ease(e.duration);
      setHeight(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [reduce]);
  return height;
}

// --- The screen.

export function SetupScreen({ b, nav }: ScreenProps) {
  const { width, height } = useScreenSize();
  const sx = width / dusk.layout.phoneWidth;
  const reduce = useReduceMotion();
  const keyboard = useKeyboardHeight(reduce);
  const hasMic = b.runtime.audio.info.hasMicrophone;
  const { trip } = b;

  // What the transcript shows: live words, else the last thing the traveller said.
  const lastYou = useMemo(() => [...b.chat].reverse().find(l => l.who === 'you'), [b.chat]);
  const lastBuddy = useMemo(() => [...b.chat].reverse().find(l => l.who === 'buddy'), [b.chat]);
  const said = b.listening ? b.partial : lastYou?.text ?? '';
  const terms = useMemo(() => (trip ? understoodTerms(trip, b) : []), [trip, b]);
  const pieces = useMemo(() => (said ? tokenise(said, terms) : []), [said, terms]);

  // Fit the transcript to the space between the header and the card.
  const [areaHeight, setAreaHeight] = useState(0);
  const onArea = (e: LayoutChangeEvent) => setAreaHeight(e.nativeEvent.layout.height);
  const lines = Math.max(2, Math.floor(areaHeight / TRANSCRIPT_LINE) || 7);

  // The typed row, always there: type the plans instead of (or as well as) saying them.
  const [typed, setTyped] = useState('');
  const input = useRef<TextInput>(null);
  const submit = () => {
    const t = typed.trim();
    if (!t || b.busy) return;
    b.send(t);
    setTyped('');
    Keyboard.dismiss();
  };
  const onMic = () => (hasMic ? b.talk() : input.current?.focus());

  // Close is always there: without a trip, Now still suggests places for today.
  const close = () => nav.go('now');
  const confirm = () => {
    b.confirmTrip();
    nav.go('now');
  };

  const photoHeight = Math.min(height, 560);
  const keyboardUp = keyboard > 0;
  // Short windows (under the 844 design height): a smaller orb and tighter spacing so the
  // typed row, the orb and "Looks right" still fit under the card.
  const compact = height < 800;

  return (
    <View style={[styles.root, { backgroundColor: dusk.color.ground }]}>
      {/* The city at night, in the lower part of the screen, under a dark fade. */}
      <HeroPhoto tod="night" style={[styles.photo, { height: photoHeight }]} />
      <PhotoFade stops={[[0, 1], [0.38, 1], [0.7, 0.4], [1, 0.8]]} />

      <View style={[styles.column, { paddingBottom: keyboardUp ? keyboard + 12 : 40 }]}>
        {/* Header */}
        <View style={[styles.header, { marginHorizontal: 20 * sx }]}>
          <Text style={styles.label}>TELL ME ABOUT YOUR TRIP</Text>
          <GlassIconButton accessibilityLabel="Close" onPress={close} size={40} kind="clear">
            <CloseIcon size={14} />
          </GlassIconButton>
        </View>

        {/* Live transcript */}
        <View style={[styles.transcriptArea, { marginHorizontal: 22 * sx }]} onLayout={onArea}>
          <Text
            accessibilityLiveRegion="polite"
            numberOfLines={lines}
            adjustsFontSizeToFit
            minimumFontScale={0.6}
            style={[styles.transcript, !said && { color: dusk.color.pending }]}>
            {said
              ? pieces.map((p, i) =>
                  p.hit ? (
                    <Text key={i} style={styles.understood}>
                      {THIN_SPACE}
                      {p.text}
                      {THIN_SPACE}
                    </Text>
                  ) : (
                    <Text key={i}>{p.text}</Text>
                  ),
                )
              : b.listening
                ? 'Listening…'
                : PLACEHOLDER}
          </Text>
        </View>

        {/* Your trip */}
        <Glass kind="clear" radius={dusk.radius.sheet} style={{ marginHorizontal: 14 * sx }}>
          <View accessibilityLabel="Your trip so far" style={styles.cardInner}>
            <View style={styles.cardHead}>
              <Text style={styles.cardTitle}>Your trip</Text>
              <Text style={styles.cardStatus} numberOfLines={1}>
                {b.busy ? `${b.runtime.llm.name} is filling this in` : trip ? 'Tap a day to see it' : 'Nothing yet'}
              </Text>
            </View>
            {trip ? (
              <>
                <DayTiles b={b} trip={trip} onDay={date => {
                  b.setClock({ date, minute: b.situation.clock.minute });
                  nav.go('now');
                }} />
                {!!lastBuddy && (lastBuddy.text || lastBuddy.pending) && (
                  <Text style={styles.reply} numberOfLines={2}>
                    {lastBuddy.text || '…'}
                  </Text>
                )}
                {(trip.base || trip.interests.length > 0) && (
                  <View style={styles.pills}>
                    {trip.base && <Pill label={`Base · ${trip.base.name}`} />}
                    {trip.interests.map(i => (
                      <Pill key={i} label={i.replace(/-/g, ' ')} />
                    ))}
                  </View>
                )}
              </>
            ) : (
              <Text style={styles.empty}>
                {b.busy
                  ? 'Working out your days…'
                  : `Your days, where you're staying and what you love will appear here as ${b.runtime.llm.name} understands them.`}
              </Text>
            )}
          </View>
        </Glass>

        {/* Typed plans: a clear-glass pill with a send button. Enter also sends. */}
        <Glass kind="clear" radius={999} style={[styles.field, { marginHorizontal: 14 * sx, marginTop: compact ? 12 : 16 }]}>
          <TextInput
            ref={input}
            accessibilityLabel="Type your plans"
            value={typed}
            onChangeText={setTyped}
            onSubmitEditing={submit}
            returnKeyType="send"
            blurOnSubmit
            editable={!b.busy}
            placeholder="Or type your plans…"
            placeholderTextColor={dusk.color.pending}
            selectionColor={dusk.color.white}
            keyboardAppearance="dark"
            {...NO_FOCUS_RING}
            style={styles.input}
          />
          <GlassIconButton accessibilityLabel="Send" onPress={submit} size={36} kind="prominent" blur={false}>
            <SendIcon size={16} />
          </GlassIconButton>
        </Glass>

        {/* Bottom: mic orb and confirm. */}
        <View style={[styles.bottom, { marginTop: keyboardUp ? 12 : compact ? 18 : 30, gap: compact ? 10 : 16 }]}>
          {!keyboardUp && (
            <>
              <OrbWithRings listening={b.listening} onPress={onMic} reduce={reduce} size={compact ? 64 : dusk.size.micOrb} />
              <GlassButton
                label="Looks right"
                height={dusk.size.buttonSmall}
                disabled={!trip}
                onPress={confirm}
                style={styles.confirm}
                accessibilityLabel={trip ? 'Looks right, save the trip' : 'Looks right (describe your trip first)'}
              />
            </>
          )}
        </View>
      </View>
    </View>
  );
}

/** One tile per trip day (up to five): weekday and the first stop, the day with a booking brighter. */
function DayTiles({ b, trip, onDay }: { b: Buddy; trip: Trip; onDay: (date: string) => void }) {
  const today = tripDay(trip, b.situation.clock.date) ?? 1;
  const count = Math.min(trip.days, MAX_DAY_TILES);
  const first = trip.days > MAX_DAY_TILES ? Math.max(1, Math.min(today, trip.days - MAX_DAY_TILES + 1)) : 1;
  const days = Array.from({ length: count }, (_, i) => first + i);
  return (
    <View style={styles.tiles}>
      {days.map(day => {
        const date = addDays(trip.startDate, day - 1);
        const wd = weekday(date);
        const stops = trip.stops.filter(s => s.day === day);
        const fixed = stops.some(s => s.fixed);
        const what = stops[0]?.title ?? 'Free';
        const label = (
          <>
            <Text style={[styles.tileDay, fixed && onGlass]}>{WEEKDAY_KEYS[wd].toUpperCase()}</Text>
            <Text style={[styles.tileWhat, fixed && [onGlass, font('700')]]} numberOfLines={1}>
              {what}
            </Text>
          </>
        );
        return (
          <Pressable
            key={day}
            accessibilityRole="button"
            accessibilityLabel={`${WEEKDAY_NAMES[wd]}, ${stops.length ? stops.map(s => s.title).join(', ') : 'free'}${fixed ? ', booked' : ''}`}
            onPress={() => onDay(date)}
            style={({ pressed }) => [styles.tileHit, pressed && { opacity: 0.8 }]}>
            {fixed ? (
              <Glass kind="prominent" radius={16} blur={false} style={styles.tile}>
                {label}
              </Glass>
            ) : (
              <View style={[styles.tile, styles.tilePlain]}>{label}</View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

function Pill({ label }: { label: string }) {
  return (
    <Glass kind="clear" radius={dusk.radius.pill} blur={false} style={styles.pill}>
      <Text style={[onGlass, styles.pillText]} numberOfLines={1}>
        {label}
      </Text>
    </Glass>
  );
}

/** The mic orb (80 px, 64 on short windows) with the two faint concentric rings; the rings breathe while listening. */
function OrbWithRings({ listening, onPress, reduce, size = dusk.size.micOrb }: { listening: boolean; onPress: () => void; reduce: boolean; size?: number }) {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!listening || reduce) {
      pulse.stopAnimation();
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.07, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [listening, reduce, pulse]);
  const ring = (spread: number, alpha: number) => (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: -spread,
        top: -spread,
        width: size + spread * 2,
        height: size + spread * 2,
        borderRadius: size / 2 + spread,
        backgroundColor: white(alpha),
        transform: [{ scale: pulse }],
      }}
    />
  );
  return (
    <View style={{ width: size, height: size }}>
      {ring(Math.round(size * 0.32), 0.035)}
      {ring(Math.round(size * 0.15), 0.07)}
      <MicOrb listening={listening} onPress={onPress} size={size} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, overflow: 'hidden' },
  photo: { position: 'absolute', left: 0, right: 0, bottom: 0, opacity: 0.7 },
  column: { flex: 1, paddingTop: 56 },
  header: { height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: {
    ...font(dusk.font.label.weight),
    fontSize: dusk.font.label.size,
    letterSpacing: dusk.font.label.letterSpacing,
    color: dusk.color.text2,
  },
  // Header is 44 tall from 56, so the transcript starts at 112 as in the mockup.
  transcriptArea: { flex: 1, marginTop: 12, marginBottom: 16, overflow: 'hidden' },
  transcript: {
    ...font(dusk.font.transcript.weight),
    fontSize: TRANSCRIPT_SIZE,
    lineHeight: TRANSCRIPT_LINE,
    letterSpacing: -0.03 * TRANSCRIPT_SIZE,
    color: dusk.color.text,
  },
  understood: { ...font('700'), color: dusk.color.white, backgroundColor: white(0.14) },
  cardInner: { padding: 18, gap: 12 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 },
  cardTitle: { ...font('700'), fontSize: 20, color: dusk.color.text },
  cardStatus: { ...font('500'), fontSize: 12, color: dusk.color.text2, flexShrink: 1 },
  tiles: { flexDirection: 'row', gap: 6 },
  tileHit: { flex: 1, minWidth: 0, minHeight: dusk.size.touch },
  tile: { paddingVertical: 10, paddingHorizontal: 8, borderRadius: 16 },
  tilePlain: { backgroundColor: white(0.06), borderWidth: 1, borderColor: white(0.1) },
  tileDay: { ...font('800'), fontSize: 11, color: dusk.color.text2 },
  tileWhat: { ...font('500'), fontSize: 12, marginTop: 4, color: dusk.color.text },
  reply: { ...font('500'), fontSize: 13, lineHeight: 19, color: dusk.color.textSoft },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  pill: { paddingVertical: 6, paddingHorizontal: 11 },
  pillText: { ...font('700'), fontSize: 12, color: dusk.color.text },
  empty: { ...font('500'), fontSize: 13, lineHeight: 19, color: dusk.color.pending },
  bottom: { alignItems: 'center' },
  field: { height: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 20, paddingRight: 6 },
  // Transparent, no bezel: the glass pill is the field (macOS otherwise draws a grey box).
  input: { ...font('500'), flex: 1, fontSize: 15, color: dusk.color.white, height: 48, padding: 0, backgroundColor: 'transparent', borderWidth: 0 },
  confirm: { width: 220 },
});
