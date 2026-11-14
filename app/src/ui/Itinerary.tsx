import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { addDays, weekday, WEEKDAY_NAMES } from '../core/time';
import { tripDay } from '../core/trip';
import type { Buddy } from './useBuddy';
import { colors, ui } from './theme';

export function Itinerary({ b }: { b: Buddy }) {
  const { trip } = b;
  if (!trip) {
    return (
      <View style={[ui.panel, styles.empty]}>
        <Text style={ui.h2}>Your trip</Text>
        <Text style={ui.body}>Tell me about your trip, by voice or typing. For example:</Text>
        <Text style={styles.example}>
          “I'm here three days, staying near Santa Cruz. I love street food and architecture, and Tuesday afternoon I have a ticket for the Museum of Fine Arts.”
        </Text>
      </View>
    );
  }
  const today = tripDay(trip, b.situation.clock.date);
  return (
    <View style={[ui.panel, b.tripIsNew && styles.isNew]}>
      <View style={[ui.row, { justifyContent: 'space-between' }]}>
        <Text style={ui.h2}>Your trip</Text>
        <Pressable onPress={b.clearTrip}>
          <Text style={ui.small}>Start over</Text>
        </Pressable>
      </View>
      <Text style={ui.small}>
        {trip.days} days{trip.base ? ` · staying near ${trip.base.name}` : ''}
      </Text>
      {trip.interests.length > 0 && (
        <View style={[ui.row, { flexWrap: 'wrap', marginTop: 6 }]}>
          {trip.interests.map(i => (
            <View key={i} style={ui.chip}>
              <Text style={ui.chipText}>{i}</Text>
            </View>
          ))}
        </View>
      )}
      {Array.from({ length: trip.days }, (_, d) => d + 1).map(day => {
        const stops = trip.stops.filter(s => s.day === day);
        const date = addDays(trip.startDate, day - 1);
        return (
          <View key={day} style={[styles.day, day === today && styles.today]}>
            <Text style={styles.dayTitle}>
              Day {day} · {WEEKDAY_NAMES[weekday(date)]}
              {day === today ? ' · today' : ''}
            </Text>
            {stops.length === 0 && <Text style={ui.small}>Free</Text>}
            {stops.map(s => (
              <Pressable key={s.id} style={styles.stop} onPress={() => s.placeId && b.setFocusId(s.placeId)}>
                <Text style={styles.time}>{s.start ?? '—'}</Text>
                <Text style={[ui.body, { flex: 1 }]}>
                  {s.title}
                  {s.fixed ? '  🎟' : ''}
                </Text>
                <Pressable onPress={() => b.removeStop(s.id)}>
                  <Text style={ui.small}>✕</Text>
                </Pressable>
              </Pressable>
            ))}
          </View>
        );
      })}
      {b.tripIsNew && (
        <View style={[ui.row, { marginTop: 8 }]}>
          <Pressable style={ui.button} onPress={b.confirmTrip}>
            <Text style={ui.buttonText}>Looks right</Text>
          </Pressable>
          <Text style={[ui.small, { marginLeft: 10, flex: 1 }]}>Or say what to fix: “move the museum to tomorrow”.</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { gap: 6 },
  example: { fontSize: 13, color: colors.muted, fontStyle: 'italic', lineHeight: 19 },
  isNew: { borderColor: colors.green, borderWidth: 2 },
  day: { marginTop: 10, paddingLeft: 8, borderLeftWidth: 3, borderLeftColor: colors.line },
  today: { borderLeftColor: colors.green },
  dayTitle: { fontSize: 13, fontWeight: '700', color: colors.ink, marginBottom: 4 },
  stop: { flexDirection: 'row', alignItems: 'center', paddingVertical: 3 },
  time: { width: 46, fontSize: 12, fontWeight: '700', color: colors.green },
});
