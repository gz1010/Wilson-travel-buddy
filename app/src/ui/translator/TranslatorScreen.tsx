import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SideAssigner } from '../../core/translate';
import { LANG_NAMES, type Lang, type Side } from '../../core/types';
import type { Buddy } from '../useBuddy';
import { colors, ui } from '../theme';

interface Turn {
  id: number;
  side: Side;
  original: string;
  translation: string;
  from: Lang;
  to: Lang;
  /** Argmax's speaker label for this sentence, when diarization produced one. */
  speaker?: number;
}

type Mode = 'auto' | 'push';

/**
 * Translator mode. Argmax hears both people and labels who is speaking; each
 * finished sentence is translated by Bonsai-2 and spoken in the other language.
 *
 * - Automatic: no buttons; the detected language picks the column.
 * - Push-to-talk (fallback): each person holds their own button while speaking;
 *   the button picks the column, and Argmax still labels the speaker of every sentence.
 */
export function TranslatorScreen({ b }: { b: Buddy }) {
  const home: Lang = 'en';
  const local = b.index.destination.language;
  const sides = useMemo(() => new SideAssigner(home, local), [local]);
  const [mode, setMode] = useState<Mode>('auto');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [live, setLive] = useState<{ side: Side; text: string } | undefined>();
  const [running, setRunning] = useState(false);
  const [holding, setHolding] = useState<Side | undefined>();
  const stopRef = useRef<(() => void) | undefined>(undefined);
  const holdingRef = useRef<Side | undefined>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());
  /** Push-to-talk: which side each turn id belongs to. The helper echoes the id on the turn's final. */
  const turnSides = useRef(new Map<string, Side>());
  const turnCounter = useRef(0);
  const holdingTurn = useRef<string | undefined>(undefined);
  const [playing, setPlaying] = useState(false);
  const counter = useRef(0);
  const scroll = useRef<ScrollView>(null);
  const { audio } = b.runtime;
  const translator = b.companion.translator;

  const onFinal = useCallback(
    (text: string, language: Lang | undefined, speaker: number | undefined, turn: string | undefined) => {
      // In push-to-talk every release gets exactly one final with its turn id, even an empty one.
      const pressed = turn ? turnSides.current.get(turn) : undefined;
      if (turn) turnSides.current.delete(turn);
      if (!text.trim()) {
        setLive(undefined);
        return;
      }
      const side = pressed ?? sides.assign(speaker, language);
      const { from, to } = pressed
        ? pressed === 'traveler'
          ? { from: home, to: local }
          : { from: local, to: home }
        : sides.direction(side, language);
      const id = ++counter.current;
      setLive(undefined);
      setTurns(t => [...t, { id, side, original: text, translation: '', from, to, speaker }]);
      // Translate and speak in order, one turn at a time; mute the microphone while speaking.
      queue.current = queue.current.then(async () => {
        let out = '';
        try {
          out = await translator.translate(text, from, to, tok => {
            out += tok;
            setTurns(t => t.map(x => (x.id === id ? { ...x, translation: out } : x)));
          });
        } catch (e) {
          out = `(translation failed: ${e instanceof Error ? e.message : e})`;
        }
        setTurns(t => t.map(x => (x.id === id ? { ...x, translation: out } : x)));
        setPlaying(true);
        audio.setMuted(true);
        await audio.speak(out, to).catch(() => {});
        audio.setMuted(false);
        setPlaying(false);
      });
    },
    [audio, local, sides, translator],
  );

  const start = useCallback(() => {
    sides.reset();
    turnSides.current.clear();
    setTurns([]);
    setRunning(true);
    stopRef.current = audio.conversation(
      [home, local],
      e => {
        if (e.type === 'partial') setLive({ side: holdingRef.current ?? 'traveler', text: e.text });
        else if (e.type === 'final') onFinal(e.text, e.language, e.speaker, e.turn);
      },
      { pushToTalk: mode === 'push' },
    );
  }, [audio, local, mode, onFinal, sides]);

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = undefined;
    setRunning(false);
    setLive(undefined);
    setHolding(undefined);
  }, []);

  useEffect(() => stop, [stop]);

  // Switching mode restarts listening in the new mode.
  const switchMode = (next: Mode) => {
    if (next === mode) return;
    stop();
    setMode(next);
  };

  const press = (side: Side) => {
    const turn = `t${++turnCounter.current}`;
    turnSides.current.set(turn, side);
    holdingTurn.current = turn;
    holdingRef.current = side;
    setHolding(side);
    audio.turnStart(turn, side === 'traveler' ? home : local);
  };
  const release = (side: Side) => {
    if (holdingRef.current !== side || !holdingTurn.current) return;
    const turn = holdingTurn.current;
    holdingTurn.current = undefined;
    holdingRef.current = undefined;
    setHolding(undefined);
    audio.turnEnd(turn);
  };

  const subtitle =
    mode === 'push'
      ? 'Hold your button while you speak. Argmax still labels each speaker.'
      : audio.info.liveSpeakers
        ? 'Speakers are told apart live by Argmax.'
        : audio.info.hasMicrophone
          ? 'Language picks the column; Argmax labels each speaker.'
          : 'Replaying a scripted conversation (no audio helper).';

  const talkButton = (side: Side) => (
    <Pressable
      disabled={!running}
      onPressIn={() => press(side)}
      onPressOut={() => release(side)}
      style={[styles.talk, side === 'traveler' ? styles.talkLeft : styles.talkRight, holding === side && styles.talkOn, !running && { opacity: 0.4 }]}>
      <Text style={styles.talkText}>
        {holding === side ? (playing ? 'Wait: playing the translation…' : 'Listening… release when done') : side === 'traveler' ? `Hold to speak ${LANG_NAMES[home]}` : `Mantenga para hablar ${LANG_NAMES[local].toLowerCase() === 'spanish' ? 'español' : LANG_NAMES[local]}`}
      </Text>
    </Pressable>
  );

  return (
    <View style={[ui.panel, styles.wrap]}>
      <View style={[ui.row, { justifyContent: 'space-between', marginBottom: 8 }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Conversation translator</Text>
          <Text style={ui.small}>{subtitle}</Text>
        </View>
        <View style={[ui.row, { marginRight: 10 }]}>
          {(['auto', 'push'] as Mode[]).map(m => (
            <Pressable key={m} onPress={() => switchMode(m)} style={[ui.chip, mode === m && { backgroundColor: colors.ink }]}>
              <Text style={[ui.chipText, mode === m && { color: '#fff' }]}>{m === 'auto' ? 'Automatic' : 'Push-to-talk'}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable style={[ui.button, running && { backgroundColor: colors.danger }]} onPress={running ? stop : start}>
          <Text style={ui.buttonText}>{running ? 'Stop' : 'Start listening'}</Text>
        </Pressable>
      </View>
      <View style={ui.row}>
        <View style={styles.col}>
          <Text style={ui.h2}>You · {LANG_NAMES[home]}</Text>
        </View>
        <View style={styles.col}>
          <Text style={[ui.h2, { textAlign: 'right' }]}>Local · {LANG_NAMES[local]}</Text>
        </View>
      </View>
      <ScrollView ref={scroll} style={{ flex: 1 }} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
        {turns.map(t => (
          <View key={t.id} style={[styles.turn, t.side === 'traveler' ? styles.left : styles.right]}>
            {t.speaker !== undefined && <Text style={styles.speaker}>Argmax · speaker {t.speaker + 1}</Text>}
            <Text style={styles.original}>{t.original}</Text>
            <Text style={styles.translation}>{t.translation || '…'}</Text>
          </View>
        ))}
        {live && (
          <View style={[styles.turn, live.side === 'traveler' ? styles.left : styles.right, { opacity: 0.55 }]}>
            <Text style={styles.original}>{live.text}</Text>
          </View>
        )}
      </ScrollView>
      {mode === 'push' && (
        <View style={[ui.row, { gap: 12, marginTop: 8 }]}>
          {talkButton('traveler')}
          {talkButton('local')}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  title: { fontSize: 18, fontWeight: '800', color: colors.ink },
  col: { flex: 1 },
  turn: { width: '48%', padding: 12, borderRadius: 12, marginBottom: 8 },
  left: { alignSelf: 'flex-start', backgroundColor: '#eef4ff' },
  right: { alignSelf: 'flex-end', backgroundColor: '#fff1e8' },
  speaker: { fontSize: 10, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  original: { fontSize: 13, color: colors.muted, marginBottom: 4 },
  translation: { fontSize: 17, fontWeight: '600', color: colors.ink },
  talk: { flex: 1, paddingVertical: 16, borderRadius: 12, alignItems: 'center' },
  talkLeft: { backgroundColor: '#dbe7ff' },
  talkRight: { backgroundColor: '#ffe2d1' },
  talkOn: { backgroundColor: colors.accent },
  talkText: { fontSize: 14, fontWeight: '700', color: colors.ink },
});
