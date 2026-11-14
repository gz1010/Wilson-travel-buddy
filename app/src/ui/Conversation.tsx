import React, { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Buddy } from './useBuddy';
import { colors, ui } from './theme';

const QUICK = ['What should I do now?', "What's near my hotel?", 'Tell me about the Cathedral', 'How do I say “the bill, please”?'];

/** One conversation for everything: voice and typing go through the same companion. */
export function Conversation({ b }: { b: Buddy }) {
  const [text, setText] = useState('');
  const scroll = useRef<ScrollView>(null);
  const hasMic = b.runtime.audio.info.hasMicrophone;
  const submit = () => {
    if (!text.trim() || b.busy) return;
    b.send(text);
    setText('');
  };

  return (
    <View style={[ui.panel, styles.wrap]}>
      <Text style={ui.h2}>Ask Travel Buddy</Text>
      <ScrollView ref={scroll} style={styles.list} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
        {b.chat.length === 0 && <Text style={ui.small}>Ask anything about {b.index.destination.name}, or tell me your plans.</Text>}
        {b.chat.map(l => (
          <View key={l.id} style={[styles.bubble, l.who === 'you' ? styles.you : styles.buddy]}>
            <Text style={[ui.body, l.who === 'you' && { color: '#fff' }, l.error && { color: colors.danger }]}>
              {l.text || (l.pending ? '…' : '')}
            </Text>
          </View>
        ))}
        {!!b.partial && (
          <View style={[styles.bubble, styles.you, { opacity: 0.6 }]}>
            <Text style={[ui.body, { color: '#fff' }]}>{b.partial}</Text>
          </View>
        )}
      </ScrollView>
      {!!b.status && <Text style={[ui.small, { marginBottom: 6 }]}>{b.status}</Text>}
      <View style={[ui.row, { flexWrap: 'wrap' }]}>
        {QUICK.map(q => (
          <Pressable key={q} style={ui.chip} onPress={() => !b.busy && b.send(q)}>
            <Text style={ui.chipText}>{q}</Text>
          </Pressable>
        ))}
      </View>
      <View style={[ui.row, { marginTop: 6 }]}>
        {hasMic && (
          <Pressable style={[styles.mic, b.listening && styles.micOn]} onPress={b.talk}>
            <Text style={styles.micText}>{b.listening ? '■' : '🎙'}</Text>
          </Pressable>
        )}
        <TextInput
          style={styles.input}
          placeholder={hasMic ? 'Or type here…' : 'Type here (no microphone: the audio helper is not running)'}
          value={text}
          onChangeText={setText}
          onSubmitEditing={submit}
        />
        <Pressable style={[ui.button, { marginLeft: 6 }]} onPress={submit}>
          <Text style={ui.buttonText}>Send</Text>
        </Pressable>
      </View>
      {b.speaking && (
        <Pressable onPress={b.stopSpeaking}>
          <Text style={[ui.small, { marginTop: 6 }]}>Speaking… click to stop</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  list: { flex: 1, marginBottom: 8 },
  bubble: { padding: 10, borderRadius: 12, marginBottom: 6, maxWidth: '92%' },
  you: { alignSelf: 'flex-end', backgroundColor: colors.ink },
  buddy: { alignSelf: 'flex-start', backgroundColor: colors.soft },
  mic: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  micOn: { backgroundColor: colors.danger },
  micText: { fontSize: 18, color: '#fff' },
  input: { flex: 1, borderWidth: 1, borderColor: colors.line, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: colors.ink },
});
