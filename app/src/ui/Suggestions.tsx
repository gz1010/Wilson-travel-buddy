import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Buddy } from './useBuddy';
import { colors, ui } from './theme';

/** The centrepiece: what to do right now, each with a reason tied to the situation. */
export function Suggestions({ b }: { b: Buddy }) {
  return (
    <View style={ui.panel}>
      <View style={[ui.row, { justifyContent: 'space-between' }]}>
        <Text style={ui.h2}>Right now</Text>
        {b.recsThinking && <Text style={ui.small}>thinking…</Text>}
      </View>
      {b.recs.length === 0 && <Text style={ui.small}>Nothing nearby is open and fits right now. Try another time or place.</Text>}
      {b.recs.map((r, i) => {
        const p = r.candidate.place;
        const focused = b.focusId === p.id;
        return (
          <Pressable key={p.id} onPress={() => b.setFocusId(p.id)} style={[styles.card, focused && styles.focused]}>
            <View style={ui.row}>
              <View style={styles.num}>
                <Text style={styles.numText}>{i + 1}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{p.name}</Text>
                <Text style={ui.small}>
                  {r.candidate.walkMinutes} min walk{r.candidate.closesAt ? ` · until ${r.candidate.closesAt}` : ''}
                  {p.indoor ? ' · indoor' : ''}
                </Text>
              </View>
            </View>
            <Text style={[ui.body, { marginTop: 6 }]}>{r.reason}</Text>
            <View style={[ui.row, { marginTop: 8 }]}>
              <Pressable style={[ui.ghost, { marginRight: 6 }]} onPress={() => b.addToTrip(p.id)}>
                <Text style={ui.ghostText}>Add to plan</Text>
              </Pressable>
              <Pressable style={[ui.ghost, { marginRight: 6 }]} onPress={() => b.say(`${p.name}. ${r.reason}`)}>
                <Text style={ui.ghostText}>Say it</Text>
              </Pressable>
              <Pressable style={ui.ghost} onPress={() => b.markVisited(p.id)}>
                <Text style={ui.ghostText}>Been there</Text>
              </Pressable>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.line },
  focused: { backgroundColor: '#fff6f2' },
  num: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  numText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  name: { fontSize: 15, fontWeight: '700', color: colors.ink },
});
