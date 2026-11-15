import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { SideAssigner } from '../../core/translate';
import { LANG_NAMES, type Lang, type Side, type TurnEvent } from '../../core/types';
import { Glass, GlassChip, GlassIconButton, onGlass } from '../dusk/Glass';
import { CloseIcon } from '../dusk/Icons';
import { useReduceMotion } from '../dusk/motion';
import { dusk, font, ground } from '../dusk/tokens';
import type { ScreenProps } from './types';
import { useScreenSize } from '../dusk/Screen';

// AntTalk: Translate, the conversation translator. The phone lies flat between two people. The
// top half is the local's, rotated 180° so it reads the right way up for them; the bottom half is
// the traveller's. A fixed band between them holds the status pill, and the bottom ~100 px is
// left for the tab bar (DuskRoot draws it). Argmax hears both and labels who is speaking; Bonsai-2 translates each finished
// sentence and Argmax speaks it in the other language. The logic is adapted from the classic
// src/ui/translator/TranslatorScreen.tsx (SideAssigner, turn ids, push-to-talk, muting).

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

const HOME: Lang = 'en';
const PHONE_W = dusk.layout.phoneWidth;
const PILL_H = 52;
/** The band between the halves that the status pill sits in; neither half's text goes into it. */
const BAND_H = 72;
/** Room left at the bottom for the floating tab bar. */
const TAB_BAR_ROOM = 100;
const LOCAL_SIZE = 38;
const TRAVELER_SIZE = 32;

/**
 * The local's half, flipped. On macOS a layer's anchor point is its top-left corner, and
 * RCTView's redisplay corrects for that by re-reading layer.transform and recentring it every
 * time it redraws (RCTView.m displayLayer). After a resize that correction is applied a second
 * time, so a plain rotate drifts out of the half. With an explicit transformOrigin, UIView+React
 * resets the transform on every frame change first (reactSetFrame → updateTransform), so each
 * redraw corrects it exactly once. The opaque background keeps it one simple, constant layer.
 */
const FLIPPED = { transform: [{ rotate: '180deg' }], transformOrigin: '50% 50%' } as const;

/** Copy for the local's half: Spanish when the local language is Spanish, English otherwise. */
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
  };
}

export function TalkScreen({ b, nav }: ScreenProps) {
  const { width, height } = useScreenSize();
  const sx = width / PHONE_W;
  const side = Math.round(26 * sx);
  const reduce = useReduceMotion();

  const local = b.index.destination.language;
  const copy = useMemo(() => localCopy(local), [local]);
  const sides = useMemo(() => new SideAssigner(HOME, local), [local]);
  const { audio } = b.runtime;
  const translator = b.companion.translator;
  const { stopSpeaking: stopBuddySpeaking, listening: buddyListening } = b;

  const [mode, setMode] = useState<Mode>('auto');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [live, setLive] = useState<{ side: Side; text: string } | undefined>();
  const [running, setRunning] = useState(false);
  const [holding, setHolding] = useState<Side | undefined>();
  /** The language being spoken aloud right now (the microphone is muted meanwhile). */
  const [playing, setPlaying] = useState<Lang | undefined>();

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
      const who = pressed ?? sides.assign(speaker, language);
      if (speaker !== undefined && !pressed) speakerSides.current.set(speaker, who);
      const { from, to } = pressed
        ? pressed === 'traveler'
          ? { from: HOME, to: local }
          : { from: local, to: HOME }
        : sides.direction(who, language);
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
        setPlaying(to);
        audio.setMuted(true);
        await audio.speak(out, to).catch(() => {});
        if (myGen !== gen.current) return; // stop() already unmuted
        audio.setMuted(false);
        setPlaying(undefined);
      });
    },
    [audio, local, sides, translator],
  );

  const start = useCallback(
    (m: Mode, keepTurns = false) => {
      // The companion's own voice and microphone give way to the conversation.
      stopBuddySpeaking();
      if (buddyListening) audio.stopListening();
      sides.reset();
      speakerSides.current.clear();
      turnSides.current.clear();
      if (!keepTurns) setTurns([]);
      setRunning(true);
      level.setValue(reduceRef.current ? 1 : 0);
      stopRef.current = audio.conversation(
        [HOME, local],
        (e: TurnEvent) => {
          if (e.type === 'level') {
            lastLevelAt.current = Date.now();
            animateLevel(e.value, 90);
          } else if (e.type === 'partial') {
            const who = holdingRef.current ?? (e.speaker !== undefined ? speakerSides.current.get(e.speaker) : undefined) ?? 'traveler';
            setLive({ side: who, text: e.text });
            pulse();
          } else if (e.type === 'final') {
            onFinal(e.text, e.language, e.speaker, e.turn);
          }
        },
        { pushToTalk: m === 'push' },
      );
    },
    [animateLevel, audio, buddyListening, level, local, onFinal, pulse, sides, stopBuddySpeaking],
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
  }, [audio, level]);

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

  const press = (who: Side) => {
    if (!running || holdingTurn.current) return;
    const turn = `t${++turnCounter.current}`;
    turnSides.current.set(turn, who);
    holdingTurn.current = turn;
    holdingRef.current = who;
    setHolding(who);
    audio.turnStart(turn, who === 'traveler' ? HOME : local);
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

  const talking = holding ?? live?.side;
  const code = (l: Lang) => l.toUpperCase();
  const status = !running
    ? 'Tap to start translating'
    : talking
      ? `${talking === 'traveler' ? 'Traveller' : 'Receiver'} is talking · ${talking === 'traveler' ? `${code(HOME)} → ${code(local)}` : `${code(local)} → ${code(HOME)}`}`
      : playing
        ? `Speaking ${LANG_NAMES[playing]}…`
        : mode === 'push'
          ? 'Hold a button to talk'
          : 'Listening…';

  const audioModel = audio.info.models[0];
  // Each half's height, and how many lines of the big text fit in it after its other rows (label,
  // the original in quotes, the speaker label, and the hold button or footer). Long translations
  // shrink to fit (adjustsFontSizeToFit) and are cut at that many lines instead of overlapping.
  const halfH = Math.max(0, (height - BAND_H - TAB_BAR_ROOM) / 2);
  const holdRoom = mode === 'push' ? dusk.size.button + 10 : 0;
  const fit = (size: number, reserved: number) => Math.max(1, Math.min(4, Math.floor((halfH - reserved) / Math.round(size * 1.1))));
  const localLines = fit(LOCAL_SIZE, 24 + 26 + 40 + 16 + holdRoom);
  const travelerLines = fit(TRAVELER_SIZE, 16 + 26 + 40 + 16 + 52 + holdRoom);
  const holdLabel = (who: Side) => {
    const mine = holding === who;
    if (who === 'traveler') return mine ? (playing ? 'Wait: playing the translation…' : 'Listening… release when done') : `Hold to speak ${LANG_NAMES[HOME]}`;
    return mine ? (playing ? copy.wait : copy.holding) : copy.hold;
  };

  return (
    <View style={[styles.root, { paddingBottom: TAB_BAR_ROOM }]}>
      {/* The local's half, upside down so it faces them across the phone. */}
      <View style={styles.half}>
        <View accessibilityLabel={copy.half} style={[styles.flipped, FLIPPED]}>
        <View style={{ position: 'absolute', left: side, right: side, bottom: 24, gap: 10 }}>
          <Text style={[styles.label, { color: dusk.color.textSoft }]}>{copy.label}</Text>
          <Utterance
            turn={traveler}
            live={live?.side === 'traveler' ? live.text : undefined}
            empty={copy.empty}
            size={LOCAL_SIZE}
            lines={localLines}
            lang={local}
            originalLang={HOME}
            originalColor={dusk.color.textSoft}
            speakerLabel={copy.speaker}
          />
          {mode === 'push' && (
            <HoldButton label={holdLabel('local')} active={holding === 'local'} disabled={!running} onPressIn={() => press('local')} onPressOut={() => release('local')} />
          )}
        </View>
        </View>
      </View>

      {/* The band between the halves: a hairline divider with the status pill on it. Tap the
          pill to start or stop; the orb ends the conversation. */}
      <View style={styles.band}>
        <View style={styles.divider} />
        <Glass kind="clear" radius={dusk.radius.pill} style={[styles.pill, { maxWidth: width - 2 * side }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={running ? `${status}. Stop translating` : 'Start translating'}
            onPress={toggle}
            hitSlop={8}
            style={styles.pillTap}>
            <Wave level={level} active={running} />
            <Text style={[onGlass, font('700'), styles.pillText]} numberOfLines={1}>
              {status}
            </Text>
          </Pressable>
          <GlassIconButton accessibilityLabel="End translation" onPress={close} size={36} blur={false}>
            <CloseIcon size={13} strokeWidth={2.6} />
          </GlassIconButton>
        </Glass>
      </View>

      {/* The traveller's half. */}
      <View accessibilityLabel="For you" style={[styles.half, { paddingTop: 16, paddingHorizontal: side, paddingBottom: 12, gap: 10 }]}>
        <Glow />
        <Text style={[styles.label, { color: dusk.color.text2 }]}>THE LOCAL SAYS</Text>
        <Utterance
          turn={localTurn}
          live={live?.side === 'local' ? live.text : undefined}
          empty="What the local says appears here, in English."
          size={TRAVELER_SIZE}
          lines={travelerLines}
          lang={HOME}
          originalLang={local}
          originalColor={dusk.color.text2}
          speakerLabel="Argmax · speaker"
        />
        <View style={{ marginTop: 'auto', gap: 10 }}>
          {mode === 'push' && (
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
              Voices told apart on this phone{audioModel ? ` · ${audioModel}` : ''}
            </Text>
            <GlassChip label="Push-to-talk" selected={mode === 'push'} onPress={switchMode} height={42} />
          </View>
        </View>
      </View>
    </View>
  );
}

/**
 * One person's latest utterance, translated: the translation large and light, the original
 * underneath in quotes. Speech still being heard, or a translation still streaming, is in the
 * pending colour.
 */
function Utterance({
  turn,
  live,
  empty,
  size,
  lines,
  lang,
  originalLang,
  originalColor,
  speakerLabel,
}: {
  turn?: Turn;
  live?: string;
  empty: string;
  size: number;
  /** How many lines of the big text fit in this half. */
  lines: number;
  lang: Lang;
  originalLang?: Lang;
  originalColor: string;
  speakerLabel: string;
}) {
  const big = [styles.big, { fontSize: size, lineHeight: Math.round(size * (size > 34 ? 1.05 : 1.1)), letterSpacing: -0.035 * size }];
  let main: React.ReactNode;
  if (live) {
    // Still speaking: what Argmax hears so far, before Bonsai-2 translates it.
    main = <Text style={{ color: dusk.color.pending }}>{live}</Text>;
  } else if (!turn) {
    main = <Text style={{ color: dusk.color.pending }}>{empty}</Text>;
  } else if (!turn.translation) {
    main = <Text style={{ color: dusk.color.pending }}>{turn.original}</Text>;
  } else {
    main = (
      <>
        {turn.translation}
        {!turn.done && <Text style={{ color: dusk.color.pending }}> …</Text>}
      </>
    );
  }
  return (
    <>
      <Text accessibilityLiveRegion="polite" accessibilityLanguage={live || !turn?.translation ? originalLang : lang} style={big} numberOfLines={lines} adjustsFontSizeToFit minimumFontScale={0.5}>
        {main}
      </Text>
      {turn && !live && (
        <Text accessibilityLanguage={originalLang} style={[styles.original, { color: originalColor }]} numberOfLines={2}>
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
      style={{ opacity: disabled ? 0.45 : 1 }}>
      <Glass kind={active ? 'prominent' : 'clear'} radius={dusk.radius.pill} style={styles.hold}>
        <Text style={[onGlass, font('800'), { fontSize: 15 }]} numberOfLines={1}>
          {label}
        </Text>
      </Glass>
    </Pressable>
  );
}

/** The faint blue glow at the bottom of the traveller's half. */
function Glow() {
  return (
    <View pointerEvents="none" style={styles.glow}>
      <Svg width="100%" height="100%">
        <Defs>
          <RadialGradient id="talkGlow" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={dusk.color.you} stopOpacity={0.22} />
            <Stop offset="1" stopColor={dusk.color.you} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#talkGlow)" />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: dusk.color.ground },
  half: { flex: 1, overflow: 'hidden' },
  flipped: { ...StyleSheet.absoluteFillObject, backgroundColor: dusk.color.ground },
  band: { height: BAND_H, alignItems: 'center', justifyContent: 'center', zIndex: 1 },
  divider: { position: 'absolute', left: 0, right: 0, top: BAND_H / 2, height: StyleSheet.hairlineWidth, backgroundColor: dusk.color.text2, opacity: 0.35 },
  label: { ...font('800'), fontSize: dusk.font.label.size, letterSpacing: dusk.font.label.letterSpacing },
  big: {
    ...font('300'),
    color: dusk.color.text,
    textShadowColor: ground(0.5),
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 16,
  },
  original: { ...font('500'), fontSize: 14 },
  speaker: { ...font('700'), fontSize: 11, color: dusk.color.text2, letterSpacing: 0.4 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  footerText: { ...font('600'), flex: 1, fontSize: 11, color: dusk.color.text2 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingLeft: 16, paddingRight: 8, height: PILL_H },
  pillTap: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1, minHeight: 36 },
  pillText: { fontSize: 12, flexShrink: 1 },
  wave: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 18 },
  hold: { height: dusk.size.button, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 22 },
  glow: { position: 'absolute', left: -60, right: -60, bottom: -220, height: 400 },
});
