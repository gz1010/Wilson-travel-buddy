import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SentenceChunker } from '../../core/sentences';
import type { Place } from '../../core/types';
import { Looker } from '../../core/vision';
import { Glass, GlassButton, GlassChip, GlassIconButton, OfflineChip, onGlass } from '../dusk/Glass';
import { CameraIcon, WaveIcon } from '../dusk/Icons';
import { MicOrb } from '../dusk/Nav';
import { PhotoFade } from '../dusk/Photos';
import { useScreenSize } from '../dusk/Screen';
import { dusk, font, white } from '../dusk/tokens';
import type { ScreenProps } from './types';

// Look: point the Mac's camera at a dish, a menu, a road sign or a building, and ask what it is.
// The audio helper owns the camera (as it owns the microphone) and streams small preview frames;
// the shutter takes one sharper still, which goes to Bonsai-2's vision projector. The answer
// streams into a glass card and is spoken sentence by sentence. DuskRoot draws the tab bar.

const W = dusk.layout.phoneWidth;
const PREVIEW_H = 520;
const SHUTTER = 72;
/** Room left at the bottom for the floating tab bar. */
const TAB_BAR_ROOM = 100;

const dataUri = (jpeg: string) => (jpeg.startsWith('data:') ? jpeg : `data:image/jpeg;base64,${jpeg}`);

export function LookScreen({ b, nav }: ScreenProps) {
  const { width, height } = useScreenSize();
  const sx = width / W;
  const audio = b.runtime.audio;
  const looker = useMemo(() => new Looker(b.runtime.llm, b.index), [b.runtime.llm, b.index]);
  const { say, stopSpeaking } = b;

  const [frame, setFrame] = useState<string>();
  const [frozen, setFrozen] = useState<string>();
  const [cameraError, setCameraError] = useState<string>();
  const [answer, setAnswer] = useState('');
  const [question, setQuestion] = useState<string>();
  const [place, setPlace] = useState<Place>();
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const busyRef = useRef(false);
  const frameRef = useRef<string | undefined>(undefined);
  /** Goes up on Retake and on leaving, so a late answer isn't shown or spoken. */
  const gen = useRef(0);

  // The live preview, for as long as the screen is open.
  useEffect(() => {
    const generation = gen; // the counter itself, not a DOM node: bump it on cleanup
    const stop = audio.startCamera(
      jpeg => {
        frameRef.current = jpeg;
        setFrame(jpeg);
        setCameraError(undefined);
      },
      message => setCameraError(message),
    );
    return () => {
      generation.current++;
      stop();
    };
  }, [audio]);

  // Leaving the screen stops the voice too.
  useEffect(() => () => stopSpeaking(), [stopSpeaking]);

  /** Bonsai-2 describes the photo; each finished sentence is spoken as it arrives. */
  const describe = useCallback(
    async (image: string, q?: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setAnswer('');
      setPlace(undefined);
      setQuestion(q);
      stopSpeaking();
      const myGen = gen.current;
      const chunker = new SentenceChunker();
      let text = '';
      try {
        const out = await looker.describe(
          image,
          q,
          tok => {
            if (myGen !== gen.current) return;
            text += tok;
            setAnswer(text);
            for (const s of chunker.push(tok)) say(s);
          },
          b.situation.location,
        );
        if (myGen === gen.current) {
          for (const s of chunker.flush()) say(s);
          setAnswer(out.text || text);
          setPlace(out.place);
        }
      } catch (e) {
        if (myGen === gen.current) setAnswer(`Couldn't read the photo: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [b.situation.location, looker, say, stopSpeaking],
  );

  /** A sharp still from the helper, or the last preview frame if the snap fails. */
  const takeStill = useCallback(async () => (await audio.snap()) ?? frameRef.current, [audio]);

  const shutter = async () => {
    if (busyRef.current) return;
    const still = frozen ?? (await takeStill());
    if (!still) {
      setCameraError(cameraError ?? 'No picture yet: the camera has not sent a frame');
      return;
    }
    setFrozen(still);
    describe(still);
  };

  // "Ask about it": hear the question, then describe the photo (taking one first if needed).
  const ask = async () => {
    if (listening) {
      audio.stopListening();
      return;
    }
    if (busyRef.current) return;
    const still = frozen ?? (await takeStill());
    if (!still) {
      setCameraError(cameraError ?? 'No picture yet: the camera has not sent a frame');
      return;
    }
    setFrozen(still);
    if (!audio.info.hasMicrophone) {
      describe(still);
      return;
    }
    stopSpeaking();
    setListening(true);
    setPartial('');
    try {
      const heard = await audio.listen(setPartial, 'en');
      setListening(false);
      setPartial('');
      describe(still, heard.text.trim() || undefined);
    } catch (e) {
      setListening(false);
      setPartial('');
      setAnswer(e instanceof Error ? e.message : String(e));
    }
  };

  const retake = () => {
    gen.current++;
    stopSpeaking();
    setFrozen(undefined);
    setAnswer('');
    setQuestion(undefined);
    setPlace(undefined);
  };

  const previewH = Math.round(Math.min(PREVIEW_H, height * 0.58));
  const shown = frozen ?? frame;
  const model = b.runtime.llm.name.toUpperCase();

  const noCamera = !shown && cameraError;
  const cardText = listening
    ? partial
      ? `“${partial}”`
      : 'Listening… ask about the photo'
    : answer || (busy ? '…' : frozen ? '' : 'Tap the shutter to ask what this is: a dish, a menu, a road sign, a building.');

  return (
    <View style={styles.root}>
      {/* The live preview (or the frozen photo), top, fading into the ground. */}
      <View style={[styles.preview, { height: previewH }]} accessibilityLabel={frozen ? 'The photo you took' : 'Camera preview'}>
        {shown ? (
          <Image source={{ uri: dataUri(shown) }} resizeMode="cover" style={StyleSheet.absoluteFill} accessibilityIgnoresInvertColors />
        ) : (
          <View style={styles.noPreview}>
            <CameraIcon size={34} color={white(0.5)} />
            <Text style={[font('600'), styles.noPreviewText]} accessibilityLiveRegion="polite">
              {noCamera ? cameraNote(cameraError) : 'Starting the camera…'}
            </Text>
          </View>
        )}
        <PhotoFade stops={[[0, 0.45], [0.18, 0], [0.62, 0], [1, 1]]} />
      </View>

      <View style={[styles.topRow, { left: 18 * sx, right: 18 * sx }]} pointerEvents="none">
        <Glass kind="clear" radius={dusk.radius.pill} style={styles.topPill}>
          <Text style={[onGlass, font('700'), { fontSize: 12 }]} numberOfLines={1}>
            {frozen ? 'Photo taken' : `Look · ${b.index.destination.name}`}
          </Text>
        </Glass>
        <OfflineChip />
      </View>

      {/* The shutter orb, on the preview's bottom edge. */}
      <View style={[styles.shutterRow, { top: previewH - SHUTTER / 2 - 18 }]} pointerEvents="box-none">
        <GlassIconButton accessibilityLabel={frozen ? 'Describe this photo again' : 'Take a photo and ask what it is'} onPress={shutter} size={SHUTTER} kind="orb">
          <CameraIcon size={28} />
        </GlassIconButton>
      </View>

      {/* The answer, between the preview and the buttons. */}
      <ScrollView
        style={[styles.scroll, { top: previewH + 24, bottom: TAB_BAR_ROOM + dusk.size.button + 16 }]}
        contentContainerStyle={{ paddingHorizontal: 14 * sx, paddingBottom: 12 }}
        showsVerticalScrollIndicator={false}>
        <Glass kind="clear" radius={26} style={styles.card}>
          <View style={{ gap: 8 }} accessibilityLabel="What you're looking at">
            <View style={styles.labelRow}>
              {b.speaking && <WaveIcon size={14} />}
              <Text style={[font('700'), styles.label]} numberOfLines={1}>
                {`WHAT YOU'RE LOOKING AT · ${model} ON THIS MAC`}
              </Text>
            </View>
            {!!question && !listening && (
              <Text style={[font('500'), styles.asked]}>
                You asked: <Text style={[font('600'), { color: dusk.color.text }]}>{`“${question}”`}</Text>
              </Text>
            )}
            {!!cardText && (
              <Text
                accessibilityLiveRegion="polite"
                style={[font('500'), styles.answer, (!answer || listening) && { color: dusk.color.pending }]}>
                {cardText}
              </Text>
            )}
            {place && (
              <View style={{ flexDirection: 'row' }}>
                <GlassChip label={`Open ${place.name}`} height={34} onPress={() => nav.openPlace(place.id)} />
              </View>
            )}
          </View>
        </Glass>
      </ScrollView>

      {/* Ask about it · Retake, above the tab bar. */}
      <View style={[styles.actions, { left: 22 * sx, right: 22 * sx, bottom: TAB_BAR_ROOM + 6 }]}>
        <MicOrb listening={listening} onPress={ask} size={dusk.size.button} />
        <Text style={[font('600'), styles.askHint]} numberOfLines={1}>
          {listening ? 'Tap to stop' : 'Ask about it'}
        </Text>
        <GlassButton
          label="Retake"
          kind="clear"
          height={dusk.size.buttonSmall}
          disabled={!frozen && !answer}
          onPress={retake}
          style={{ width: 130 }}
          textStyle={{ fontSize: 14 }}
          accessibilityLabel="Retake: back to the live camera"
        />
      </View>
    </View>
  );
}

/** Plain words for why there is no camera picture. */
function cameraNote(message: string): string {
  if (/denied|not authori[sz]ed|refused|permission/i.test(message)) {
    return 'Camera access was refused. Allow it for the terminal running buddy-audio in System Settings › Privacy & Security › Camera, then reopen Look.';
  }
  return `No camera: ${message}`;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: dusk.color.ground },
  preview: { position: 'absolute', left: 0, right: 0, top: 0, overflow: 'hidden', backgroundColor: dusk.color.raised },
  noPreview: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 40 },
  noPreviewText: { fontSize: 14, lineHeight: 20, color: dusk.color.textSoft, textAlign: 'center' },
  topRow: { position: 'absolute', top: 58, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  topPill: { paddingVertical: 8, paddingHorizontal: 13 },
  shutterRow: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 2 },
  scroll: { position: 'absolute', left: 0, right: 0 },
  card: { padding: 16 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { color: dusk.color.text2, fontSize: 11, letterSpacing: 0.66, flexShrink: 1 },
  asked: { color: dusk.color.text2, fontSize: 13, lineHeight: 18 },
  answer: { color: dusk.color.text, fontSize: 15, lineHeight: 22 },
  actions: { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 12 },
  askHint: { flex: 1, fontSize: 13, color: dusk.color.textSoft },
});
