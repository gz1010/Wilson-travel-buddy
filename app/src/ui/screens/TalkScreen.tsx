import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { conversationLanguages, isLang, LANG_NATIVE, LANGS, SideAssigner } from '../../core/translate';
import { LANG_NAMES, type Lang, type Side, type TurnEvent } from '../../core/types';
import { axPress, Glass, GlassChip, GlassIconButton, onGlass } from '../dusk/Glass';
import { CloseIcon } from '../dusk/Icons';
import { LiquidBackground, moodHex } from '../dusk/LiquidBackground';
import { tidyModel } from '../dusk/modelNames';
import { useReduceMotion } from '../dusk/motion';
import { dusk, font, ground } from '../dusk/tokens';
import type { ScreenProps } from './types';
import { useScreenSize } from '../dusk/Screen';

// Translate (AntTalk; the screen is still called `talk`): the conversation translator. The phone
// lies flat between two people. The top half is the local's, turned 180° so it reads the right way
// up for them; the bottom half is the traveller's. Argmax hears both and labels who is speaking;
// Bonsai-2 translates each finished sentence and Argmax speaks it in the other language. The logic
// is adapted from the classic src/ui/translator/TranslatorScreen.tsx (SideAssigner, turn ids,
// push-to-talk, muting).
//
// Languages: the traveller speaks the home language (English unless they pick another); the local
// speaks whatever language Argmax hears from them, any of the ten the voice speaks, until someone
// pins one. Each half shows its language on a chip ("Français · detected"); tapping the chip picks
// one of the ten. The half that is speaking (a person talking, or the app speaking the translation
// in that half's language) lights up: its glass takes the half's colour, warm for the local and
// cool for the traveller, with a gentle glow, and the liquid background behind (Chat's) takes
// the same colour, rising from that half and swelling with the voice.
//
// Layout, top to bottom: the local's half, a fixed band the status pill sits in (on the divider),
// the traveller's half with the footer, then the bottom TAB_BAR_SPACE left free for the tab bar
// DuskRoot draws over this screen. Every height comes from useScreenSize(), so it fits 390×844 and
// the 390×700 minimum; each translation gets the room left in its half and shrinks to fit it.

interface Turn {
  id: number;
  side: Side;
  original: string;
  translation: string;
  /** False while Bonsai-2 is still streaming the translation. */
  done: boolean;
  from: Lang;
  to: Lang;
  /** Argmax's speaker label for this sentence, when diarization produced one. */
  speaker?: number;
}

type Mode = 'auto' | 'push';

/** The traveller's language until they pick another. */
const HOME: Lang = 'en';
/**
 * Each half's colour while it speaks: cool for the traveller (the map's "you" blue, Chat's
 * listening colour), warm for the local (Chat's speaking amber, from the Dusk scene colours).
 */
const COOL = dusk.color.you;
const WARM = moodHex('speaking');
const ACCENT: Record<Side, string> = { traveler: COOL, local: WARM };
const PHONE_W = dusk.layout.phoneWidth;
const PILL_H = 52;
/** The fixed band between the halves; the status pill sits in it, on the divider. */
const BAND = 72;
/** The bottom strip left free for the floating tab bar (DuskRoot renders it on this screen). */
const TAB_BAR_SPACE = 100;
const GAP = 10;
/** The traveller's footer row (model line and Push-to-talk chip, 42 tall) and the gap above it. */
const FOOTER = 42 + GAP;
/** Space between a half's text and the band, and the traveller's padding above the tab bar. */
const CLEAR = 8;
const TOP_PAD = 16;
const BOTTOM_PAD = 12;
/** Line heights of the small lines around a translation: the speaker (11 px), the original (14 px). */
const SMALL_LINE = 15;
/** The row with the half's label and its language chip. */
const CHIP_H = 28;
/** How far each half's glass sits in from the screen's sides, and from the half's own edges. */
const GLASS_INSET = 12;
const GLASS_GAP = 6;
const ORIGINAL_LINE = 19;
/** Design sizes of the translations: the local's (larger, read from across the table) and the traveller's. */
const LOCAL_SIZE = 38;
const TRAVELLER_SIZE = 32;

const lineHeightFor = (size: number) => Math.round(size * (size > 34 ? 1.05 : 1.1));

/**
 * The font size for a translation of `chars` characters in a box of `width` × `height`: the design
 * size when it fits, smaller (down to 55%) for long text, with a matching line height, and the
 * number of lines that fit. SF Pro Light averages 0.41 em a character at the -0.02 em tracking
 * used here (0.43 em untracked), and wrapping at word ends loses about two characters a line.
 * Text's adjustsFontSizeToFit shrinks it further on the Mac if this estimate falls short.
 */
function fitText(chars: number, base: number, width: number, height: number) {
  const linesAt = (size: number) => Math.ceil(Math.max(chars, 1) / Math.max(4, Math.floor(width / (size * 0.42)) - 2));
  const min = Math.round(base * 0.55);
  let size = base;
  while (size > min && linesAt(size) * lineHeightFor(size) > height) size -= 2;
  size = Math.max(size, min);
  const lineHeight = lineHeightFor(size);
  return { size, lineHeight, lines: Math.max(1, Math.floor(height / lineHeight)) };
}

/** Heights for the screen at this size (see the top of the file). */
function talkLayout(width: number, height: number, push: boolean) {
  const side = Math.round(26 * (width / PHONE_W));
  const usable = Math.max(height - TAB_BAR_SPACE, 360 + BAND + FOOTER);
  // The traveller's half also holds the footer row, so it is that much taller: both translations get the same room.
  const top = Math.floor((usable - BAND - FOOTER) / 2);
  const bottom = usable - BAND - top;
  const hold = push ? dusk.size.button + GAP : 0;
  // The local's text sits near their edge of the phone (the top of the screen), a little closer in push-to-talk.
  const localEdge = Math.max(16, Math.min(48, Math.round(top * 0.13)) - (push ? 16 : 0));
  /** Room for the translation in a block of `block` px, and how many lines the original under it may take. */
  const room = (block: number, base: number) => {
    const fixed = CHIP_H + 3 * GAP + SMALL_LINE + hold;
    const two = block - fixed - 2 * ORIGINAL_LINE;
    return two >= 2 * lineHeightFor(base) ? { text: two, originalLines: 2 } : { text: block - fixed - ORIGINAL_LINE, originalLines: 1 };
  };
  return {
    side,
    textWidth: width - 2 * side,
    top,
    bottom,
    pillTop: top + (BAND - PILL_H) / 2,
    localEdge,
    local: room(top - localEdge - CLEAR, LOCAL_SIZE),
    traveller: room(bottom - TOP_PAD - BOTTOM_PAD - FOOTER, TRAVELLER_SIZE),
  };
}

/** Copy for the local's half: Spanish when the local's language is Spanish, English otherwise. */
function localCopy(local: Lang) {
  const es = local === 'es';
  const name = LANG_NAMES[local];
  return {
    label: es ? 'EL VIAJERO DICE' : 'THE TRAVELLER SAYS',
    empty: es ? 'Lo que diga el viajero aparecerá aquí, en español.' : `What the traveller says appears here, in ${name}.`,
    hold: es ? 'Mantenga para hablar español' : `Hold to speak ${name}`,
    holding: es ? 'Escuchando… suelte al terminar' : 'Listening… release when done',
    wait: es ? 'Espere: suena la traducción…' : 'Wait: playing the translation…',
    speaker: es ? 'Argmax · hablante' : 'Argmax · speaker',
    half: es ? 'Para la persona local' : 'For the local person',
    /** The language chip: how the language was found, and the picker's first choice. */
    detected: es ? 'detectado' : 'detected',
    pinned: es ? 'fijado' : 'pinned',
    expected: 'auto',
    auto: es ? 'Detectar' : 'Auto-detect',
    change: es ? 'Cambiar el idioma' : 'Change the language',
  };
}

/** What the chips show: the traveller's language, and the local's with how it was found. */
interface Langs {
  home: Lang;
  local: Lang;
  source: 'pinned' | 'detected' | 'expected';
  pin?: Lang;
}
const langsOf = (s: SideAssigner): Langs => ({ home: s.homeLanguage, local: s.localLanguage, source: s.localSource, pin: s.localPin });
const sameLangs = (a: Langs, b: Langs) => a.home === b.home && a.local === b.local && a.source === b.source && a.pin === b.pin;

/** A '#RRGGBB' token at this opacity, for Glass tints and glows. */
function alpha(hex: string, a: number) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${a})`;
}

export function TalkScreen({ b, nav }: ScreenProps) {
  const { width, height } = useScreenSize();
  const reduce = useReduceMotion();

  /** The destination's language: the local's until Argmax hears another or one is pinned. */
  const destination = b.index.destination.language;
  /** Who said what, and the languages: the logic reads this; the chips show its snapshot, `langs`. */
  const sides = useMemo(() => new SideAssigner(HOME, destination), [destination]);
  const [langs, setLangs] = useState<Langs>(() => langsOf(sides));
  const syncLangs = useCallback(() => setLangs(prev => (sameLangs(prev, langsOf(sides)) ? prev : langsOf(sides))), [sides]);
  useEffect(syncLangs, [syncLangs]);
  const { home, local } = langs;
  const copy = useMemo(() => localCopy(local), [local]);
  const { audio } = b.runtime;
  const translator = b.companion.translator;
  const { stopSpeaking: stopBuddySpeaking, listening: buddyListening } = b;

  const [mode, setMode] = useState<Mode>('auto');
  const [turns, setTurns] = useState<Turn[]>([]);
  /** Speech still being heard. known: whose it is was told (a held button, its language or its voice), not guessed. */
  const [live, setLive] = useState<{ side: Side; text: string; known: boolean } | undefined>();
  const [running, setRunning] = useState(false);
  const [holding, setHolding] = useState<Side | undefined>();
  /** The translation being spoken aloud right now, and the half it is for (the microphone is muted meanwhile). */
  const [playing, setPlaying] = useState<{ lang: Lang; side: Side } | undefined>();
  /** The half whose language picker is open. */
  const [picking, setPicking] = useState<Side | undefined>();

  const stopRef = useRef<(() => void) | undefined>(undefined);
  const holdingRef = useRef<Side | undefined>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());
  /** Push-to-talk: which side each turn id belongs to. The helper echoes the id on the turn's final. */
  const turnSides = useRef(new Map<string, Side>());
  const turnCounter = useRef(0);
  const holdingTurn = useRef<string | undefined>(undefined);
  /** Which side each Argmax speaker was given, so live partials land in the right half. */
  const speakerSides = useRef(new Map<number, Side>());
  const counter = useRef(0);
  /** Goes up on every stop, so translations queued before it are not spoken. */
  const gen = useRef(0);

  // --- Live waveform: driven by the helper's level events (0..1). The typed stand-in sends no
  // levels, so each partial word gives a short pulse instead. Reduce-motion keeps the bars still.
  const level = useRef(new Animated.Value(1)).current;
  const lastLevelAt = useRef(0);
  // The same levels for the liquid background behind the halves.
  const levelListeners = useRef(new Set<(v: number) => void>()).current;
  const subscribeLevel = useCallback(
    (fn: (v: number) => void) => {
      levelListeners.add(fn);
      return () => {
        levelListeners.delete(fn);
      };
    },
    [levelListeners],
  );
  const reduceRef = useRef(reduce);
  reduceRef.current = reduce;
  const animateLevel = useCallback(
    (to: number, duration: number) => {
      if (reduceRef.current) return;
      Animated.timing(level, { toValue: to, duration, useNativeDriver: true }).start();
    },
    [level],
  );
  const pulse = useCallback(() => {
    if (reduceRef.current || Date.now() - lastLevelAt.current < 600) return;
    Animated.sequence([
      Animated.timing(level, { toValue: 0.5 + Math.random() * 0.5, duration: 90, useNativeDriver: true }),
      Animated.timing(level, { toValue: 0.15, duration: 260, useNativeDriver: true }),
    ]).start();
  }, [level]);
  useEffect(() => {
    if (reduce) level.setValue(1);
  }, [reduce, level]);

  const onFinal = useCallback(
    (text: string, language: Lang | undefined, speaker: number | undefined, turn: string | undefined) => {
      // In push-to-talk every release gets exactly one final with its turn id, even an empty one.
      const pressed = turn ? turnSides.current.get(turn) : undefined;
      if (turn) turnSides.current.delete(turn);
      if (!text.trim()) {
        setLive(undefined);
        return;
      }
      // The helper may name any of Whisper's ~100 languages; only the ten count.
      const heard = isLang(language) ? language : undefined;
      const who = pressed ?? sides.assign(speaker, heard);
      if (speaker !== undefined && !pressed) speakerSides.current.set(speaker, who);
      // A sentence from the local in a new language makes that the local's language (unless pinned).
      sides.hear(who, heard);
      syncLangs();
      const { from, to } = pressed ? sides.pressedDirection(pressed, heard) : sides.direction(who, heard);
      const id = ++counter.current;
      const myGen = gen.current;
      setLive(undefined);
      setTurns(t => [...t, { id, side: who, original: text, translation: '', done: false, from, to, speaker }]);
      // Translate and speak in order, one turn at a time; mute the microphone while speaking.
      queue.current = queue.current.then(async () => {
        let out = '';
        let failed = false;
        try {
          out = await translator.translate(text, from, to, tok => {
            out += tok;
            setTurns(t => t.map(x => (x.id === id ? { ...x, translation: out } : x)));
          });
        } catch (e) {
          failed = true;
          out = `(translation failed: ${e instanceof Error ? e.message : e})`;
        }
        setTurns(t => t.map(x => (x.id === id ? { ...x, translation: out, done: true } : x)));
        if (failed || myGen !== gen.current) return;
        // The translation is for the other person: their half lights up while it plays.
        setPlaying({ lang: to, side: who === 'traveler' ? 'local' : 'traveler' });
        audio.setMuted(true);
        await audio.speak(out, to).catch(() => {});
        if (myGen !== gen.current) return; // stop() already unmuted
        audio.setMuted(false);
        setPlaying(undefined);
      });
    },
    [audio, sides, syncLangs, translator],
  );

  const start = useCallback(
    (m: Mode, keepTurns = false) => {
      // The companion's own voice and microphone give way to the conversation.
      stopBuddySpeaking();
      if (buddyListening) audio.stopListening();
      // A restart that keeps the turns (a mode switch, a new pin) keeps the local's language too.
      sides.reset(!keepTurns);
      syncLangs();
      speakerSides.current.clear();
      turnSides.current.clear();
      if (!keepTurns) setTurns([]);
      setRunning(true);
      level.setValue(reduceRef.current ? 1 : 0);
      stopRef.current = audio.conversation(
        // The traveller's language first, then the local's pin, or all ten for Argmax to pick from.
        conversationLanguages(sides.homeLanguage, sides.localPin),
        (e: TurnEvent) => {
          if (e.type === 'level') {
            lastLevelAt.current = Date.now();
            animateLevel(e.value, 90);
            levelListeners.forEach(fn => fn(e.value));
          } else if (e.type === 'partial') {
            // Whose speech this is: the held button's, else its language so far, else the voice's last side.
            const known =
              holdingRef.current ??
              sides.sideOf(isLang(e.language) ? e.language : undefined) ??
              (e.speaker !== undefined ? speakerSides.current.get(e.speaker) : undefined);
            setLive({ side: known ?? 'traveler', text: e.text, known: known !== undefined });
            pulse();
          } else if (e.type === 'final') {
            onFinal(e.text, e.language, e.speaker, e.turn);
          }
        },
        { pushToTalk: m === 'push' },
      );
    },
    [animateLevel, audio, buddyListening, level, levelListeners, onFinal, pulse, sides, stopBuddySpeaking, syncLangs],
  );

  const stop = useCallback(() => {
    gen.current++;
    stopRef.current?.();
    stopRef.current = undefined;
    if (holdingTurn.current) audio.turnEnd(holdingTurn.current);
    holdingTurn.current = undefined;
    holdingRef.current = undefined;
    audio.stopSpeaking();
    audio.setMuted(false);
    setRunning(false);
    setLive(undefined);
    setHolding(undefined);
    setPlaying(undefined);
    level.setValue(1);
    levelListeners.forEach(fn => fn(0));
  }, [audio, level, levelListeners]);

  // Stop listening when the screen goes away.
  useEffect(() => stop, [stop]);

  const toggle = () => (running ? stop() : start(mode));

  // Switching mode restarts listening in the new mode, keeping what was said.
  const switchMode = () => {
    const next: Mode = mode === 'push' ? 'auto' : 'push';
    setMode(next);
    if (running) {
      stop();
      start(next, true);
    }
  };

  const close = () => {
    stop();
    nav.go('now');
  };

  // Picking a language from a chip. The traveller's is their language; the local's is pinned, or
  // detected again with Auto-detect. A running conversation restarts with the new languages,
  // keeping what was said.
  const pick = (who: Side, lang: Lang | undefined) => {
    setPicking(undefined);
    if (who === 'traveler') {
      if (!lang || lang === sides.homeLanguage) return;
      sides.setHome(lang); // also drops a local pin on that language
    } else {
      if (lang === sides.localPin || lang === sides.homeLanguage) return;
      sides.pinLocal(lang);
    }
    syncLangs();
    if (running) {
      stop();
      start(mode, true);
    }
  };
  const togglePicker = (who: Side) => setPicking(p => (p === who ? undefined : who));

  const press = (who: Side) => {
    if (!running || holdingTurn.current) return;
    const turn = `t${++turnCounter.current}`;
    turnSides.current.set(turn, who);
    holdingTurn.current = turn;
    holdingRef.current = who;
    setHolding(who);
    // The traveller's button is their language; the local's is the pinned one, else Argmax listens for any.
    audio.turnStart(turn, who === 'traveler' ? sides.homeLanguage : sides.localPin);
  };
  const release = (who: Side) => {
    if (holdingRef.current !== who || !holdingTurn.current) return;
    const turn = holdingTurn.current;
    holdingTurn.current = undefined;
    holdingRef.current = undefined;
    setHolding(undefined);
    audio.turnEnd(turn);
  };

  // --- What each half shows: the latest utterance of the other person, translated.
  const lastOf = (who: Side) => {
    for (let i = turns.length - 1; i >= 0; i--) if (turns[i].side === who) return turns[i];
    return undefined;
  };
  const traveler = lastOf('traveler');
  const localTurn = lastOf('local');

  // Who is talking, when we know (a held button, or the language or voice of what is heard so far).
  const talking = holding ?? (live?.known ? live.side : undefined);
  // The half that lights up: the person talking, else the half a translation is playing for.
  const lit: Side | undefined = talking ?? playing?.side;
  const code = (l: Lang) => l.toUpperCase();
  const status = !running
    ? 'Tap to translate'
    : talking
      ? `${talking === 'traveler' ? 'Traveller' : 'Receiver'} is talking · ${talking === 'traveler' ? `${code(home)} → ${code(local)}` : `${code(local)} → ${code(home)}`}`
      : playing
        ? `Speaking ${LANG_NAMES[playing.lang]}…`
        : mode === 'push'
          ? 'Hold a button to talk'
          : 'Listening…';
  const localState = langs.source === 'pinned' ? copy.pinned : langs.source === 'detected' ? copy.detected : copy.expected;

  const audioModel = audio.info.models[0];
  const push = mode === 'push';
  const L = useMemo(() => talkLayout(width, height, push), [width, height, push]);
  const holdLabel = (who: Side) => {
    const mine = holding === who;
    if (who === 'traveler') return mine ? (playing ? 'Wait: playing the translation…' : 'Listening… release when done') : `Hold to speak ${LANG_NAMES[home]}`;
    return mine ? (playing ? copy.wait : copy.holding) : copy.hold;
  };

  // Each half's glass: in from the screen's sides, and a little in from the band and the edges.
  const glassBox: ViewStyle = { left: GLASS_INSET, right: GLASS_INSET, top: GLASS_GAP, bottom: GLASS_GAP };

  return (
    <View accessibilityLabel="Translate" style={styles.root}>
      {/* Chat's liquid sky: the talking half's colour rises from its side of the screen. */}
      <LiquidBackground mood={lit === 'local' ? 'speaking' : lit === 'traveler' ? 'listening' : 'idle'} glowAt={lit === 'local' ? 0 : 1} subscribeLevel={subscribeLevel} />

      {/* The local's half, upside down so it faces them across the phone. */}
      <Flipped width={width} height={L.top} accessibilityLabel={copy.half}>
        <HalfGlass lit={lit === 'local'} color={ACCENT.local} style={glassBox} />
        <View pointerEvents="box-none" style={[styles.localBlock, { paddingHorizontal: L.side, paddingTop: CLEAR, paddingBottom: L.localEdge }]}>
          <View style={styles.labelRow}>
            <Text style={[styles.label, { color: dusk.color.textSoft }]} numberOfLines={1}>
              {copy.label}
            </Text>
            <LangChip
              label={`${LANG_NATIVE[local]} · ${localState}`}
              accessibilityLabel={`${LANG_NAMES[local]}, ${localState}. ${copy.change}`}
              accent={ACCENT.local}
              strong={langs.source !== 'expected'}
              flash={`${local}:${langs.source}`}
              open={picking === 'local'}
              onPress={() => togglePicker('local')}
            />
          </View>
          {picking === 'local' ? (
            <LangPicker selected={langs.pin} auto={copy.auto} exclude={home} accent={ACCENT.local} onPick={l => pick('local', l)} />
          ) : (
            <Utterance
              turn={traveler}
              live={live?.side === 'traveler' ? live.text : undefined}
              empty={copy.empty}
              base={LOCAL_SIZE}
              width={L.textWidth}
              height={L.local.text}
              originalLines={L.local.originalLines}
              lang={traveler?.to ?? local}
              originalLang={traveler?.from ?? home}
              originalColor={dusk.color.textSoft}
              speakerLabel={copy.speaker}
            />
          )}
          {push && (
            <HoldButton label={holdLabel('local')} active={holding === 'local'} disabled={!running} onPressIn={() => press('local')} onPressOut={() => release('local')} />
          )}
        </View>
      </Flipped>

      {/* The band the status pill sits in (the pill itself is drawn last, on top). */}
      <View style={{ height: BAND }} />

      {/* The traveller's half, ending above the tab bar. Its glass ends above the footer row. */}
      <View accessibilityLabel="For you" style={[styles.half, { height: L.bottom, paddingTop: TOP_PAD, paddingHorizontal: L.side, paddingBottom: BOTTOM_PAD }]}>
        <HalfGlass lit={lit === 'traveler'} color={ACCENT.traveler} style={[glassBox, { bottom: BOTTOM_PAD + FOOTER - GAP / 2 }]} />
        <View style={styles.labelRow}>
          <Text style={[styles.label, { color: dusk.color.text2 }]} numberOfLines={1}>
            THE LOCAL SAYS
          </Text>
          <LangChip
            label={`${LANG_NATIVE[home]} · you`}
            accessibilityLabel={`Your language: ${LANG_NAMES[home]}. Change it`}
            accent={ACCENT.traveler}
            strong
            flash={home}
            open={picking === 'traveler'}
            onPress={() => togglePicker('traveler')}
          />
        </View>
        {picking === 'traveler' ? (
          <LangPicker selected={home} accent={ACCENT.traveler} onPick={l => pick('traveler', l)} />
        ) : (
          <Utterance
            turn={localTurn}
            live={live?.side === 'local' ? live.text : undefined}
            empty={`What the local says appears here, in ${LANG_NAMES[home]}.`}
            base={TRAVELLER_SIZE}
            width={L.textWidth}
            height={L.traveller.text}
            originalLines={L.traveller.originalLines}
            lang={localTurn?.to ?? home}
            originalLang={localTurn?.from ?? local}
            originalColor={dusk.color.text2}
            speakerLabel="Argmax · speaker"
          />
        )}
        <View style={{ marginTop: 'auto', gap: GAP }}>
          {push && (
            <HoldButton
              label={holdLabel('traveler')}
              active={holding === 'traveler'}
              disabled={!running}
              onPressIn={() => press('traveler')}
              onPressOut={() => release('traveler')}
            />
          )}
          <View style={styles.footer}>
            <Text style={styles.footerText} numberOfLines={2}>
              Voices and languages told apart on this Mac{audioModel ? ` · ${tidyModel(audioModel)}` : ''}
            </Text>
            <GlassChip label="Push-to-talk" selected={mode === 'push'} onPress={switchMode} height={42} />
          </View>
        </View>
      </View>

      {/* The glass status pill between the halves: tap to start or stop; the orb ends the conversation. */}
      <View pointerEvents="box-none" style={[styles.pillRow, { top: L.pillTop }]}>
        <Glass kind="clear" radius={dusk.radius.pill} style={[styles.pill, { maxWidth: L.textWidth }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={running ? `${status}. Stop listening` : 'Start the conversation'}
            onPress={toggle}
            {...axPress(toggle)}
            hitSlop={8}
            style={styles.pillTap}>
            <Wave level={level} active={running} />
            <Text style={[onGlass, font('700'), styles.pillText]} numberOfLines={1}>
              {status}
            </Text>
          </Pressable>
          <GlassIconButton accessibilityLabel="End conversation" onPress={close} size={36} blur={false}>
            <CloseIcon size={13} strokeWidth={2.6} />
          </GlassIconButton>
        </Glass>
      </View>
    </View>
  );
}

/**
 * A half's glass, behind its text. While the half is speaking it takes the half's colour (Glass
 * tint) and a soft glow of that colour breathes around it; reduce-motion keeps the glow still.
 */
function HalfGlass({ lit, color, style }: { lit: boolean; color: string; style?: StyleProp<ViewStyle> }) {
  const reduce = useReduceMotion();
  const glow = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!lit) {
      const out = Animated.timing(glow, { toValue: 0, duration: reduce ? 0 : 320, useNativeDriver: true });
      out.start();
      return () => out.stop();
    }
    if (reduce) {
      glow.setValue(1);
      return undefined;
    }
    const ease = Easing.inOut(Easing.sin);
    const breathe = Animated.sequence([
      Animated.timing(glow, { toValue: 1, duration: 260, easing: ease, useNativeDriver: true }),
      Animated.loop(
        Animated.sequence([
          Animated.timing(glow, { toValue: 0.55, duration: 900, easing: ease, useNativeDriver: true }),
          Animated.timing(glow, { toValue: 1, duration: 900, easing: ease, useNativeDriver: true }),
        ]),
      ),
    ]);
    breathe.start();
    return () => breathe.stop();
  }, [lit, reduce, glow]);
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.halfGlass, style]}>
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { borderRadius: dusk.radius.card, backgroundColor: alpha(color, 0.14), shadowColor: color, shadowOpacity: 0.75, shadowRadius: 26, shadowOffset: { width: 0, height: 0 }, opacity: glow },
        ]}
      />
      <Glass kind="clear" radius={dusk.radius.card} blur={false} tint={lit ? alpha(color, 0.2) : undefined} style={StyleSheet.absoluteFill} />
    </View>
  );
}

/**
 * A half's language, on a glass chip in the half's colour: "Français · detected". Tapping it opens
 * the picker. It swells briefly when the language changes (a new one detected or picked).
 */
function LangChip({
  label,
  accessibilityLabel,
  accent,
  strong,
  flash,
  open,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  accent: string;
  /** Prominent glass: the language is known (detected, pinned, or the traveller's own). */
  strong: boolean;
  /** Changes when the language does. */
  flash: string;
  open: boolean;
  onPress: () => void;
}) {
  const reduce = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return undefined;
    }
    if (reduce) return undefined;
    const swell = Animated.sequence([
      Animated.timing(scale, { toValue: 1.1, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(scale, { toValue: 1, duration: 320, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]);
    swell.start();
    return () => swell.stop();
  }, [flash, reduce, scale]);
  // The local's chip sits in the turned half, where macOS measures its press rect unturned: a
  // click that moves a pixel would otherwise cancel the tap (see HOLD_RETENTION).
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ expanded: open }}
      onPress={onPress}
      {...axPress(onPress)}
      hitSlop={8}
      pressRetentionOffset={HOLD_RETENTION}>
      <Animated.View style={{ transform: [{ scale }] }}>
        <Glass kind={strong || open ? 'prominent' : 'clear'} radius={dusk.radius.pill} blur={false} tint={alpha(accent, strong ? 0.26 : 0.12)} style={styles.langChip}>
          <View style={[styles.langDot, { backgroundColor: accent, shadowColor: accent }]} />
          <Text style={[onGlass, font('700'), styles.langChipText]} numberOfLines={1}>
            {label}
          </Text>
        </Glass>
      </Animated.View>
    </Pressable>
  );
}

/** The ten languages as small glass chips (in their own names), plus Auto-detect for the local. */
function LangPicker({ selected, auto, exclude, accent, onPick }: { selected?: Lang; auto?: string; exclude?: Lang; accent: string; onPick: (lang: Lang | undefined) => void }) {
  const choices: { key: string; label: string; lang?: Lang }[] = [
    ...(auto ? [{ key: 'auto', label: auto }] : []),
    ...LANGS.filter(l => l !== exclude).map(l => ({ key: l, label: LANG_NATIVE[l], lang: l })),
  ];
  return (
    <View style={styles.picker}>
      {choices.map(c => {
        const on = c.lang === selected;
        return (
          <Pressable
            key={c.key}
            accessibilityRole="radio"
            accessibilityLabel={c.lang ? LANG_NAMES[c.lang] : c.label}
            accessibilityState={{ selected: on }}
            onPress={() => onPick(c.lang)}
            {...axPress(() => onPick(c.lang))}
            pressRetentionOffset={HOLD_RETENTION}>
            <Glass kind={on ? 'prominent' : 'clear'} radius={dusk.radius.pill} blur={false} tint={on ? alpha(accent, 0.3) : undefined} style={styles.pickChip}>
              <Text style={[onGlass, font(on ? '800' : '600'), styles.pickText]} numberOfLines={1}>
                {c.label}
              </Text>
            </Glass>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * One person's latest utterance, translated: the translation large and light, the original
 * underneath in quotes. Speech still being heard, or a translation still streaming, is in the
 * pending colour. The translation keeps to `height` (the room left in its half): long ones get a
 * smaller size (fitText), then numberOfLines and adjustsFontSizeToFit hold it to that room, so it
 * never runs into the band with the status pill.
 */
function Utterance({
  turn,
  live,
  empty,
  base,
  width,
  height,
  originalLines,
  lang,
  originalLang,
  originalColor,
  speakerLabel,
}: {
  turn?: Turn;
  live?: string;
  empty: string;
  /** The design font size; long text gets smaller. */
  base: number;
  /** The box the translation must fit. */
  width: number;
  height: number;
  /** Lines for the original under it (1 when the half is short). */
  originalLines: number;
  lang: Lang;
  originalLang?: Lang;
  originalColor: string;
  speakerLabel: string;
}) {
  let main: React.ReactNode;
  let shown: string;
  if (live) {
    // Still speaking: what Argmax hears so far, before Bonsai-2 translates it.
    shown = live;
    main = <Text style={{ color: dusk.color.pending }}>{live}</Text>;
  } else if (!turn) {
    shown = empty;
    main = <Text style={{ color: dusk.color.pending }}>{empty}</Text>;
  } else if (!turn.translation) {
    shown = turn.original;
    main = <Text style={{ color: dusk.color.pending }}>{turn.original}</Text>;
  } else {
    shown = turn.done ? turn.translation : `${turn.translation} …`;
    main = (
      <>
        {turn.translation}
        {!turn.done && <Text style={{ color: dusk.color.pending }}> …</Text>}
      </>
    );
  }
  const fit = fitText(shown.length, base, width, height);
  const big = [styles.big, { fontSize: fit.size, lineHeight: fit.lineHeight, letterSpacing: -0.02 * fit.size }];
  return (
    <>
      <Text
        accessibilityLiveRegion="polite"
        accessibilityLanguage={live || !turn?.translation ? originalLang : lang}
        style={big}
        numberOfLines={fit.lines}
        adjustsFontSizeToFit
        minimumFontScale={0.7}>
        {main}
      </Text>
      {turn && !live && (
        <Text accessibilityLanguage={originalLang} style={[styles.original, { color: originalColor }]} numberOfLines={originalLines}>
          “{turn.original}”
        </Text>
      )}
      {turn && !live && turn.speaker !== undefined && (
        <Text style={styles.speaker}>
          {speakerLabel} {turn.speaker + 1}
        </Text>
      )}
    </>
  );
}

/** Four white bars that follow the microphone level while the conversation runs. */
function Wave({ level, active }: { level: Animated.Value; active: boolean }) {
  const bars = [10, 18, 13, 7];
  const floor = [0.5, 0.25, 0.35, 0.6];
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.wave}>
      {bars.map((h, i) => (
        <Animated.View
          key={i}
          style={{
            width: 4,
            height: h,
            borderRadius: 2,
            backgroundColor: dusk.color.white,
            opacity: active ? 1 : 0.55,
            transform: [{ scaleY: level.interpolate({ inputRange: [0, 1], outputRange: [floor[i], 1] }) }],
          }}
        />
      ))}
    </View>
  );
}

/**
 * Keeps a held button held until release, wherever the pointer drifts. Needed for the local's
 * button: on macOS, measure() ignores layer transforms, so Pressable would place the turned
 * button's press rect where it would be unturned and end the turn on the first small drag. The
 * language chips use it too, so a tap on the turned half is not lost to the same drift.
 */
const HOLD_RETENTION = { top: 2000, left: 2000, bottom: 2000, right: 2000 };

/** A hold-to-talk glass button: prominent while held. */
function HoldButton({ label, active, disabled, onPressIn, onPressOut }: { label: string; active: boolean; disabled: boolean; onPressIn: () => void; onPressOut: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected: active }}
      disabled={disabled}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      pressRetentionOffset={HOLD_RETENTION}
      style={{ opacity: disabled ? 0.45 : 1 }}>
      <Glass kind={active ? 'prominent' : 'clear'} radius={dusk.radius.pill} style={styles.hold}>
        <Text style={[onGlass, font('800'), { fontSize: 15 }]} numberOfLines={1}>
          {label}
        </Text>
      </Glass>
    </Pressable>
  );
}

/** The same half turn (a point reflection, an exact matrix), spelled two ways so React sends it again. */
const HALF_TURN: NonNullable<ViewStyle['transform']>[] = [
  [{ scaleX: -1 }, { scaleY: -1 }],
  [{ scaleY: -1 }, { scaleX: -1 }],
];

/**
 * A `width` × `height` box shown turned 180° (for the person across the table).
 *
 * Why not just `transform: [{ rotate: '180deg' }]` on the box: on macOS that turn is lost.
 * react-native-macos (old architecture) applies a transform by writing the view's
 * `layer.transform` directly (UIView+React.m updateTransform), but each RN view is a layer-backed
 * NSView whose layer geometry AppKit owns. AppKit sets `layer.transform` back to identity in
 * `-[NSView _updateLayerGeometryFromView]`, which runs on every `setFrame:` (RN sets the frame
 * after the props) and again when AppKit first builds the layer tree of newly mounted views, a
 * run-loop turn later. So the half came out unturned. Setting a transformOrigin
 * makes `reactSetFrame:` re-apply the transform after each frame change, but RCTView's
 * `displayLayer:` (RCTView.m ~1250) then re-centres any non-identity transform for the {0,0}
 * anchorPoint every time it redraws, so a full-size box drifts off by its own size. A background,
 * an inner view or scaleX/scaleY -1 alone change none of this (all checked against the app's
 * libReact-Core.a on this Mac).
 *
 * So the turn is put on a zero-size pivot at the box's centre: turning about a point needs no
 * anchor fix, and `displayLayer:` skips zero-size layers. The transformOrigin makes RN re-apply
 * the turn after every resize, the box stays hidden until the first re-send after mount, and the
 * turn is re-sent after layout and now and then in case AppKit resets it again.
 */
function Flipped({ width, height, accessibilityLabel, children }: { width: number; height: number; accessibilityLabel?: string; children: React.ReactNode }) {
  const [tick, setTick] = useState(0);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const again = () => setTick(t => t + 1);
    const first = setTimeout(() => {
      setReady(true);
      again();
    }, 90);
    const second = setTimeout(again, 400);
    const every = setInterval(again, 3000);
    return () => {
      clearTimeout(first);
      clearTimeout(second);
      clearInterval(every);
    };
  }, []);
  return (
    <View accessibilityLabel={accessibilityLabel} style={{ width, height, overflow: 'hidden' }} onLayout={() => setTick(t => t + 1)}>
      <View pointerEvents="box-none" style={{ position: 'absolute', left: width / 2, top: height / 2, width: 0, height: 0, transformOrigin: 'center', transform: HALF_TURN[tick % 2] }}>
        <View pointerEvents="box-none" style={{ position: 'absolute', left: -width / 2, top: -height / 2, width, height, opacity: ready ? 1 : 0 }}>
          {children}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: dusk.color.ground },
  half: { gap: GAP, overflow: 'hidden' },
  localBlock: { flex: 1, justifyContent: 'flex-end', gap: GAP },
  label: { ...font('800'), flexShrink: 1, fontSize: dusk.font.label.size, letterSpacing: dusk.font.label.letterSpacing },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, height: CHIP_H },
  halfGlass: { position: 'absolute' },
  langChip: { flexDirection: 'row', alignItems: 'center', gap: 7, height: CHIP_H, paddingHorizontal: 12 },
  langDot: { width: 7, height: 7, borderRadius: 3.5, shadowOpacity: 0.9, shadowRadius: 5, shadowOffset: { width: 0, height: 0 } },
  langChipText: { fontSize: 12 },
  picker: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, flexShrink: 1, overflow: 'hidden' },
  pickChip: { height: 28, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 11 },
  pickText: { fontSize: 12 },
  big: {
    ...font('300'),
    flexShrink: 1,
    color: dusk.color.text,
    textShadowColor: ground(0.5),
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 16,
  },
  original: { ...font('500'), fontSize: 14 },
  speaker: { ...font('700'), fontSize: 11, color: dusk.color.text2, letterSpacing: 0.4 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  footerText: { ...font('600'), flex: 1, fontSize: 11, color: dusk.color.text2 },
  pillRow: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 1 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingLeft: 16, paddingRight: 8, height: PILL_H },
  pillTap: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1, minHeight: 36 },
  pillText: { fontSize: 12, flexShrink: 1 },
  wave: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 18 },
  hold: { height: dusk.size.button, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 22 },
});
