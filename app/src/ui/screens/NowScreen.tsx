import React, { useLayoutEffect, useRef } from 'react';
import { Animated, Easing, Pressable, ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native';
import { clockFor, placeNameSize, timeOfDay, TIME_OF_DAY_LABEL, TIMES_OF_DAY } from '../../core/look';
import { formatHHMM } from '../../core/time';
import { tripDay } from '../../core/trip';
import type { Recommendation } from '../../core/types';
import { Glass, GlassChip, OfflineChip, onGlass } from '../dusk/Glass';
import { GlassText } from '../dusk/GlassText';
import { useReduceMotion } from '../dusk/motion';
import { HeroPhoto, PhotoFade, PlacePhoto } from '../dusk/Photos';
import { dusk, font, ground, white } from '../dusk/tokens';
import type { ScreenProps } from './types';
import { useScreenSize } from '../dusk/Screen';

// AntNow: the centrepiece. The city photo for the time of day, the clock and weather, the
// time-of-day chips, and the three suggestions for right now. DuskRoot draws the tab bar.

const W = dusk.layout.phoneWidth;
const CARDS_TOP = 318;
const CARD_GAP = 10;
/** The tab bar's top edge above the bottom of the screen (DuskRoot: bottom 26 + 58 tall). */
const TAB_BAR_RESERVE = 26 + dusk.size.tabBar + 2;
const MAX_CARDS = 3;

export function NowScreen({ b, nav }: ScreenProps) {
  const { width } = useScreenSize();
  const sx = width / W;
  const reduce = useReduceMotion();
  const { clock } = b.situation;
  const dest = b.index.destination;
  const tod = timeOfDay(clock, dest);

  // Header: "Seville · day 2 of 4", or just the city with no trip (or outside its dates).
  const day = b.trip ? tripDay(b.trip, clock.date) : undefined;

  // Weather from the saved forecast.
  const now = b.index.forecastAt(clock);
  const rain = b.index.forecastAhead(clock, 12).find(h => h.precipitationChance >= 50);
  const weather = now
    ? `${Math.round(now.temperatureC)}° · ${now.precipitationChance}% rain` +
      (rain ? ` · rain from ${rain.time.slice(11, 16)}${rain.time.slice(0, 10) !== clock.date ? ' tomorrow' : ''}` : '')
    : 'No saved forecast for this day';

  // Every on-device model by name (SPEC: always visible on Now).
  const models = [b.runtime.llm.name, ...b.runtime.audio.info.models].filter(Boolean).join(' · ');

  const cards = b.recs.slice(0, MAX_CARDS);

  // Re-plans: when the set of suggested places changes, the cards fade and slide in.
  const idsKey = cards.map(r => r.placeId).join('|');
  const anims = useRef(Array.from({ length: MAX_CARDS }, () => new Animated.Value(0))).current;
  useLayoutEffect(() => {
    if (reduce) {
      anims.forEach(a => a.setValue(1));
      return;
    }
    anims.forEach(a => a.setValue(0));
    const run = Animated.parallel(
      anims.map(a => Animated.timing(a, { toValue: 1, duration: dusk.motion.replan, easing: Easing.out(Easing.cubic), useNativeDriver: true })),
    );
    run.start();
    return () => run.stop();
  }, [idsKey, reduce, anims]);

  return (
    <View style={styles.root}>
      {/* Top 330: the city photo for the time of day, fading into the ground. */}
      <View style={styles.hero} pointerEvents="none">
        <HeroPhoto tod={tod} style={StyleSheet.absoluteFill} />
        <PhotoFade stops={[[0, 0.5], [0.38, 0.1], [0.6, 0.05], [1, 1]]} />
      </View>

      <View style={[styles.header, { left: 22 * sx, right: 22 * sx }]}>
        <Text style={[styles.city, font('700')]} numberOfLines={1} accessibilityRole="header">
          {dest.name}
          {day !== undefined && b.trip ? <Text style={[font('500'), { fontSize: 15 }]}>{` · day ${day} of ${b.trip.days}`}</Text> : null}
        </Text>
        <View style={styles.headerRight}>
          {b.recsThinking && (
            <Text style={[styles.thinking, font('500')]} accessibilityLiveRegion="polite">
              thinking…
            </Text>
          )}
          <OfflineChip />
        </View>
      </View>

      <View style={[styles.clockBlock, { left: 22 * sx }]}>
        <Text style={[styles.clock, font(dusk.font.clock.weight)]} accessibilityLabel={`It is ${formatHHMM(clock.minute)}`}>
          {formatHHMM(clock.minute)}
        </Text>
        <Text style={[styles.weather, font('700')]}>{weather}</Text>
        <Text style={[styles.models, font('500')]} numberOfLines={2}>
          {models}
        </Text>
      </View>

      <View accessibilityRole="radiogroup" accessibilityLabel="Time of day" style={[styles.chips, { left: 16 * sx, right: 16 * sx }]}>
        {TIMES_OF_DAY.map(t => (
          <GlassChip key={t} label={TIME_OF_DAY_LABEL[t]} selected={t === tod} onPress={() => b.setClock(clockFor(t, clock, dest))} style={styles.chip} />
        ))}
      </View>

      {/* The suggestions. They fit an 844 px phone; on a shorter one this area scrolls under the tab bar. */}
      <ScrollView
        accessibilityLabel="Right now"
        style={styles.cardsArea}
        contentContainerStyle={{ gap: CARD_GAP, paddingHorizontal: 12 * sx, paddingBottom: TAB_BAR_RESERVE }}
        showsVerticalScrollIndicator={false}
        alwaysBounceVertical={false}>
        {cards.length === 0 ? (
          <Glass kind="clear" style={styles.empty}>
            <Text style={[onGlass, font('700'), { fontSize: 15 }]}>Nothing fits right now</Text>
            <Text style={[styles.emptyHint, font('500')]}>Try another time of day, or ask your buddy what you feel like.</Text>
          </Glass>
        ) : (
          cards.map((r, i) => (
            <Animated.View
              key={r.placeId}
              style={{ opacity: anims[i], transform: [{ translateY: anims[i].interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }}>
              <SuggestionCard rec={r} rank={i + 1} sx={sx} onPress={() => nav.openPlace(r.placeId)} />
            </Animated.View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

function SuggestionCard({ rec, rank, sx, onPress }: { rec: Recommendation; rank: number; sx: number; onPress: () => void }) {
  const place = rec.candidate.place;
  const walk = `${rec.candidate.walkMinutes} min walk`;
  // The design sizes names for a 366 px card; scale with the card so the cut-off stays the same.
  const nameSize = Math.round(placeNameSize(place.name) * sx);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${rank}. ${place.name}, ${walk}. ${rec.reason}`}
      accessibilityHint="Opens the place"
      onPress={onPress}
      style={({ pressed }) => [styles.cardShadow, { opacity: pressed ? 0.9 : 1, transform: [{ scale: pressed ? 0.99 : 1 }] }]}>
      <View style={styles.card}>
        <PlacePhoto place={place} style={StyleSheet.absoluteFill} />
        <PhotoFade stops={[[0, 0.55], [0.45, 0.08], [1, 0.42]]} />
        <View pointerEvents="none" style={styles.cardRim} />

        <Glass kind="clear" radius={999} style={styles.walkPill}>
          <Text style={[onGlass, font('700'), { fontSize: 12 }]}>{walk}</Text>
        </Glass>
        <Glass kind="orb" radius={15} style={styles.rankOrb}>
          <Text style={[onGlass, font('800'), { fontSize: 12 }]}>{rank}</Text>
        </Glass>

        <Text style={[styles.reason, font('600')]} numberOfLines={3}>
          {rec.reason}
        </Text>
        <GlassText place={place} size={nameSize} />
      </View>
    </Pressable>
  );
}

const shadowText = (radius: number, alpha: number): TextStyle => ({
  textShadowColor: ground(alpha),
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: radius,
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: dusk.color.ground },
  hero: { position: 'absolute', left: 0, right: 0, top: 0, height: dusk.layout.heroHeight, overflow: 'hidden' },
  header: { position: 'absolute', top: 56, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  city: { flexShrink: 1, fontSize: 24, letterSpacing: -0.48, color: dusk.color.text, ...shadowText(12, 0.45) },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  thinking: { fontSize: 11, color: dusk.color.text2, ...shadowText(6, 0.5) },
  clockBlock: { position: 'absolute', top: 96, right: 16 },
  clock: { fontSize: dusk.font.clock.size, lineHeight: dusk.font.clock.size * 1.05, letterSpacing: dusk.font.clock.letterSpacing, color: dusk.color.text, ...shadowText(16, 0.5) },
  weather: { fontSize: 14, marginTop: 4, color: dusk.color.text, ...shadowText(16, 0.5) },
  models: { fontSize: 11, marginTop: 4, color: dusk.color.text2, ...shadowText(8, 0.5) },
  // GlassChip is 44 tall around a 40 px pill, so the row starts 2 px above the mockup's 262.
  chips: { position: 'absolute', top: 260, flexDirection: 'row', gap: 6 },
  chip: { flex: 1 },
  cardsArea: { position: 'absolute', left: 0, right: 0, top: CARDS_TOP, bottom: 0 },
  cardShadow: {
    borderRadius: dusk.radius.card,
    backgroundColor: dusk.color.raised,
    shadowColor: dusk.color.ground,
    shadowOpacity: 0.6,
    shadowRadius: 15,
    shadowOffset: { width: 0, height: 10 },
  },
  card: { height: dusk.layout.cardHeight, borderRadius: dusk.radius.card, overflow: 'hidden', backgroundColor: dusk.color.raised },
  cardRim: { position: 'absolute', left: 18, right: 18, top: 0, height: 1, backgroundColor: white(0.35) },
  walkPill: { position: 'absolute', left: 12, top: 12, height: 28, paddingHorizontal: 12, justifyContent: 'center' },
  rankOrb: { position: 'absolute', right: 12, top: 12, width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  reason: { position: 'absolute', left: 16, right: 56, top: 50, fontSize: 14, lineHeight: 19, color: dusk.color.white, ...shadowText(10, 0.7) },
  empty: { padding: 22, gap: 6 },
  emptyHint: { fontSize: 14, lineHeight: 19, color: dusk.color.textSoft },
});
