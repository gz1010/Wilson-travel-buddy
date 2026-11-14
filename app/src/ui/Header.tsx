import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Buddy } from './useBuddy';
import { colors, ui } from './theme';

/** Title, the "Offline" badge, and the on-device model names, so judges see nothing leaves the Mac. */
export function Header({ b }: { b: Buddy }) {
  const { runtime } = b;
  const models = [runtime.llm.name, ...runtime.audio.info.models];
  return (
    <View style={styles.bar}>
      <View>
        <Text style={styles.title}>Travel Buddy</Text>
        <Text style={ui.small}>{b.index.destination.name}, {b.index.destination.country}</Text>
      </View>
      <View style={styles.badge}>
        <View style={styles.dot} />
        <Text style={styles.badgeText}>Offline · on-device</Text>
      </View>
      <View style={[ui.row, styles.models]}>
        {models.map(m => (
          <View key={m} style={ui.chip}>
            <Text style={ui.chipText}>{m}</Text>
          </View>
        ))}
      </View>
      <View style={{ flex: 1 }} />
      <Pressable style={[ui.button, b.mode === 'translator' && { backgroundColor: colors.accent }]} onPress={() => b.setMode(b.mode === 'translator' ? 'home' : 'translator')}>
        <Text style={ui.buttonText}>{b.mode === 'translator' ? 'Back to companion' : 'Translator'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 14 },
  title: { fontSize: 20, fontWeight: '800', color: colors.ink },
  badge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#e3f2e8', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.green, marginRight: 6 },
  badgeText: { color: colors.green, fontWeight: '700', fontSize: 12 },
  models: { flexWrap: 'wrap', marginTop: 6 },
});
