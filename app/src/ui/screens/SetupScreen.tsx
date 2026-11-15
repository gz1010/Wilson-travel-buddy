import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  LayoutAnimation,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { PackIndex } from '../../core/pack';
import { addDays, weekday, WEEKDAY_KEYS, WEEKDAY_NAMES } from '../../core/time';
import { tripDay } from '../../core/trip';
import type { Fact, Trip } from '../../core/types';
import { axPress, Glass, OfflineChip, onGlass } from '../dusk/Glass';
import { ArrowIcon } from '../dusk/Icons';
import { LiquidBackground, moodColor, type Mood } from '../dusk/LiquidBackground';
import { modelLine } from '../dusk/modelNames';
import { useReduceMotion } from '../dusk/motion';
import { useScreenSize } from '../dusk/Screen';
import { dusk, font, white } from '../dusk/tokens';
import { useMicLevel, VoiceMic } from '../dusk/VoiceMic';
import type { ChatLine } from '../useBuddy';
import type { ScreenProps } from './types';

// Chat (the tab that was Plan; its screen id stays 'setup'): voice mode and chat with the buddy.
// Voice first: the slim liquid mic at the bottom listens, the answer streams into the
// conversation (you on the right, the buddy on glass on the left) and is spoken; typing works too.
// Behind it an abstract liquid background in the Dusk palette brightens and takes the mic's tint
// while it listens, thinks or speaks. "Your trip" above the conversation is a compact summary of
// the days that opens to show them; it updates (and says so) when the trip changes, e.g. after
// "I'm staying two more days". Facts the answer was built from (b.cited) show under the answer.
// DuskRoot draws the tab bar over the bottom TAB_BAR_RESERVE.

/** Room at the bottom for the floating tab bar: 26 from the bottom, the bar, then a gap. */
const TAB_BAR_RESERVE = 26 + dusk.size.tabBar + 14;
/** The Mac window's smallest content height (AppDelegate.mm sets contentMinSize to 390 x 700). */
const MIN_HEIGHT = 700;
// The typed-message pill and its send button.
const FIELD_HEIGHT = 48;
const SEND_SIZE = 36;
// react-native-macos draws a rectangular focus ring around a focused field, which looks broken
// inside a pill; the iOS typings don't know the prop that turns it off.
const NO_FOCUS_RING: object = { enableFocusRing: false };
// Narrow no-break space: pads a highlighted word without letting the line break around it.
const THIN_SPACE = ' ';
/** The trip strip shows at most this many days (the longest trip the planner makes). */
const MAX_DAYS = 14;
/** Only the buddy's latest bubbles blur what's behind them; older ones are flat glass (cheaper). */
const BLURRED_BUBBLES = 6;
/** How long the trip card says "updated" after a change. */
const UPDATED_MS = 5000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Vertical sizes for a window height: full at 844 and taller, tighter down to the 700 minimum. */
function fit(height: number) {
  const { phoneHeight } = dusk.layout;
  const t = Math.max(0, Math.min(1, (phoneHeight - height) / (phoneHeight - MIN_HEIGHT)));
  const mix = (full: number, short: number) => Math.round(full + (short - full) * t);
  return { top: mix(56, 44), mic: mix(64, 58), gap: mix(12, 8), dock: mix(10, 6), intro: mix(25, 21) };
}

// --- Which words of what you said the model understood (shown highlighted in your bubbles).

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen'];

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
function understoodTerms(trip: Trip, index: PackIndex): string[] {
  const terms: string[] = [];
  for (const interest of trip.interests) {
    const word = interest.replace(/-/g, ' ');
    terms.push(word);
    if (word.endsWith('s') && word.length > 4) terms.push(word.slice(0, -1));
  }
  if (trip.base?.name) terms.push(trip.base.name);
  if (trip.base?.placeId) {
    const p = index.place(trip.base.placeId);
    if (p) terms.push(p.name, ...(p.localName ? [p.localName] : []));
  }
  for (const s of trip.stops) {
    terms.push(s.title);
    const p = s.placeId ? index.place(s.placeId) : undefined;
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

// --- The trip, in words.

const dayOfMonth = (date: string) => Number(date.slice(8, 10));
const monthShort = (date: string) => MONTHS[Number(date.slice(5, 7)) - 1] ?? '';
const shortDay = (date: string) => `${WEEKDAY_NAMES[weekday(date)].slice(0, 3)} ${dayOfMonth(date)}`;

/** "Sun 15 – Tue 17 Nov" */
function tripRange(trip: Trip): string {
  const end = addDays(trip.startDate, trip.days - 1);
  const m1 = monthShort(trip.startDate);
  const m2 = monthShort(end);
  if (trip.days <= 1) return `${shortDay(trip.startDate)} ${m1}`;
  return m1 === m2 ? `${shortDay(trip.startDate)} – ${shortDay(end)} ${m2}` : `${shortDay(trip.startDate)} ${m1} – ${shortDay(end)} ${m2}`;
}

/** "3 days · Sun 15 – Tue 17 Nov · the old town" */
function tripSummary(trip: Trip): string {
  const parts = [`${trip.days} day${trip.days === 1 ? '' : 's'}`, tripRange(trip)];
  if (trip.base?.name) parts.push(trip.base.name.replace(/^(near|by|in|at)\s+/i, ''));
  return parts.join(' · ');
}

/** Changes whenever something the card shows changes. */
function tripSignature(t: Trip | undefined): string {
  if (!t) return '';
  return [t.startDate, t.days, t.base?.name ?? '', t.interests.join(','), t.stops.map(s => `${s.id}@${s.day}/${s.start ?? ''}`).join(',')].join('|');
}

// --- Facts behind an answer: each answer's own (line.cited), else b.cited for the latest.

interface CitedFacts {
  placeId?: string;
  facts: Fact[];
}

/** Facts read defensively (an answer's own, or b.cited): they may be missing or empty. */
function factsIn(holder: unknown): CitedFacts | undefined {
  const c = (holder as { cited?: CitedFacts } | undefined)?.cited;
  return c && Array.isArray(c.facts) && c.facts.length > 0 ? c : undefined;
}

function sourceLabel(f: Fact): string {
  let from = 'Travel guide';
  if (f.source) {
    const host = f.source.replace(/^[a-z]+:\/\//i, '').split('/')[0].replace(/^www\./, '');
    from = /wikipedia\.org$/i.test(host) ? 'Wikipedia' : host;
  }
  return f.license ? `${from} · ${f.license}` : from;
}

function stopTimer(timer: { current: ReturnType<typeof setTimeout> | undefined }) {
  if (timer.current !== undefined) clearTimeout(timer.current);
  timer.current = undefined;
}

function lastIndexWhere<T>(items: readonly T[], test: (t: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i])) return i;
  return -1;
}

// --- The screen.

export function SetupScreen({ b, nav }: ScreenProps) {
  const { width, height } = useScreenSize();
  const sx = Math.min(1.15, width / dusk.layout.phoneWidth);
  const f = fit(height);
  const reduce = useReduceMotion();
  const hasMic = b.runtime.audio.info.hasMicrophone;
  const { trip, index } = b;
  const llm = b.runtime.llm.name;

  // One mood for the mic and the background: what the buddy is doing right now.
  const mood: Mood = b.listening ? 'listening' : b.speaking ? 'speaking' : b.busy ? 'thinking' : 'idle';
  const mic = useMicLevel(b.runtime.audio, b.listening, b.partial);

  // Every on-device model by name, always visible (with the Offline chip).
  const models = modelLine(llm, b.runtime.audio.info.models);
  const terms = useMemo(() => (trip ? understoodTerms(trip, index) : []), [trip, index]);

  // Typing instead of talking: always there. The send button and Enter both send.
  const [typed, setTyped] = useState('');
  const input = useRef<TextInput>(null);
  // Not while the mic is listening: what it hears is sent when it stops, so a typed line would race it.
  const canSend = typed.trim().length > 0 && !b.busy && !b.listening;
  const submit = (text = typed) => {
    const t = text.trim();
    if (t && !b.busy && !b.listening) {
      b.send(t);
      setTyped('');
    }
    // On macOS, Enter takes focus away from the field; give it back so the next line can be typed.
    setTimeout(() => input.current?.focus(), 0);
  };
  const onMic = () => (hasMic ? b.talk() : input.current?.focus());

  // The conversation keeps its end in view while new words arrive, unless you scrolled up to read.
  const scroll = useRef<ScrollView>(null);
  const atEnd = useRef(true);
  const lastY = useRef(0);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const y = contentOffset.y;
    // Only moving up stops the following: our own animated scrolls to the end pass through
    // positions far from the end too, and must not stop it.
    if (y + layoutMeasurement.height >= contentSize.height - 48) atEnd.current = true;
    else if (y < lastY.current - 1) atEnd.current = false;
    lastY.current = y;
  };
  const toEnd = () => scroll.current?.scrollToEnd({ animated: !reduce });
  // A new line (yours or the buddy's) or the mic starting always brings the end back.
  // The empty conversation (the intro and suggestions) starts at its top instead: in a short window
  // it can be taller than the space, and its first line is the one to read.
  const lineCount = b.chat.length;
  useEffect(() => {
    atEnd.current = true;
    if (lineCount > 0 || b.listening) scroll.current?.scrollToEnd({ animated: !reduce });
  }, [lineCount, b.listening, reduce]);

  const onDay = (date: string) => {
    b.setClock({ date, minute: b.situation.clock.minute });
    b.confirmTrip();
    nav.go('now');
  };

  const latestCited = factsIn(b);
  const lastBuddy = lastIndexWhere(b.chat, l => l.who === 'buddy');
  const firstBlurred = Math.max(0, b.chat.length - BLURRED_BUBBLES * 2);
  const empty = b.chat.length === 0 && !b.listening;

  const caption = !hasMic
    ? 'No microphone here: type below'
    : b.listening
      ? b.partial
        ? 'Listening · tap the ring to send'
        : 'Listening…'
      : b.speaking
        ? 'Speaking · tap the ring to interrupt'
        : b.busy
          ? `${llm} is thinking…` // what it is doing (b.status) shows under its bubble
          : b.status ?? 'Tap the ring to talk'; // e.g. why the microphone stopped

  // Suggestions for an empty conversation: they send like typed lines.
  const landmark = trip?.stops.find(s => s.placeId)?.title ?? index.destination.name;
  const suggestions = trip
    ? ["I'm staying two more days", `Tell me a historical fact about ${landmark}`, 'What should I do right now?']
    : ["I'm here three days and love food and history", 'What should I do right now?', 'How do I say thank you?'];

  return (
    <View style={styles.root}>
      <LiquidBackground mood={hasMic ? mood : b.busy ? 'thinking' : 'idle'} subscribeLevel={mic.subscribe} />

      {/* The models get the full width under the title: with the Argmax helper they are four long names. */}
      <View style={{ marginTop: f.top, marginHorizontal: 20 * sx }}>
        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">
            Chat
          </Text>
          <OfflineChip />
        </View>
        <Text style={styles.models} numberOfLines={3}>
          {`Voice mode · ${models}`}
        </Text>
      </View>

      <TripCard trip={trip} busy={b.busy} llm={llm} today={trip ? tripDay(trip, b.situation.clock.date) : undefined} reduce={reduce} onDay={onDay} style={{ marginTop: f.gap, marginHorizontal: 14 * sx }} />

      <ScrollView
        ref={scroll}
        style={[styles.chat, { marginTop: f.gap }]}
        contentContainerStyle={[styles.chatContent, { paddingHorizontal: 16 * sx }]}
        onScroll={onScroll}
        scrollEventThrottle={64}
        onContentSizeChange={() => atEnd.current && !empty && toEnd()}
        showsVerticalScrollIndicator={false}
        accessibilityLabel="Conversation">
        {empty ? (
          <View style={styles.intro}>
            <Text style={[styles.introBig, { fontSize: f.intro, lineHeight: Math.round(f.intro * 1.24) }]}>{trip ? 'What would you like to know?' : "Tell me how long you're here, where you're staying and what you love."}</Text>
            <Text style={styles.introSmall}>{`Tap the ring and talk, or type below. ${llm} answers on this Mac, offline.`}</Text>
            <View style={styles.suggestions}>
              {suggestions.map(s => (
                <Suggestion key={s} label={s} disabled={b.busy} onPress={() => submit(s)} />
              ))}
            </View>
          </View>
        ) : null}

        {b.chat.map((line, i) =>
          line.who === 'you' ? (
            <YouBubble key={line.id} text={line.text} terms={terms} />
          ) : (
            <View key={line.id} style={styles.buddyBlock}>
              <BuddyBubble
                line={line}
                blur={i >= firstBlurred}
                tint={b.speaking && i === lastBuddy ? moodColor('speaking', 0.16) : undefined}
                status={line.pending ? b.status : undefined}
                reduce={reduce}
              />
              {line.pending ? null : (
                <Cited
                  cited={factsIn(line) ?? (i === lastBuddy ? latestCited : undefined)}
                  max={i === lastBuddy ? 3 : 2}
                  onOpen={id => (index.place(id) ? nav.openPlace(id) : undefined)}
                />
              )}
            </View>
          ),
        )}

        {b.listening ? (
          <Glass kind="prominent" radius={20} blur={false} tint={moodColor('listening', 0.2)} style={styles.you}>
            <Text style={[onGlass, styles.youText, !b.partial && styles.livePending]} accessibilityLiveRegion="polite">
              {b.partial || 'Listening…'}
            </Text>
          </Glass>
        ) : null}
      </ScrollView>

      <View style={[styles.dock, { paddingHorizontal: 14 * sx, paddingTop: f.dock, marginBottom: TAB_BAR_RESERVE }]}>
        <VoiceMic
          state={hasMic ? mood : 'idle'}
          level={mic.value}
          onPress={onMic}
          size={f.mic}
          accessibilityLabel={hasMic ? undefined : 'No microphone: type a message'}
        />
        <Text style={styles.caption} numberOfLines={1} accessibilityLiveRegion="polite">
          {caption}
        </Text>

        {/* Type instead: a clear-glass pill with a small send button. */}
        <Glass kind="clear" radius={dusk.radius.pill} style={[styles.field, { marginTop: f.dock }]}>
          <TextInput
            ref={input}
            accessibilityLabel="Type a message"
            value={typed}
            onChangeText={setTyped}
            onSubmitEditing={e => submit(e.nativeEvent.text)}
            submitBehavior="submit"
            placeholder="Or type a message…"
            placeholderTextColor={dusk.color.pending}
            selectionColor={white(0.3)}
            cursorColor={dusk.color.white}
            autoCorrect={false}
            spellCheck={false}
            {...NO_FOCUS_RING}
            style={styles.input}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            accessibilityState={{ disabled: !canSend }}
            disabled={!canSend}
            onPress={() => submit()}
            {...axPress(() => submit(), !canSend)}
            hitSlop={(dusk.size.touch - SEND_SIZE) / 2}
            style={({ pressed }) => ({ opacity: !canSend ? 0.45 : pressed ? 0.85 : 1 })}>
            <Glass kind="prominent" radius={SEND_SIZE / 2} blur={false} style={styles.send}>
              <ArrowIcon size={16} strokeWidth={2.4} />
            </Glass>
          </Pressable>
        </Glass>
      </View>
    </View>
  );
}

// --- Bubbles.

/** What you said, on the right, with the words the model understood highlighted. */
const YouBubble = React.memo(function YouBubble({ text, terms }: { text: string; terms: string[] }) {
  const pieces = useMemo(() => tokenise(text, terms), [text, terms]);
  return (
    <Glass kind="prominent" radius={20} blur={false} style={styles.you}>
      <Text style={[onGlass, styles.youText]}>
        {pieces.map((p, i) =>
          p.hit ? (
            <Text key={i} style={styles.understood}>
              {THIN_SPACE}
              {p.text}
              {THIN_SPACE}
            </Text>
          ) : (
            <Text key={i}>{p.text}</Text>
          ),
        )}
      </Text>
    </Glass>
  );
});

/**
 * The buddy's answer, on the left on clear glass; dots until the first words stream in. Memoised:
 * while an answer streams only its own bubble re-renders (useBuddy keeps the other lines as they are).
 */
const BuddyBubble = React.memo(function BuddyBubble({ line, blur, tint, status, reduce }: { line: ChatLine; blur: boolean; tint?: string; status?: string; reduce: boolean }) {
  return (
    <>
      <Glass kind="clear" radius={20} blur={blur} tint={tint} style={styles.buddy}>
        {line.text ? (
          <Text style={[styles.buddyText, line.error && styles.errorText]}>{line.text}</Text>
        ) : (
          <TypingDots reduce={reduce} />
        )}
      </Glass>
      {status ? (
        <Text style={styles.status} numberOfLines={1}>
          {status}
        </Text>
      ) : null}
    </>
  );
});

function TypingDots({ reduce }: { reduce: boolean }) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) {
      t.setValue(0.5);
      return;
    }
    const loop = Animated.loop(Animated.timing(t, { toValue: 1, duration: 1100, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [reduce, t]);
  const dots = useMemo(
    () =>
      [0, 1, 2].map(i => ({
        // Each dot glows a little after the one before; every range stays inside 0-1 (an input
        // range past 1 isn't monotonic and makes Animated throw).
        opacity: reduce
          ? 0.7
          : t.interpolate({ inputRange: [0, i * 0.22, i * 0.22 + 0.17, i * 0.22 + 0.34, 1], outputRange: [0.3, 0.3, 1, 0.3, 0.3], extrapolate: 'clamp' }),
      })),
    [reduce, t],
  );
  return (
    <View style={styles.dots} accessibilityLabel="Thinking">
      {dots.map((style, i) => (
        <Animated.View key={i} style={[styles.dot, style]} />
      ))}
    </View>
  );
}

/** The guide's facts behind an answer, as small cards under it; a fact about a place opens it. */
function Cited({ cited, max, onOpen }: { cited: CitedFacts | undefined; max: number; onOpen: (placeId: string) => void }) {
  if (!cited) return null;
  return (
    <View style={styles.facts}>
      <Text style={styles.factsLabel}>FROM THE GUIDE</Text>
      {cited.facts.slice(0, max).map((fact, i) => {
        const placeId = fact.placeId ?? cited.placeId;
        const card = (
          <Glass kind="clear" radius={16} blur={false} style={styles.fact}>
            {fact.title ? (
              <Text style={styles.factTitle} numberOfLines={2}>
                {fact.title}
              </Text>
            ) : null}
            <Text style={styles.factBody} numberOfLines={4}>
              {fact.body}
            </Text>
            <Text style={styles.factSource} numberOfLines={1}>
              {sourceLabel(fact)}
            </Text>
          </Glass>
        );
        const key = fact.id ?? String(i);
        return placeId ? (
          <Pressable
            key={key}
            accessibilityRole="button"
            accessibilityLabel={`${fact.title || 'Fact'}. Open the place`}
            onPress={() => onOpen(placeId)}
            {...axPress(() => onOpen(placeId))}
            style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
            {card}
          </Pressable>
        ) : (
          <View key={key}>{card}</View>
        );
      })}
    </View>
  );
}

function Suggestion({ label, disabled, onPress }: { label: string; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Say: ${label}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      {...axPress(onPress, disabled)}
      style={({ pressed }) => [styles.suggestionHit, { opacity: disabled ? 0.5 : pressed ? 0.85 : 1 }]}>
      <Glass kind="clear" radius={dusk.radius.pill} blur={false} style={styles.suggestion}>
        <Text style={styles.suggestionText} numberOfLines={2}>
          {label}
        </Text>
      </Glass>
    </Pressable>
  );
}

// --- Your trip.

function Chevron({ up }: { up: boolean }) {
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={dusk.color.text2} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <Path d={up ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
    </Svg>
  );
}

/**
 * "Your trip": one line (days, dates, where you stay) that opens to the days themselves. When the
 * trip changes it lights up and says "updated" for a few seconds, and opens if the days changed.
 */
function TripCard({
  trip,
  busy,
  llm,
  today,
  reduce,
  onDay,
  style,
}: {
  trip: Trip | undefined;
  busy: boolean;
  llm: string;
  today: number | undefined;
  reduce: boolean;
  onDay: (date: string) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const [open, setOpen] = useState(false);
  const [updated, setUpdated] = useState(false);
  const sig = tripSignature(trip);
  const days = trip?.days;
  const before = useRef<{ sig: string; days?: number } | null>(null);
  // Kept outside the effect: a re-run for another reason (reduce motion toggled) must not cancel it.
  const updatedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => stopTimer(updatedTimer), []);

  useEffect(() => {
    const prev = before.current;
    before.current = { sig, days };
    if (!prev || prev.sig === sig || !sig) return;
    if (!reduce) LayoutAnimation.configureNext(LayoutAnimation.create(220, 'easeInEaseOut', 'opacity'));
    setUpdated(true);
    if (prev.days !== days) setOpen(true);
    stopTimer(updatedTimer);
    updatedTimer.current = setTimeout(() => setUpdated(false), UPDATED_MS);
  }, [sig, days, reduce]);

  const toggle = () => {
    if (!trip) return;
    if (!reduce) LayoutAnimation.configureNext(LayoutAnimation.create(220, 'easeInEaseOut', 'opacity'));
    setOpen(o => !o);
  };

  const summary = trip ? tripSummary(trip) : busy ? `${llm} is working out your days…` : 'Nothing yet: tell me your dates and what you love';
  return (
    <Glass kind={updated ? 'prominent' : 'clear'} radius={22} style={style}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open, disabled: !trip }}
        accessibilityLabel={`Your trip${updated ? ', updated' : ''}: ${summary}. ${open ? 'Hide' : 'Show'} the days`}
        disabled={!trip}
        onPress={toggle}
        {...axPress(toggle, !trip)}
        style={styles.tripHead}>
        <View style={styles.tripHeadText}>
          <Text style={[styles.tripTitle, updated && onGlass]}>
            Your trip
            {updated ? <Text style={styles.tripUpdated}>{'  ·  updated'}</Text> : null}
          </Text>
          <Text style={[styles.tripSummary, !trip && { color: dusk.color.pending }]} numberOfLines={1}>
            {summary}
          </Text>
        </View>
        {trip ? <Chevron up={open} /> : null}
      </Pressable>
      {open && trip ? (
        <View style={styles.tripBody}>
          <DayTiles trip={trip} today={today} onDay={onDay} />
          {trip.base || trip.interests.length > 0 ? (
            <View style={styles.pills}>
              {trip.base ? <Pill label={`Base · ${trip.base.name}`} /> : null}
              {trip.interests.map(i => (
                <Pill key={i} label={i.replace(/-/g, ' ')} />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </Glass>
  );
}

/** One tile per trip day: weekday, date and the first stop; a booked day or today is brighter. */
function DayTiles({ trip, today, onDay }: { trip: Trip; today: number | undefined; onDay: (date: string) => void }) {
  const count = Math.max(1, Math.min(trip.days, MAX_DAYS));
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tiles}>
      {Array.from({ length: count }, (_, k) => k + 1).map(day => {
        const date = addDays(trip.startDate, day - 1);
        const wd = weekday(date);
        const stops = trip.stops.filter(s => s.day === day);
        const fixed = stops.some(s => s.fixed);
        const bright = fixed || day === today;
        const what = stops[0]?.title ?? 'Free';
        const label = (
          <>
            <Text style={[styles.tileDay, bright && onGlass]}>
              {WEEKDAY_KEYS[wd].toUpperCase()}
              {day === 1 || dayOfMonth(date) === 1 ? ` ${monthShort(date).toUpperCase()}` : ''}
            </Text>
            <Text style={[styles.tileDate, bright && onGlass]}>{dayOfMonth(date)}</Text>
            <Text style={[styles.tileWhat, bright && onGlass]} numberOfLines={2}>
              {what}
            </Text>
          </>
        );
        return (
          <Pressable
            key={day}
            accessibilityRole="button"
            accessibilityLabel={`Day ${day}, ${WEEKDAY_NAMES[wd]} ${dayOfMonth(date)} ${monthShort(date)}: ${stops.length ? stops.map(s => s.title).join(', ') : 'free'}${fixed ? ', booked' : ''}. Open it in Now`}
            onPress={() => onDay(date)}
            {...axPress(() => onDay(date))}
            style={({ pressed }) => [styles.tileHit, pressed && { opacity: 0.8 }]}>
            {bright ? (
              <Glass kind="prominent" radius={16} blur={false} style={styles.tile}>
                {label}
              </Glass>
            ) : (
              <View style={[styles.tile, styles.tilePlain]}>{label}</View>
            )}
          </Pressable>
        );
      })}
    </ScrollView>
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

const styles = StyleSheet.create({
  root: { flex: 1, overflow: 'hidden', backgroundColor: dusk.color.ground },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { ...font('700'), flexShrink: 1, fontSize: 30, lineHeight: 36, letterSpacing: -0.5, color: dusk.color.text },
  models: { ...font('500'), fontSize: 11.5, lineHeight: 15, color: dusk.color.textSoft, marginTop: 1 },

  tripHead: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 9 },
  tripHeadText: { flex: 1, minWidth: 0 },
  tripTitle: { ...font('700'), fontSize: 15, lineHeight: 19, color: dusk.color.text },
  tripUpdated: { ...font('600'), fontSize: 12, color: dusk.color.white },
  tripSummary: { ...font('500'), fontSize: 12.5, lineHeight: 17, color: dusk.color.text2, marginTop: 1 },
  tripBody: { paddingBottom: 12, gap: 10 },
  tiles: { gap: 6, paddingHorizontal: 12 },
  tileHit: { minHeight: dusk.size.touch },
  tile: { flexGrow: 1, width: 78, paddingVertical: 8, paddingHorizontal: 9, borderRadius: 16 },
  tilePlain: { backgroundColor: white(0.06), borderWidth: 1, borderColor: white(0.1) },
  tileDay: { ...font('700'), fontSize: 11, letterSpacing: 0.5, color: dusk.color.text2 },
  tileDate: { ...font('300'), fontSize: 22, lineHeight: 26, color: dusk.color.text, fontVariant: ['tabular-nums'] },
  tileWhat: { ...font('500'), fontSize: 11, lineHeight: 13.5, color: dusk.color.textSoft },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center', paddingHorizontal: 12 },
  pill: { maxWidth: '100%', paddingVertical: 5, paddingHorizontal: 11 },
  pillText: { ...font('700'), fontSize: 12, color: dusk.color.text },

  chat: { flex: 1 },
  chatContent: { flexGrow: 1, justifyContent: 'flex-end', paddingTop: 6, paddingBottom: 10, gap: 10 },
  intro: { gap: 10, paddingBottom: 4 },
  introBig: { ...font('300'), letterSpacing: -0.4, color: dusk.color.text }, // size: fit().intro
  introSmall: { ...font('500'), fontSize: 13, lineHeight: 18, color: dusk.color.text2 },
  suggestions: { gap: 6, alignItems: 'flex-start', marginTop: 4 },
  suggestionHit: { minHeight: dusk.size.touch, justifyContent: 'center', maxWidth: '100%' },
  suggestion: { paddingVertical: 8, paddingHorizontal: 14 },
  suggestionText: { ...font('600'), fontSize: 13.5, lineHeight: 18, color: dusk.color.text },

  you: { alignSelf: 'flex-end', maxWidth: '84%', paddingVertical: 9, paddingHorizontal: 14 },
  youText: { ...font('500'), fontSize: 15.5, lineHeight: 21 },
  livePending: { color: dusk.color.textSoft },
  understood: { ...font('700'), color: dusk.color.white, backgroundColor: white(0.16) },
  buddyBlock: { alignSelf: 'stretch', alignItems: 'flex-start', gap: 6 },
  buddy: { maxWidth: '88%', paddingVertical: 10, paddingHorizontal: 15 },
  buddyText: { ...font('400'), fontSize: 15.5, lineHeight: 22, color: dusk.color.text },
  errorText: { color: dusk.color.text2 },
  status: { ...font('500'), fontSize: 12, lineHeight: 16, color: dusk.color.text2, marginLeft: 6 },
  dots: { flexDirection: 'row', gap: 5, paddingVertical: 7, paddingHorizontal: 2 },
  dot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: dusk.color.white },

  facts: { maxWidth: '88%', gap: 6, marginLeft: 4 },
  factsLabel: { ...font(dusk.font.label.weight), fontSize: dusk.font.label.size, letterSpacing: dusk.font.label.letterSpacing, color: dusk.color.text2 },
  fact: { paddingVertical: 9, paddingHorizontal: 12, gap: 3 },
  factTitle: { ...font('700'), fontSize: 13.5, lineHeight: 18, color: dusk.color.text },
  factBody: { ...font('400'), fontSize: 13, lineHeight: 18, color: dusk.color.textSoft },
  factSource: { ...font('500'), fontSize: 11, lineHeight: 14, color: dusk.color.text2, marginTop: 2 },

  dock: { alignItems: 'center' },
  caption: { ...font('500'), fontSize: 12, lineHeight: 16, color: dusk.color.textSoft, marginTop: 6, alignSelf: 'stretch', textAlign: 'center' },
  field: {
    alignSelf: 'stretch',
    height: FIELD_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 18,
    paddingRight: (FIELD_HEIGHT - SEND_SIZE) / 2,
  },
  // No fixed height: a macOS text field draws its text at the top of its frame, so the field keeps
  // its own height and equal vertical padding, and the pill centres it.
  input: { ...font('500'), flex: 1, minWidth: 0, fontSize: 15, color: dusk.color.white, paddingVertical: 12, paddingHorizontal: 0 },
  send: { width: SEND_SIZE, height: SEND_SIZE, alignItems: 'center', justifyContent: 'center' },
});
