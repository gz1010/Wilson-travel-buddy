import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { MapView, type MapPin } from '../map/MapView';
import { Conversation } from './Conversation';
import { Header } from './Header';
import { Itinerary } from './Itinerary';
import { SituationBar } from './SituationBar';
import { Suggestions } from './Suggestions';
import { TranslatorScreen } from './translator/TranslatorScreen';
import type { Buddy } from './useBuddy';
import { colors } from './theme';

export function Home({ b }: { b: Buddy }) {
  const pins = useMemo<MapPin[]>(() => {
    const recIds = new Map(b.recs.map((r, i) => [r.placeId, i + 1]));
    const stopIds = new Set(b.trip?.stops.map(s => s.placeId).filter(Boolean));
    return b.index.pack.places.map(p => ({
      id: p.id,
      name: p.name,
      lat: p.point.lat,
      lon: p.point.lon,
      kind: recIds.has(p.id) ? 'rec' : stopIds.has(p.id) ? 'stop' : 'place',
      badge: recIds.has(p.id) ? String(recIds.get(p.id)) : stopIds.has(p.id) ? '★' : undefined,
    }));
  }, [b.index, b.recs, b.trip]);

  return (
    <View style={styles.root}>
      <Header b={b} />
      <View style={styles.body}>
        <ScrollView style={styles.left} contentContainerStyle={{ gap: 12, paddingBottom: 16 }}>
          <Suggestions b={b} />
          <Itinerary b={b} />
        </ScrollView>
        {/* The map stays mounted while the translator is open: reloading it costs seconds. */}
        {b.mode === 'translator' && (
          <View style={styles.center}>
            <TranslatorScreen b={b} />
          </View>
        )}
        <>
            <View style={[styles.center, b.mode === 'translator' && styles.hidden]}>
              <MapView
                bounds={b.index.destination.bounds}
                pins={pins}
                you={b.situation.location}
                focusId={b.focusId}
                onPress={p => b.setLocation(p)}
                onSelect={id => b.setFocusId(id)}
              />
              <SituationBar b={b} />
            </View>
            <View style={[styles.right, b.mode === 'translator' && styles.hidden]}>
              <Conversation b={b} />
            </View>
        </>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1, flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 16, gap: 12 },
  left: { width: 340, flexGrow: 0 },
  center: { flex: 1, gap: 12 },
  right: { width: 360 },
  hidden: { display: 'none' },
});
