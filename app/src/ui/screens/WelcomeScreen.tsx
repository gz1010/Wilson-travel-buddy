import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, NativeModules, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Ellipse, Path, Rect } from 'react-native-svg';
import type { Trip } from '../../core/types';
import { AmbientBackdrop } from '../dusk/AmbientBackdrop';
import { CityStack, prepareCommand, readHomeInput, tripCity } from '../dusk/CityCard';
import { axPress, Glass, GlassIconButton, OfflineChip, onGlass } from '../dusk/Glass';
import { ArrowIcon, CloseIcon } from '../dusk/Icons';
import { fileDropProps, ImportIcon, ImportSheet, type DroppedFile } from '../dusk/ImportSheet';
import { modelLine } from '../dusk/modelNames';
import { useScreenSize } from '../dusk/Screen';
import { dusk, font, ground, typeStyle, white } from '../dusk/tokens';
import type { Buddy } from '../useBuddy';
import type { WelcomeProps } from './types';

// The home: Wilson and the cities he knows, then "Plan your next journey" (after Echotera's home
// and Panora's stacked cards). From the top: the Offline chip; Wilson at 120 with his greeting
// (waking while the on-device models load); "Cities Wilson knows", one photo card per prepared city
// (Seville this round), each opening that city's guide; then the big title, an input asking where
// Wilson should go next and chips to upload or paste an itinerary instead; the on-device models at
// the bottom. A prepared city typed in the input opens; any other gets a glass note on how Wilson
// learns a city (once, while online, with scripts/prepare-pack.mjs) and that he then works offline.
// An imported itinerary opens Seville's guide when its places are Seville's; otherwise the note
// says which city it seems to be. The app never goes online, and never checks whether it could.
// One scrolling column: on a tall window the plan sits at the bottom, on a short one it scrolls.

/** Wilson's size on the home (the design's "120 · welcome"). */
const WILSON_SIZE = 120;
/** The column's widest, on a wide window. */
const MAX_COLUMN = 560;
/** Above the Offline chip, under the window's title bar. */
const TOP = 12;
/** The height everything but the city cards takes on a short window (measured at 390 × 700). */
const REST_HEIGHT = 532;
const CARD_MIN = 160;
/** A tall window gives the card the room (at 280 a 900 px window left ~100 px of nothing above the plan). */
const CARD_MAX = 340;
const CARD_GAP = 12;
// react-native-macos draws a rectangular focus ring around a focused field; the iOS typings don't know the prop.
const NO_FOCUS_RING: object = { enableFocusRing: false };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// --- Wilson, from dusk/Wilson.tsx (a builder working alongside this one), read defensively so the
// home builds and runs without it: then a plain glass orb with a face stands in, and the mood and
// the voice levels are read here from the Buddy object.

type WilsonMood = 'idle' | 'listening' | 'thinking' | 'speaking' | 'happy' | 'unsure' | 'waking';
interface WilsonProps {
  size?: number;
  mood: WilsonMood;
  level?: number | Animated.Value;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}
interface WilsonModule {
  Wilson?: React.ComponentType<WilsonProps>;
  wilsonMood?: (b: Buddy) => WilsonMood;
  /** wilsonMood that also re-renders when a happy or unsure moment ends. */
  useWilsonMood?: (b: object) => WilsonMood;
  /** The microphone or voice level, driven natively. */
  useWilsonLevel?: (b: object) => { level: Animated.Value; voice: boolean };
}

function loadWilson(): WilsonModule {
  try {
    const m = require('../dusk/Wilson') as WilsonModule | undefined;
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
}
const WILSON = loadWilson();
/** What Wilson's hooks read while he is waking (no Buddy yet): one stable empty object. */
const NO_BUDDY = {};

/** The Buddy's voice levels and wake word (useBuddy), read defensively: older builds have neither. */
type Levels = { subscribe?: (cb: (l: { mic?: number; voice?: number }) => void) => (() => void) | void };
const levelsOf = (b?: Buddy) => (b as unknown as { levels?: Levels } | undefined)?.levels;
const wakeOf = (b?: Buddy) => (b as unknown as { wake?: { enabled?: boolean; available?: boolean } } | undefined)?.wake;
/** True while Wilson listens on by himself after a spoken answer (useBuddy's call and response). */
const followUpOf = (b?: Buddy) => (b as unknown as { followUp?: boolean } | undefined)?.followUp === true;

const plainMood = (b: Buddy): WilsonMood => (b.listening ? 'listening' : b.speaking ? 'speaking' : b.busy ? 'thinking' : 'idle');

// The hooks are picked once, when this module loads, so every render calls the same ones.
function useKitMood(b?: Buddy): WilsonMood | undefined {
  return WILSON.useWilsonMood!(b ?? NO_BUDDY);
}
function useOwnMood(b?: Buddy): WilsonMood | undefined {
  try {
    return b && typeof WILSON.wilsonMood === 'function' ? WILSON.wilsonMood(b) : undefined;
  } catch {
    return undefined;
  }
}
const useMoodOf = typeof WILSON.useWilsonMood === 'function' ? useKitMood : useOwnMood;

function useKitLevel(b: Buddy | undefined): { level?: number | Animated.Value; voice: boolean } {
  return WILSON.useWilsonLevel!(b ?? NO_BUDDY);
}
/** Without Wilson's own hook: b.levels as React state (the microphone while listening, the voice while speaking). */
function useOwnLevel(b: Buddy | undefined): { level?: number | Animated.Value; voice: boolean } {
  const [level, setLevel] = useState(0);
  const subscribe = levelsOf(b)?.subscribe;
  const track = b?.listening ? 'mic' : b?.speaking ? 'voice' : undefined;
  useEffect(() => {
    if (!track) setLevel(0);
  }, [track]);
  useEffect(() => {
    if (!track || typeof subscribe !== 'function') return;
    let last = -1;
    let off: (() => void) | void;
    try {
      off = subscribe(l => {
        const v = clamp(Number(l?.[track]) || 0, 0, 1);
        if (Math.abs(v - last) < 0.02) return;
        last = v;
        setLevel(v);
      });
    } catch {
      off = undefined;
    }
    return () => {
      try {
        if (typeof off === 'function') off();
      } catch {
        // already gone
      }
    };
  }, [subscribe, track]);
  return { level, voice: typeof subscribe === 'function' };
}
const useLevelOf = typeof WILSON.useWilsonLevel === 'function' ? useKitLevel : useOwnLevel;

/**
 * Wilson at 120: waking until the on-device models are connected, then listening, thinking or
 * speaking with the app (his rings and mouth follow the microphone and his voice), unsure while the
 * home says a city isn't in his guides.
 */
function HomeWilson({ b, unsure, onPress }: { b?: Buddy; unsure: boolean; onPress?: () => void }) {
  const kit = useMoodOf(b);
  const { level, voice } = useLevelOf(b);
  const now = b ? kit ?? plainMood(b) : 'waking';
  const mood: WilsonMood = now === 'idle' && unsure ? 'unsure' : now;
  // With no voice level he talks by himself: leave the level out while he speaks.
  const shown = mood === 'speaking' && !voice ? undefined : level;
  const label = b ? 'Wilson. Tap to talk' : 'Wilson, waking up';
  const W = WILSON.Wilson;
  if (W) return <W size={WILSON_SIZE} mood={mood} level={shown} onPress={onPress} accessibilityLabel={label} />;
  return <StandInWilson size={WILSON_SIZE} mood={mood} onPress={onPress} />;
}

/** A glass orb with two eyes and a mouth of light, until dusk/Wilson.tsx is in the build. */
function StandInWilson({ size, mood, onPress }: { size: number; mood: WilsonMood; onPress?: () => void }) {
  const c = dusk.color.white;
  const line = { stroke: c, strokeWidth: 3.2, strokeLinecap: 'round' as const, fill: 'none' };
  const mouth =
    mood === 'listening' || mood === 'speaking' ? (
      <Ellipse cx={50} cy={64} rx={mood === 'speaking' ? 6 : 3.5} ry={mood === 'speaking' ? 5 : 3.5} {...line} strokeWidth={2.6} />
    ) : (
      <Path {...line} d={mood === 'unsure' ? 'M39 65 q5.5 -5 11 0 t11 0' : mood === 'thinking' || mood === 'waking' ? 'M42 64 h16' : 'M36 59 q14 12 28 0'} />
    );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Wilson"
      accessibilityHint={onPress ? 'Talk to Wilson' : 'Wilson is waking up'}
      disabled={!onPress}
      onPress={onPress}
      {...axPress(onPress, !onPress)}
      style={({ pressed }) => ({ opacity: pressed ? 0.9 : 1 })}>
      <Glass kind="orb" radius={size / 2} style={{ width: size, height: size }}>
        <Svg key={size} width={size} height={size} viewBox="0 0 100 100" style={StyleSheet.absoluteFill}>
          {mood === 'waking' ? (
            <Path {...line} strokeWidth={3} d="M33 45 q5 4 10 0 M57 45 q5 4 10 0" />
          ) : (
            <>
              <Ellipse cx={38} cy={44} rx={4} ry={6} fill={c} />
              <Ellipse cx={62} cy={44} rx={4} ry={6} fill={c} />
            </>
          )}
          {mouth}
        </Svg>
      </Glass>
    </Pressable>
  );
}

// --- Icons (decorative: the controls carry the labels).

const WifiIcon = ({ size = 15, color = dusk.color.text2 }: { size?: number; color?: string }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M2.5 9a14 14 0 0 1 19 0M5.8 12.6a9 9 0 0 1 12.4 0M9.1 16.1a4.3 4.3 0 0 1 5.8 0M12 19.6h.01" />
  </Svg>
);

const PasteIcon = ({ size = 16, color = dusk.color.white }: { size?: number; color?: string }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
    <Rect x={6} y={4.5} width={12} height={16.5} rx={2.2} />
    <Path d="M9.5 4.5V3.6c0-.6.5-1.1 1.1-1.1h2.8c.6 0 1.1.5 1.1 1.1v.9M9.5 10.5h5M9.5 14.5h5" />
  </Svg>
);

// --- The note under the plan: how Wilson learns a city he doesn't know yet.

type Note =
  /** Someone typed a city Wilson hasn't learned. */
  | { kind: 'learn'; city: string }
  /** A wish rather than a city ("somewhere warm"): how he learns one, with no city named. */
  | { kind: 'vague'; city?: undefined }
  /** An imported itinerary for another city (named if its places say which), nothing applied. */
  | { kind: 'itinerary'; city?: string };

/** The clipboard (NSPasteboard on the Mac), when this build has it. */
function clipboard(): { setString: (s: string) => void } | undefined {
  const m = (NativeModules as { Clipboard?: { setString?: (s: string) => void } }).Clipboard;
  return m && typeof m.setString === 'function' ? (m as { setString: (s: string) => void }) : undefined;
}

function LearnNote({ note, here, known, onClose }: { note: Note; here: string; known: string[]; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const city = note.city;
  const title =
    note.kind === 'learn'
      ? `Wilson hasn't learned ${city} yet`
      : note.kind === 'vague'
        ? 'Wilson learns one city at a time'
        : city
          ? `This itinerary looks like ${city}`
          : `None of these places are in Wilson's ${here} guide`;
  const lead =
    note.kind === 'itinerary'
      ? city
        ? `He needs to learn ${city} before he can guide you there, so nothing was added to your trip.`
        : 'If it is another city, he needs to learn it first, so nothing was added to your trip.'
      : note.kind === 'vague'
        ? 'Name the city you have in mind and he can learn it before you go.'
        : undefined;
  const command = prepareCommand(city ?? '');
  const clip = clipboard();
  const copy = () => {
    try {
      clip?.setString(command);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // The command stays selectable.
    }
  };
  return (
    <Glass kind="clear" radius={24} wash={ground(0.35)} style={styles.note}>
      <View style={styles.noteHead}>
        <Text style={styles.noteTitle} accessibilityRole="header">
          {title}
        </Text>
        <GlassIconButton accessibilityLabel="Close the note" onPress={onClose} size={30} kind="clear" blur={false}>
          <CloseIcon size={11} />
        </GlassIconButton>
      </View>
      {lead ? <Text style={styles.noteText}>{lead}</Text> : null}
      <Text style={styles.noteText}>
        Wilson learns a new city once, while you have Wi‑Fi: facts, photos, maps and weather (about 20 minutes). Then he works offline.
      </Text>
      <Text style={styles.noteSmall}>{"On a Mac that's online, in the project folder:"}</Text>
      <View style={styles.commandRow}>
        <View style={styles.command}>
          <Text style={styles.commandText} selectable accessibilityLabel={`Command: ${command}`}>
            {command}
          </Text>
        </View>
        {clip ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copied ? 'Copied' : 'Copy the command'}
            onPress={copy}
            {...axPress(copy)}
            style={({ pressed }) => ({ minHeight: dusk.size.touch, justifyContent: 'center', opacity: pressed ? 0.85 : 1 })}>
            <Glass kind={copied ? 'prominent' : 'clear'} radius={999} blur={false} style={styles.copy}>
              <Text style={[onGlass, styles.copyText]}>{copied ? 'Copied' : 'Copy'}</Text>
            </Glass>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.noteSmall}>
        {`${known.length > 1 ? `Prepared in this build: ${known.join(', ')}.` : `${known[0] ?? here} is the only city prepared in this build.`} The app itself never goes online, so it doesn't check your connection.`}
      </Text>
    </Glass>
  );
}

/** A chip under the input: an icon and a label on clear glass. */
function ActionChip({ icon, label, hint, onPress, disabled }: { icon: React.ReactNode; label: string; hint: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={disabled ? `${hint}. Available once Wilson is awake` : hint}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      {...axPress(onPress, disabled)}
      style={({ pressed }) => ({ minHeight: dusk.size.touch, justifyContent: 'center', opacity: disabled ? 0.45 : pressed ? 0.85 : 1 })}>
      <Glass kind="clear" radius={999} style={styles.chip}>
        {icon}
        <Text style={[onGlass, styles.chipText]}>{label}</Text>
      </Glass>
    </Pressable>
  );
}

// --- The home.

export function WelcomeScreen({ cities, onOpenCity, opening, status, models, b }: WelcomeProps) {
  const { width, height } = useScreenSize();
  const side = Math.round(clamp((20 * width) / dusk.layout.phoneWidth, 16, 26));
  const column = Math.min(width - 2 * side, MAX_COLUMN);
  const here = cities[0]?.name ?? b?.index.destination.name ?? 'Seville';
  // The cards share what the rest leaves; past their minimum the page scrolls.
  const n = Math.max(1, cities.length);
  const cardH = Math.round(clamp((height - REST_HEIGHT - CARD_GAP * (n - 1)) / n, CARD_MIN, CARD_MAX));
  const titleSize = Math.round(clamp(column * 0.11, 36, 50));

  const [typed, setTyped] = useState('');
  const [note, setNote] = useState<Note>();
  const scroll = useRef<ScrollView>(null);
  const bRef = useRef(b);
  bRef.current = b;
  const citiesRef = useRef(cities);
  citiesRef.current = cities;

  // A new note scrolls into view (on a short window it sits below the fold).
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(t);
  }, [note]);

  // --- What Wilson says: his greeting, then what he heard and answered since the home opened.
  const [since, setSince] = useState<number>();
  useEffect(() => {
    if (b && since === undefined) setSince(b.chat.length);
  }, [b, since]);
  const reply = b && since !== undefined ? [...b.chat.slice(since)].reverse().find(l => l.who === 'buddy') : undefined;
  // The wake word only where it works: switched on, and a helper with a microphone that has it.
  const wake = wakeOf(b);
  const wakeOn = !!wake && wake.enabled !== false && wake.available !== false;
  // A no-break space inside the quote, so a narrow bubble never leaves "…”" alone on a line.
  const hint = wakeOn ? 'Tap me, or start with “Wilson, …”' : 'Tap me to talk.';
  // After a spoken answer he listens on for a follow-up: his answer stays until a word is heard.
  const keepReply = !!b && followUpOf(b) && !b.partial && !!reply && !reply.pending;
  const openingName = opening ? cities.find(c => c.id === opening)?.name : undefined;
  // A question typed while he was still waking up: asked as soon as he is awake.
  const [queued, setQueued] = useState<string>();
  useEffect(() => {
    if (!b || !queued) return;
    setQueued(undefined);
    b.send(queued).catch(() => {});
  }, [b, queued]);
  let say = "Hi, I'm Wilson. I live on this Mac, so I work without signal.";
  let sub = b ? hint : `Waking up · ${status}`;
  if (!b && openingName) {
    say = `One moment, I'm still waking up. I'll open ${openingName} as soon as I'm ready.`;
  } else if (!b && queued) {
    say = "One moment, I'm still waking up. I'll answer as soon as I'm ready.";
  } else if (b?.listening && !keepReply) {
    say = b.partial || "I'm listening…";
    sub = 'Tap me when you’re done.';
  } else if (b && reply && (reply.pending || b.busy)) {
    say = reply.text || 'Let me think…';
    sub = b.status ?? `${b.runtime.llm.name} is thinking, on this Mac.`;
  } else if (b && reply) {
    say = reply.text;
    sub = b.speaking ? 'Tap me to stop.' : keepReply ? 'Still listening, in case there’s more…' : hint;
  }
  const tapWilson = useCallback(() => {
    const cur = bRef.current;
    if (!cur) return;
    // Tapping him while he talks stops him; otherwise it starts (or ends) listening.
    if (cur.speaking) cur.stopSpeaking();
    else cur.talk().catch(() => {});
  }, []);

  // --- The input: a prepared city opens; any other city gets the note on how Wilson learns one; a
  // question goes to Wilson, who answers in his bubble (and aloud).
  const submit = (text = typed) => {
    const read = readHomeInput(text, cities);
    if (!read) return;
    if (read.kind === 'city' || read.kind === 'ask') {
      setNote(undefined);
      setTyped('');
      if (read.kind === 'city') onOpenCity(read.city.id);
      else if (bRef.current) bRef.current.send(read.text).catch(() => {});
      else setQueued(read.text);
      return;
    }
    setNote(read.kind === 'vague' ? { kind: 'vague' } : { kind: 'learn', city: read.name });
  };

  // --- Itineraries: the import sheet (also opened by a file dropped on the home). Its Apply comes
  // here first: the trip's places decide the city. Seville's opens its guide with the trip; any
  // other leaves the trip as it was and the note says which city it seems to be.
  const [importing, setImporting] = useState<{ key: number; dropped?: DroppedFile; file?: boolean }>();
  const [dropping, setDropping] = useState(false);
  const importKey = useRef(0);
  /** `file`: Upload itinerary, so the sheet opens straight on the Mac's file panel. */
  const openImport = useCallback((dropped?: DroppedFile, file?: boolean) => {
    if (!bRef.current) return;
    setNote(undefined);
    setImporting({ key: ++importKey.current, dropped, file });
  }, []);
  const drop = useMemo(() => fileDropProps(file => file && openImport(file), over => setDropping(over && !!bRef.current)), [openImport]);
  const onOpenCityRef = useRef(onOpenCity);
  onOpenCityRef.current = onOpenCity;
  const applyImported = useCallback(async (trip: Trip) => {
    const cur = bRef.current;
    if (!cur) return;
    const verdict = tripCity(trip, cur.index, citiesRef.current);
    // Only the pack this build runs can take a trip (one city this round).
    if (verdict.kind === 'known' && verdict.city.id === cur.index.destination.id) {
      await cur.importTrip(trip);
      onOpenCityRef.current(verdict.city.id);
      return;
    }
    setNote({ kind: 'itinerary', city: verdict.kind === 'other' ? verdict.name : verdict.kind === 'known' ? verdict.city.name : undefined });
  }, []);
  const sheetB = useMemo(() => (b ? { ...b, importTrip: applyImported } : undefined), [b, applyImported]);
  /** The same check, for the sheet's preview: it says so before Apply, instead of "Apply replaces your trip". */
  const refuseImported = useCallback((trip: Trip) => {
    const cur = bRef.current;
    if (!cur) return undefined;
    const verdict = tripCity(trip, cur.index, citiesRef.current);
    if (verdict.kind === 'known' && verdict.city.id === cur.index.destination.id) return undefined;
    const other = verdict.kind === 'other' ? verdict.name : verdict.kind === 'known' ? verdict.city.name : undefined;
    return other
      ? `This looks like a ${other} trip. Wilson hasn't learned ${other} yet, so your trip stays as it is.`
      : `None of these places are in Wilson's ${cur.index.destination.name} guide, so your trip stays as it is.`;
  }, []);

  const awake = !!b;
  const modelsText = models && models.length > 0 ? `On this Mac: ${modelLine(models[0], models.slice(1))}` : `On this Mac · ${status}`;

  return (
    <View style={styles.root} {...drop}>
      {/* The first city's photo, blurred and darkened behind everything, so the glass has colour to bend. */}
      <AmbientBackdrop source={cities[0]?.photo} strength={0.78} />
      <ScrollView ref={scroll} style={StyleSheet.absoluteFill} contentContainerStyle={[styles.scroll, { minHeight: height, paddingHorizontal: side }]} showsVerticalScrollIndicator={false}>
        <View style={[styles.column, { width: column }]}>
          <View style={styles.topBar}>
            <OfflineChip />
          </View>

          <View style={styles.wilsonRow}>
            {/* Always a press handler (it does nothing while he wakes): Wilson builds a different
                tree with and without one, and swapping it as he wakes cut his face animation short. */}
            <HomeWilson b={b} unsure={!!note && note.kind !== 'vague'} onPress={tapWilson} />
            <Glass kind="clear" radius={22} style={styles.bubble}>
              <Text style={styles.bubbleText} numberOfLines={6} accessibilityLiveRegion="polite">
                {say}
              </Text>
              <Text style={styles.bubbleSub} numberOfLines={2}>
                {sub}
              </Text>
            </Glass>
          </View>

          <Text style={styles.label} accessibilityRole="header">
            Cities Wilson knows
          </Text>
          <CityStack cities={cities} cardHeight={cardH} opening={opening} onOpen={onOpenCity} />

          <View style={styles.spacer} />

          <Text style={styles.lead}>Somewhere new?</Text>
          <Text style={[styles.title, { fontSize: titleSize, lineHeight: Math.round(titleSize * 1.06) }]} accessibilityRole="header" accessibilityLabel="Plan your next journey">
            {'Plan your\nnext journey'}
          </Text>
          <View style={styles.concept}>
            <WifiIcon />
            <Text style={styles.conceptText}>Wilson learns a city once on Wi‑Fi, then works offline</Text>
          </View>

          <Glass kind="clear" radius={dusk.radius.pill} style={styles.field}>
            <TextInput
              accessibilityLabel="Where should Wilson explore next?"
              accessibilityHint="A city, or a question for Wilson"
              value={typed}
              onChangeText={t => {
                setTyped(t);
                if (note?.kind === 'learn' || note?.kind === 'vague') setNote(undefined);
              }}
              onSubmitEditing={e => submit(e.nativeEvent.text)}
              submitBehavior="submit"
              placeholder="Where should Wilson explore next?"
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
              accessibilityLabel="Go"
              accessibilityState={{ disabled: !typed.trim() }}
              disabled={!typed.trim()}
              onPress={() => submit()}
              {...axPress(() => submit(), !typed.trim())}
              hitSlop={(dusk.size.touch - 38) / 2}
              style={({ pressed }) => ({ opacity: !typed.trim() ? 0.45 : pressed ? 0.85 : 1 })}>
              <Glass kind="prominent" radius={19} blur={false} style={styles.go}>
                <ArrowIcon size={17} strokeWidth={2.4} bearing={90} />
              </Glass>
            </Pressable>
          </Glass>

          <View style={styles.chips}>
            <ActionChip icon={<ImportIcon size={15} />} label="Upload itinerary" hint="A calendar file (.ics) or a text file" onPress={() => openImport(undefined, true)} disabled={!awake} />
            <ActionChip icon={<PasteIcon size={15} />} label="Paste itinerary" hint="Paste your itinerary's text" onPress={() => openImport()} disabled={!awake} />
          </View>

          {note ? <LearnNote note={note} here={here} known={cities.map(c => c.name)} onClose={() => setNote(undefined)} /> : null}

          <Text style={styles.models} numberOfLines={2} accessibilityLiveRegion="polite">
            {modelsText}
          </Text>
        </View>
      </ScrollView>

      {dropping && !importing ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.dropZone]}>
          <Glass kind="prominent" radius={dusk.radius.card} style={styles.dropCard}>
            <ImportIcon size={28} strokeWidth={2} />
            <Text style={[onGlass, styles.dropTitle]}>Drop to import your itinerary</Text>
            <Text style={styles.dropSub}>A calendar file (.ics) or a text file</Text>
          </Glass>
        </View>
      ) : null}
      {importing && sheetB ? (
        <ImportSheet key={importing.key} b={sheetB} dropped={importing.dropped} startWithFile={importing.file} refuse={refuseImported} onClose={() => setImporting(undefined)} top={44} bottom={26} side={side} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: dusk.color.ground, overflow: 'hidden' },
  scroll: { flexGrow: 1, alignItems: 'center', paddingTop: TOP, paddingBottom: 18 },
  column: { flexGrow: 1 },
  topBar: { height: 28, flexDirection: 'row', justifyContent: 'flex-end' },
  wilsonRow: { marginTop: 6, flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: WILSON_SIZE },
  bubble: { flex: 1, minWidth: 0, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12 },
  bubbleText: { ...font('500'), fontSize: 16, lineHeight: 21, letterSpacing: -0.2, color: dusk.color.text },
  bubbleSub: { ...typeStyle('caption'), fontSize: 12.5, marginTop: 6, color: dusk.color.text2 },
  label: { ...typeStyle('label'), color: dusk.color.text2, marginTop: 16, marginBottom: 10, marginLeft: 4 },
  spacer: { flexGrow: 1, minHeight: 18 },
  lead: { ...font('600'), fontSize: 15, lineHeight: 20, color: dusk.color.textSoft, marginLeft: 2 },
  title: { ...font('300'), letterSpacing: -1.2, color: dusk.color.text, marginTop: 2 },
  concept: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, marginLeft: 2 },
  // 12.5: one line from the narrowest window (390) up (measured: 317 of the 325 px it has there).
  conceptText: { ...typeStyle('caption'), fontSize: 12.5, lineHeight: 17, color: dusk.color.text2, flexShrink: 1 },
  field: { marginTop: 12, height: 52, flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 7, gap: 8 },
  input: { ...font('500'), flex: 1, minWidth: 0, fontSize: 15, color: dusk.color.white, paddingVertical: 12, paddingHorizontal: 0 },
  go: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 10, marginTop: 4 },
  chip: { height: 38, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 14 },
  chipText: { ...font('700'), fontSize: 13 },
  note: { marginTop: 10, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 14, gap: 8 },
  noteHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  noteTitle: { ...font('700'), flexShrink: 1, fontSize: 16, lineHeight: 21, letterSpacing: -0.2, color: dusk.color.text },
  noteText: { ...font('500'), fontSize: 13.5, lineHeight: 19, color: dusk.color.textSoft },
  noteSmall: { ...typeStyle('caption'), color: dusk.color.text2 },
  commandRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  command: { flex: 1, minWidth: 0, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: ground(0.55), borderWidth: StyleSheet.hairlineWidth, borderColor: white(0.16) },
  commandText: { ...font('600'), fontSize: 12.5, lineHeight: 17, color: dusk.color.text },
  copy: { height: 34, justifyContent: 'center', paddingHorizontal: 14 },
  copyText: { ...font('700'), fontSize: 12.5 },
  models: { ...typeStyle('caption'), color: dusk.color.text2, marginTop: 10, textAlign: 'center' },
  dropZone: { alignItems: 'center', justifyContent: 'center', backgroundColor: ground(0.45) },
  dropCard: { alignItems: 'center', gap: 8, paddingHorizontal: 28, paddingVertical: 24 },
  dropTitle: { ...font('700'), fontSize: 17 },
  dropSub: { ...font('500'), fontSize: 13, color: dusk.color.textSoft },
});
