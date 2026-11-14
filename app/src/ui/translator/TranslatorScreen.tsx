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
}

/**
 * Translator mode (A owns this). Argmax hears both people and labels who is
 * speaking; each finished sentence is translated by Bonsai-2 and spoken in
 * the other language. No buttons between turns.
 */
export function TranslatorScreen({ b }: { b: Buddy }) {
  const home: Lang = 'en';
  const local = b.index.destination.language;
  const sides = useMemo(() => new SideAssigner(home, local), [local]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [live, setLive] = useState<{ side: Side; text: string } | undefined>();
  const [running, setRunning] = useState(false);
  const stopRef = useRef<(() => void) | undefined>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const counter = useRef(0);
  const scroll = useRef<ScrollView>(null);
  const { audio } = b.runtime;
  const translator = b.companion.translator;

  const onFinal = useCallback(
    (text: string, language: Lang | undefined, speaker: number | undefined) => {
      if (!text.trim()) return;
      const side = sides.assign(speaker, language);
      const { from, to } = sides.direction(side, language);
      const id = ++counter.current;
      setLive(undefined);
      setTurns(t => [...t, { id, side, original: text, translation: '', from, to }]);
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
        audio.setMuted(true);
        await audio.speak(out, to).catch(() => {});
        audio.setMuted(false);
      });
    },
    [audio, sides, translator],
  );

  const start = useCallback(() => {
    sides.reset();
    setTurns([]);
    setRunning(true);
    stopRef.current = audio.conversation([home, local], e => {
      if (e.type === 'partial') setLive({ side: e.speaker !== undefined ? sides.assign(e.speaker, undefined) : 'traveler', text: e.text });
      else if (e.type === 'final') onFinal(e.text, e.language, e.speaker);
    });
  }, [audio, local, onFinal, sides]);

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = undefined;
    setRunning(false);
    setLive(undefined);
  }, []);

  useEffect(() => stop, [stop]);

  const column = (side: Side) => (
    <View style={styles.col}>
      <Text style={ui.h2}>{side === 'traveler' ? `You · ${LANG_NAMES[home]}` : `Local · ${LANG_NAMES[local]}`}</Text>
    </View>
  );

  return (
    <View style={[ui.panel, styles.wrap]}>
      <View style={[ui.row, { justifyContent: 'space-between', marginBottom: 8 }]}>
        <View>
          <Text style={styles.title}>Conversation translator</Text>
          <Text style={ui.small}>
            {audio.info.liveSpeakers ? 'Speakers are told apart live by Argmax.' : audio.info.hasMicrophone ? 'Speakers are told apart after each sentence.' : 'Replaying a scripted conversation (no audio helper).'}
          </Text>
        </View>
        <Pressable style={[ui.button, running && { backgroundColor: colors.danger }]} onPress={running ? stop : start}>
          <Text style={ui.buttonText}>{running ? 'Stop' : 'Start listening'}</Text>
        </Pressable>
      </View>
      <View style={ui.row}>
        {column('traveler')}
        {column('local')}
      </View>
      <ScrollView ref={scroll} style={{ flex: 1 }} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
        {turns.map(t => (
          <View key={t.id} style={[styles.turn, t.side === 'traveler' ? styles.left : styles.right]}>
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
  original: { fontSize: 13, color: colors.muted, marginBottom: 4 },
  translation: { fontSize: 17, fontWeight: '600', color: colors.ink },
});
