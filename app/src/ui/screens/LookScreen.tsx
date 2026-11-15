import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Image, Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { timeOfDay } from '../../core/look';
import { SentenceChunker } from '../../core/sentences';
import type { Place } from '../../core/types';
import { Looker, plainText } from '../../core/vision';
import { heroPhotos } from '../../pack/seville/photos';
import { AmbientBackdrop } from '../dusk/AmbientBackdrop';
import { axPress, Glass, GlassButton, OfflineChip, onGlass } from '../dusk/Glass';
import { MicIcon, WaveIcon } from '../dusk/Icons';
import { useReduceMotion } from '../dusk/motion';
import { PhotoFade } from '../dusk/Photos';
import { useScreenSize } from '../dusk/Screen';
import { dusk, font, ground, white } from '../dusk/tokens';
import type { ScreenProps } from './types';

// Scan (the screen id stays 'look'; AntPlace/AntNow style): the camera's live preview in the top
// ~520 px, fading into the ground. The glass shutter takes a sharp photo (the helper's ~1600 px
// snap, shown in place of the ~1000 px preview) and Bonsai-2 says what it is (a dish, a sign, a
// menu), translates any writing and gives one tip, in a glass card; "Ask about it" listens for a
// question and speaks the answer. The helper owns the camera; the model only sees the photo the
// person took. DuskRoot draws the tab bar over the bottom 100 px.
// Behind everything, an ambient backdrop: the photo you took, blurred and darkened, so the card and
// buttons sit on its colours; before that (and with no camera) the city at this time of day, as on
// Now. The preview fades into it.

const W = dusk.layout.phoneWidth;
/** The tab bar's top edge above the bottom of the window (DuskRoot: bottom 26 + 58 tall), plus air. */
const TAB_RESERVE = 26 + dusk.size.tabBar + 16;
const HEADER_TOP = 56;
const SHUTTER = 76;
const BTN = dusk.size.button; // 54
const ROW_GAP = 12;

type Phase = 'live' | 'looking' | 'listening' | 'answered';

const CameraIcon = ({ size = 30, color = '#fff', strokeWidth = 1.9 }: { size?: number; color?: string; strokeWidth?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M4 8h3l1.6-2.4a1 1 0 0 1 .8-.4h5.2a1 1 0 0 1 .8.4L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
    <Circle cx="12" cy="13.2" r="3.6" />
  </Svg>
);

/** Why there is no picture, in words for the traveller. */
function cameraProblem(message: string): { title: string; body: string; retry: boolean } {
  // Only the app's own messages about the helper ("Audio helper disconnected"); the helper's
  // "The camera was disconnected." is a camera problem and can be retried.
  if (/without the audio helper|audio helper (not connected|disconnected)/i.test(message)) {
    return { title: 'No camera right now', body: 'The camera comes through the audio helper, which isn’t running. Start everything with scripts/start.sh.', retry: false };
  }
  if (/refused|denied|access/i.test(message)) return { title: 'Camera access is off', body: message.replace(/ > /g, ' › '), retry: true };
  if (/no camera/i.test(message)) return { title: 'No camera found', body: 'This Mac has no camera the helper can use. Connect one (or an iPhone as a Continuity Camera) and try again.', retry: true };
  return { title: 'The camera stopped', body: message, retry: true };
}

interface Size {
  width: number;
  height: number;
}

/** How long a new preview size must hold before the pictures are remade for it (a window being dragged). */
const SETTLE_MS = 160;

/**
 * The preview's measured size, rounded: the pictures are drawn at it and remade (keyed on it) when
 * it changes, as macOS keeps an image decoded at its first layout size and stretches it. The first
 * size applies at once, later ones once they hold for SETTLE_MS, so dragging the window doesn't
 * remake (and blank) the photo on every step.
 */
function useSettledBox() {
  const [size, setSize] = useState<Size | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const measured = useRef(false);
  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const next = { width: Math.round(e.nativeEvent.layout.width), height: Math.round(e.nativeEvent.layout.height) };
    if (next.width <= 0 || next.height <= 0) return;
    const apply = () => setSize(prev => (prev && prev.width === next.width && prev.height === next.height ? prev : next));
    if (timer.current !== undefined) clearTimeout(timer.current);
    if (measured.current) timer.current = setTimeout(apply, SETTLE_MS);
    else {
      measured.current = true;
      apply();
    }
  }, []);
  return { size, key: size ? `${size.width}x${size.height}` : 'none', onLayout };
}

/** A camera picture at the preview's measured size (in points, so macOS decodes it for the Retina pixels). */
function CameraImage({ jpeg, size, label }: { jpeg: string; size: Size; label?: string }) {
  return (
    <Image
      source={{ uri: `data:image/jpeg;base64,${jpeg}` }}
      resizeMode="cover"
      style={[styles.photo, size]}
      accessible={!!label}
      accessibilityLabel={label}
      accessibilityIgnoresInvertColors
    />
  );
}

/** The live frames. Its own component, so a new frame (up to 6 a second) redraws only this image. */
const LivePreview = React.memo(function LivePreview({ sink, initial, size }: { sink: React.MutableRefObject<((jpeg: string) => void) | undefined>; initial?: string; size: Size }) {
  const [frame, setFrame] = useState(initial);
  useEffect(() => {
    sink.current = setFrame;
    return () => {
      sink.current = undefined;
    };
  }, [sink]);
  if (!frame) return null;
  return <CameraImage jpeg={frame} size={size} />;
});

export function LookScreen({ b, nav }: ScreenProps) {
  const { width, height } = useScreenSize();
  const sx = width / W;
  const audio = b.runtime.audio;
  const looker = useMemo(() => new Looker(b.runtime.llm, b.index), [b.runtime.llm, b.index]);
  const model = b.runtime.llm.name;

  // Layout: the preview shrinks on short windows so the controls always fit above the tab bar.
  const previewH = Math.round(Math.min(520, Math.max(300, height - 324)));

  // --- The camera, through the helper.
  const lastFrame = useRef<string | undefined>(undefined);
  const sink = useRef<((jpeg: string) => void) | undefined>(undefined);
  /** True from the shutter until Retake: the preview holds its last frame under the photo. */
  const paused = useRef(false);
  const [hasFrames, setHasFrames] = useState(false);
  const [cameraError, setCameraError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setCameraError(undefined);
    setHasFrames(false);
    lastFrame.current = undefined;
    let first = true;
    return audio.startCamera(
      jpeg => {
        if (paused.current) return;
        lastFrame.current = jpeg;
        sink.current?.(jpeg);
        if (first) {
          first = false;
          setHasFrames(true);
        }
      },
      message => setCameraError(message),
    );
  }, [audio, attempt]);

  // The preview's measured size: the pictures are drawn at it and remade when it changes.
  const box = useSettledBox();

  // The shutter's blink over the preview (none with reduce motion).
  const reduceMotion = useReduceMotion();
  const flash = useRef(new Animated.Value(0)).current;
  const blink = useCallback(() => {
    if (reduceMotion) return;
    flash.setValue(0.5);
    Animated.timing(flash, { toValue: 0, duration: 280, useNativeDriver: true }).start();
  }, [flash, reduceMotion]);

  // --- What the person looked at, and what Bonsai-2 said.
  const [phase, setPhase] = useState<Phase>('live');
  const [frozen, setFrozen] = useState<string>();
  const [question, setQuestion] = useState<string>();
  const [partial, setPartial] = useState('');
  const [answer, setAnswer] = useState('');
  const [place, setPlace] = useState<Place>();
  const [problem, setProblem] = useState<string>();
  const [spoke, setSpoke] = useState(false);
  /** Goes up on every new look and on Retake, so a late answer from an older one is dropped. */
  const run = useRef(0);
  const listeningRef = useRef(false);

  // Leaving the screen ends a question in progress (the camera stops in its own effect).
  useEffect(
    () => () => {
      run.current++;
      if (listeningRef.current) audio.stopListening();
    },
    [audio],
  );

  // The floating buddy takes the microphone over: drop our question.
  useEffect(() => {
    if (b.listening && listeningRef.current) {
      run.current++;
      listeningRef.current = false;
      setPartial('');
      setPhase(p => (p === 'listening' ? 'answered' : p));
    }
  }, [b.listening]);

  const describe = useCallback(
    async (image: string, q: string | undefined, speak: boolean) => {
      const id = ++run.current;
      setQuestion(q);
      setAnswer('');
      setPlace(undefined);
      setProblem(undefined);
      setSpoke(speak);
      setPhase('looking');
      if (!b.runtime.live.llm) {
        setProblem('Bonsai-2 isn’t running, so nothing can read the photo. Start it with scripts/start.sh.');
        setPhase('answered');
        return;
      }
      const chunker = new SentenceChunker();
      let raw = '';
      try {
        const result = await looker.describe(image, q, token => {
          if (id !== run.current) return;
          raw += token;
          setAnswer(plainText(raw));
          if (speak) chunker.push(token).forEach(s => b.say(plainText(s)));
        });
        if (id !== run.current) return;
        if (speak) chunker.flush().forEach(s => b.say(plainText(s)));
        setAnswer(result.text);
        setPlace(result.place);
      } catch (e) {
        if (id !== run.current) return;
        setProblem(e instanceof Error ? e.message : String(e));
      }
      setPhase('answered');
    },
    [b, looker],
  );

  /**
   * The shutter: the preview holds still at once (with a blink), then the helper's sharp snap
   * (~1600 px) is shown and is what Bonsai-2 reads. Only when no snap comes back (the camera
   * stopped) is the last preview frame used. Returns undefined if Retake (or leaving) came first.
   */
  const freeze = useCallback(
    async (id: number): Promise<string | undefined> => {
      const preview = lastFrame.current;
      if (!preview) return undefined;
      paused.current = true;
      blink();
      const still = await audio.snap();
      if (id !== run.current) return undefined;
      const photo = still ?? preview;
      setFrozen(photo);
      return photo;
    },
    [audio, blink],
  );

  const shoot = async () => {
    if (phase !== 'live' || !lastFrame.current) return;
    b.stopSpeaking();
    const id = ++run.current;
    setPhase('looking');
    const image = await freeze(id);
    if (!image) return;
    await describe(image, undefined, false);
  };

  const ask = async () => {
    if (listeningRef.current) {
      audio.stopListening(); // tap again to stop; the question so far is used
      return;
    }
    if (b.listening || !audio.info.hasMicrophone) return;
    b.stopSpeaking();
    const id = ++run.current;
    const image = frozen ?? (await freeze(id));
    if (id !== run.current || !image) return;
    listeningRef.current = true;
    setQuestion(undefined);
    setAnswer('');
    setPlace(undefined);
    setProblem(undefined);
    setPartial('');
    setPhase('listening');
    try {
      const heard = await audio.listen(setPartial, 'en');
      if (id !== run.current) return;
      listeningRef.current = false;
      setPartial('');
      if (heard.text.trim()) await describe(image, heard.text.trim(), true);
      else {
        setProblem('I didn’t catch a question. Tap Ask about it and try again.');
        setPhase('answered');
      }
    } catch (e) {
      if (id !== run.current) return;
      listeningRef.current = false;
      setPartial('');
      setProblem(e instanceof Error ? e.message : String(e));
      setPhase('answered');
    }
  };

  const retake = () => {
    run.current++;
    if (listeningRef.current) audio.stopListening();
    listeningRef.current = false;
    b.stopSpeaking();
    paused.current = false;
    setFrozen(undefined);
    setQuestion(undefined);
    setPartial('');
    setAnswer('');
    setPlace(undefined);
    setProblem(undefined);
    setPhase('live');
  };

  const live = phase === 'live' && !frozen;
  // The backdrop: the photo you took once there is one, else the city at this time of day.
  const tod = timeOfDay(b.situation.clock, b.index.destination);
  const frozenSource = useMemo(() => (frozen ? { uri: `data:image/jpeg;base64,${frozen}` } : undefined), [frozen]);
  /** A picture fills the preview (live frames or the photo); otherwise the backdrop shows there too. */
  const showing = hasFrames || !!frozen;
  const noCamera = cameraError !== undefined && !frozen ? cameraProblem(cameraError) : undefined;
  const listening = phase === 'listening';
  // Not while the shutter's sharper still is on its way (the question would get the preview frame).
  const askDisabled = b.listening || !audio.info.hasMicrophone || (live && !hasFrames) || (phase === 'looking' && !answer);

  // --- The card: what you asked, then what Bonsai-2 says.
  const label = `WHAT IT IS · ${model.toUpperCase()} ON THIS MAC`;
  const asked = listening ? (partial ? `“${partial}”` : 'Listening…') : question ? `“${question}”` : undefined;
  const pending = phase === 'looking' && !answer;
  const body =
    problem ??
    (pending ? (frozen ? 'Reading the photo…' : 'Taking the photo…') : answer || (phase === 'answered' ? 'Nothing came back. Try again, a little closer.' : ''));

  const askPill = (style?: object) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={listening ? 'Stop listening' : 'Ask about it'}
      accessibilityState={{ disabled: askDisabled }}
      disabled={askDisabled}
      onPress={ask}
      {...axPress(ask, askDisabled)}
      style={({ pressed }) => [{ opacity: askDisabled ? 0.45 : pressed ? 0.85 : 1 }, style]}>
      <Glass kind="prominent" radius={999} style={styles.askPill}>
        {listening ? <WaveIcon size={18} /> : <MicIcon size={18} />}
        <Text style={[onGlass, font('800'), { fontSize: 15 }]}>{listening ? 'Listening…' : 'Ask about it'}</Text>
      </Glass>
    </Pressable>
  );

  return (
    <View style={styles.root}>
      <AmbientBackdrop source={frozenSource ?? heroPhotos[tod]} strength={0.75} />

      {/* Top ~520: the live preview, and the photo over it once taken, fading into the backdrop. */}
      <View testID="scan-preview" style={[styles.preview, { height: previewH }, showing && styles.previewShowing]} pointerEvents="none" onLayout={box.onLayout}>
        {box.size && (
          <View key={box.key} style={StyleSheet.absoluteFill}>
            <LivePreview key={attempt} sink={sink} initial={lastFrame.current} size={box.size} />
            {frozen && <CameraImage jpeg={frozen} size={box.size} label="The photo you took" />}
          </View>
        )}
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: dusk.color.white, opacity: flash }]} />
        {showing && <PhotoFade stops={[[0, 0.5], [0.22, 0.05], [0.68, 0.05], [1, 1]]} />}
      </View>
      {/* Under the preview the ground thins out into the backdrop, so there is no edge. */}
      {showing && (
        <View pointerEvents="none" style={[styles.melt, { top: previewH }]}>
          <PhotoFade stops={[[0, 1], [0.45, 0.55], [1, 0]]} />
        </View>
      )}

      <View style={[styles.header, { left: 22 * sx, right: 22 * sx }]}>
        <View style={{ flexShrink: 1 }}>
          <Text style={[styles.title, font('700')]} accessibilityRole="header">
            Scan
          </Text>
          <Text style={[styles.models, font('500')]} numberOfLines={1}>
            {`${model} on this Mac · photos never leave it`}
          </Text>
        </View>
        <OfflineChip />
      </View>

      {/* No picture: say why, in place of the preview. */}
      {noCamera && (
        <View style={[styles.problemWrap, { top: HEADER_TOP + 70, height: previewH - HEADER_TOP - 70, paddingHorizontal: 18 * sx }]}>
          <Glass kind="clear" radius={26} style={styles.problemCard}>
            <CameraIcon size={30} />
            <Text style={[onGlass, font('700'), { fontSize: 17 }]}>{noCamera.title}</Text>
            <Text style={[styles.problemBody, font('500')]}>{noCamera.body}</Text>
          </Glass>
        </View>
      )}
      {!noCamera && live && !hasFrames && (
        <Text style={[styles.starting, font('600'), { top: previewH / 2 - 10 }]} accessibilityLiveRegion="polite">
          Starting the camera…
        </Text>
      )}

      {live ? (
        <>
          {hasFrames && !noCamera && (
            <View style={[styles.hintWrap, { top: previewH - 74, left: 24 * sx, right: 24 * sx }]} pointerEvents="none">
              <Text style={[styles.hint, font('700')]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
                Point at a dish, a sign or a menu
              </Text>
              <Text style={[styles.hintSub, font('500')]} numberOfLines={2}>
                You’ll get what it is, the translation and a tip
              </Text>
            </View>
          )}
          <View style={[styles.controls, { top: previewH, bottom: TAB_RESERVE }]}>
            {noCamera ? (
              noCamera.retry && <GlassButton label="Try again" kind="clear" onPress={() => setAttempt(a => a + 1)} style={{ width: 180 }} />
            ) : (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Scan: take a photo and find out what it is"
                  accessibilityState={{ disabled: !hasFrames }}
                  disabled={!hasFrames}
                  onPress={shoot}
                  {...axPress(shoot, !hasFrames)}
                  style={({ pressed }) => ({ opacity: !hasFrames ? 0.45 : pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.96 : 1 }] })}>
                  <Glass kind="orb" radius={SHUTTER / 2} style={styles.shutter}>
                    <CameraIcon size={32} />
                  </Glass>
                </Pressable>
                {askPill({ marginTop: 14 })}
              </>
            )}
          </View>
        </>
      ) : (
        <>
          {/* Anchored above the buttons and as tall as its text, so the photo stays in view. */}
          <Glass kind="clear" radius={26} style={[styles.card, { left: 14 * sx, right: 14 * sx, bottom: TAB_RESERVE + BTN + ROW_GAP }]}>
            <ScrollView
              style={{ maxHeight: Math.max(180, height - TAB_RESERVE - BTN - ROW_GAP - 210) }}
              contentContainerStyle={{ padding: 16, gap: 8 }}
              showsVerticalScrollIndicator={false}
              alwaysBounceVertical={false}>
              <View style={styles.labelRow}>
                {spoke && b.speaking && <WaveIcon size={14} />}
                <Text style={[styles.label, font('700')]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
                  {label}
                </Text>
              </View>
              {asked && (
                <Text style={[styles.asked, font('500')]}>
                  You asked: <Text style={[styles.askedQ, font('600')]}>{asked}</Text>
                </Text>
              )}
              {!!body && (
                <Text style={[styles.answer, font('500'), (pending || !!problem) && { color: problem ? dusk.color.textSoft : dusk.color.pending }]} accessibilityLiveRegion="polite">
                  {body}
                </Text>
              )}
              {place && phase === 'answered' && (
                <Pressable accessibilityRole="button" accessibilityLabel={`Open ${place.name}`} onPress={() => nav.openPlace(place.id)} {...axPress(() => nav.openPlace(place.id))} style={styles.placeLink}>
                  <Text style={[onGlass, font('700'), { fontSize: 13 }]}>{`Open ${place.name} →`}</Text>
                </Pressable>
              )}
            </ScrollView>
          </Glass>
          <View style={[styles.row, { left: 22 * sx, right: 22 * sx, bottom: TAB_RESERVE }]}>
            <GlassButton label="Retake" kind="clear" onPress={retake} style={{ flex: 1 }} />
            {askPill({ flex: 1.5 })}
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: dusk.color.ground },
  preview: { position: 'absolute', left: 0, right: 0, top: 0, overflow: 'hidden' },
  previewShowing: { backgroundColor: dusk.color.raised },
  melt: { position: 'absolute', left: 0, right: 0, height: 150 },
  header: { position: 'absolute', top: HEADER_TOP, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 },
  title: { fontSize: 24, letterSpacing: -0.48, color: dusk.color.text, textShadowColor: ground(0.45), textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 12 },
  models: { fontSize: 11, marginTop: 2, color: dusk.color.text2, textShadowColor: ground(0.5), textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 8 },
  problemWrap: { position: 'absolute', left: 0, right: 0, justifyContent: 'center' },
  problemCard: { padding: 20, gap: 8, alignItems: 'flex-start' },
  problemBody: { fontSize: 14, lineHeight: 20, color: dusk.color.textSoft },
  starting: { position: 'absolute', left: 0, right: 0, textAlign: 'center', fontSize: 14, color: dusk.color.text2 },
  photo: { position: 'absolute', left: 0, top: 0 },
  hintWrap: { position: 'absolute', alignItems: 'center', gap: 3 },
  hint: { textAlign: 'center', fontSize: 16, lineHeight: 21, letterSpacing: -0.16, ...onGlass, textShadowColor: ground(0.7), textShadowRadius: 10 },
  hintSub: { textAlign: 'center', fontSize: 13, lineHeight: 18, color: dusk.color.textSoft, textShadowColor: ground(0.8), textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 10 },
  controls: { position: 'absolute', left: 0, right: 0, alignItems: 'center', justifyContent: 'center' },
  shutter: { width: SHUTTER, height: SHUTTER, alignItems: 'center', justifyContent: 'center' },
  askPill: { height: BTN, minWidth: 180, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 22 },
  card: { position: 'absolute' },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { flexShrink: 1, color: dusk.color.text2, fontSize: 11, letterSpacing: 0.66 },
  asked: { color: dusk.color.text2, fontSize: 13, lineHeight: 18 },
  askedQ: { color: dusk.color.text },
  answer: { color: dusk.color.text, fontSize: 15, lineHeight: 22 },
  placeLink: { alignSelf: 'flex-start', marginTop: 4, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, backgroundColor: white(0.12) },
  row: { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 10 },
});
