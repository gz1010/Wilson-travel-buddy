import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { sunTimes } from '../core/sun';
import { addDays, daysBetween, formatClock, formatHHMM } from '../core/time';
import type { Buddy } from './useBuddy';
import { colors, ui } from './theme';

/**
 * The demo controls (time, day, "where I am") and the environment panel:
 * forecast with its age, sunrise and sunset computed on the device.
 */
export function SituationBar({ b }: { b: Buddy }) {
  const { situation: sit, index } = b;
  const [where, setWhere] = useState('');
  const [notFound, setNotFound] = useState(false);
  const dest = index.destination;
  const sun = sunTimes(sit.clock.date, dest.center, dest.utcOffsetMinutes);
  const now = index.forecastAt(sit.clock);
  const nextRain = index.forecastAhead(sit.clock, 12).find(h => h.precipitationChance >= 50);
  const savedDay = index.pack.forecast.savedAt.slice(0, 10);
  const age = daysBetween(savedDay, sit.clock.date);

  return (
    <View style={[ui.panel, styles.wrap]}>
      <View style={styles.block}>
        <Text style={ui.h2}>Time</Text>
        <Text style={styles.big}>{formatClock(sit.clock)}</Text>
        <View style={ui.row}>
          {[-60, -15, 15, 60].map(m => (
            <Pressable key={m} style={[ui.ghost, styles.step]} onPress={() => b.shiftMinutes(m)}>
              <Text style={ui.ghostText}>{m > 0 ? `+${m}` : m}m</Text>
            </Pressable>
          ))}
        </View>
        <View style={[ui.row, { marginTop: 6 }]}>
          {[9, 13, 17, 21].map(h => (
            <Pressable key={h} style={[ui.ghost, styles.step]} onPress={() => b.setClock({ ...sit.clock, minute: h * 60 })}>
              <Text style={ui.ghostText}>{h}:00</Text>
            </Pressable>
          ))}
          <Pressable style={[ui.ghost, styles.step]} onPress={() => b.setClock({ ...sit.clock, date: addDays(sit.clock.date, 1) })}>
            <Text style={ui.ghostText}>Next day</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.block}>
        <Text style={ui.h2}>Where I am</Text>
        <Text style={styles.big} numberOfLines={1}>{sit.locationLabel}</Text>
        <TextInput
          style={[styles.input, notFound && { borderColor: colors.danger }]}
          placeholder="Type a place, or click the map"
          value={where}
          onChangeText={t => {
            setWhere(t);
            setNotFound(false);
          }}
          onSubmitEditing={() => {
            if (b.setLocationByName(where)) setWhere('');
            else setNotFound(true);
          }}
        />
      </View>

      <View style={styles.block}>
        <Text style={ui.h2}>Weather</Text>
        {now ? (
          <>
            <Text style={styles.big}>
              {Math.round(now.temperatureC)}°C · {now.precipitationChance}% rain
            </Text>
            <Text style={ui.small}>{nextRain ? `Rain likely from ${nextRain.time.slice(11)}${nextRain.time.slice(0, 10) !== sit.clock.date ? ' tomorrow' : ''}` : 'No rain expected in the next 12 hours'}</Text>
          </>
        ) : (
          <Text style={ui.small}>The saved forecast does not cover this day.</Text>
        )}
        <Text style={ui.small}>
          Sunrise {sun.sunrise !== undefined ? formatHHMM(sun.sunrise) : '–'} · Sunset {sun.sunset !== undefined ? formatHHMM(sun.sunset) : '–'}
        </Text>
        <Text style={[ui.small, { marginTop: 2 }]}>
          Forecast saved {age <= 0 ? 'today' : age === 1 ? '1 day ago' : `${age} days ago`}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', gap: 18 },
  block: { flex: 1 },
  big: { fontSize: 17, fontWeight: '700', color: colors.ink, marginBottom: 6 },
  step: { marginRight: 6, paddingHorizontal: 8, paddingVertical: 4 },
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, fontSize: 13, color: colors.ink },
});
