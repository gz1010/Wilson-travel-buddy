import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type TextStyle } from 'react-native';
import { dayTimeline, forecastDates, pickDistinct, placeBefore, planDays, reasonWithoutWalk, stopSpan, type PlanDay, type TimelineRow } from '../../core/dayplan';
import { timeOfDay } from '../../core/look';
import { templateReason } from '../../core/scoring';
import { formatHHMM } from '../../core/time';
import { stopsOn, tripDay } from '../../core/trip';
import type { Place, Recommendation, Situation, Stop } from '../../core/types';
import { heroPhotos } from '../../pack/seville/photos';
import { AmbientBackdrop } from '../dusk/AmbientBackdrop';
import { axPress, Glass, OfflineChip, onGlass } from '../dusk/Glass';
import { GlassText, nameBaseline, nameSizeForRoom } from '../dusk/GlassText';
import { glassWordSize } from '../dusk/GlassWord';
import { LiquidGlass } from '../dusk/LiquidGlass';
import { tidyModel } from '../dusk/modelNames';
import { useReduceMotion } from '../dusk/motion';
import { LinearGradient } from '../dusk/Gradient';
import { PhotoFade, PlacePhoto, placePhotoSource } from '../dusk/Photos';
import { useScreenSize } from '../dusk/Screen';
import { dusk, font, ground, white } from '../dusk/tokens';
import type { Buddy } from '../useBuddy';
import type { ScreenProps } from './types';

// AntNow, by days: a compact header (the city photo for the time of day, the clock, the weather,
// the Offline chip and the on-device models), a strip of the trip's days, and the picked day as a
// timeline: times on the left, that day's planned stops and suggestions on the right, and on
// today a "now" line with the suggestions for right now. DuskRoot draws the tab bar.

const W = dusk.layout.phoneWidth;
/** Below the window's title bar, as on the other screens. */
const TOP = 56;
/** Room under the timeline for the floating tab bar. */
const TAB_BAR_RESERVE = 104;
/** The time column, and the rail running down it. */
const TIME_W = 62;
const RAIL_X = 52;
/** Suggestion cards: a free time, and right now (the model's reason can run to three lines). */
const CARD_H = 112;
const NOW_CARD_H = 128;
const NOW_CARDS = 2;
/** Place names get the card's whole width and the height under the reason, up to this size. */
const NAME_MAX = 46;
const NAME_INSET = 10;
/** The reason under the walk pill: its top, side padding and line height (styles.reason). */
const REASON_TOP = 42;
const REASON_X = 14;
const REASON_LINE = 17;
/** Between the reason's last line and the tallest letters of the name. */
const NAME_GAP = 4;
/**
 * The glass names are WebGL web views. WebKit keeps a limited number of live WebGL contexts and
 * drops the oldest past that (which would blank a card), so only cards in or near view get one;
 * the rest draw the same name natively.
 */
const MAX_GLASS = 6;
const GLASS_MARGIN = 200;
/** The shade over the timeline's top edge (EdgeShade): px above and below the edge, and its alphas. */
const EDGE_ABOVE = 16;
const EDGE_BELOW = 34;
const EDGE_SHADE: [number, number][] = [
  [0, 0],
  [EDGE_ABOVE / (EDGE_ABOVE + EDGE_BELOW), 0.2],
  [(EDGE_ABOVE + 8) / (EDGE_ABOVE + EDGE_BELOW), 0.1],
  [1, 0],
];
/** Scrolled further than this, something is under the edge. */
const EDGE_UNDER = 4;
/** Room under the day chips for their shadows (the strip clips its content). */
const STRIP_SHADOW = 12;
const CLOCK_SIZE = Math.round(dusk.font.clock.size * 0.8);
/** Rain from this chance shows next to a time. */
const RAIN_SHOWN = 30;

/** Dark behind the pills at the top and behind the glass name at the bottom. */
const CARD_FADE: [number, number][] = [
  [0, 0.55],
  [0.42, 0.12],
  [1, 0.58],
];
/** Dark behind the city and the clock at the top; it clears before the sharp photo melts into the blur. */
const HERO_FADE: [number, number][] = [
  [0, 0.5],
  [0.35, 0.12],
  [0.75, 0.16],
  [1, 0],
];

export function NowScreen({ b, nav }: ScreenProps) {
  const { width } = useScreenSize();
  const sx = width / W;
  const { clock } = b.situation;
  const dest = b.index.destination;
  const tod = timeOfDay(clock, dest);
  const trip = b.trip;

  // Header: "Seville · day 2 of 4", or just the city with no trip (or outside its dates).
  const dayNo = trip ? tripDay(trip, clock.date) : undefined;

  // Weather from the saved forecast.
  const now = b.index.forecastAt(clock);
  const rain = b.index.forecastAhead(clock, 12).find(h => h.precipitationChance >= 50);
  const weather = now
    ? `${Math.round(now.temperatureC)}° · ${now.precipitationChance}% rain` + (rain ? ` · rain from ${rain.time.slice(11, 16)}${rain.time.slice(0, 10) !== clock.date ? ' tomorrow' : ''}` : '')
    : 'No saved forecast for this day';

  // Every on-device model by name (SPEC: always visible on Now).
  const models = [b.runtime.llm.name, ...b.runtime.audio.info.models].filter(Boolean).map(tidyModel).join(' · ');

  // The days: the trip's (so days added in Chat appear), or today and the forecast's days.
  const forecast = useMemo(() => forecastDates(b.index.pack.forecast.hours), [b.index]);
  const days = useMemo(() => planDays(trip, clock.date, forecast), [trip, clock.date, forecast]);
  // A picked day holds until the clock moves to another date (a tapped time, or Chat).
  const [pick, setPick] = useState<{ date: string; at: string }>();
  const pickedDate = pick && pick.at === clock.date ? pick.date : clock.date;
  const day = days.find(d => d.date === pickedDate) ?? days.find(d => d.today) ?? days[0];

  // The photo runs down behind the header and the day strip.
  const [topH, setTopH] = useState(0);
  const onTopLayout = (e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    if (h !== topH) setTopH(h);
  };

  return (
    <View style={styles.root}>
      {/* The city photo for the time of day: sharp behind the header, melting into a blurred,
          darkened version of itself behind the timeline, so the glass has colour to bend. */}
      <AmbientBackdrop source={heroPhotos[tod]} sharpTo={(topH || 240) + 24} melt={170} />
      <View style={[styles.hero, { height: (topH || 240) + 24 }]} pointerEvents="none">
        <PhotoFade stops={HERO_FADE} />
      </View>

      <View onLayout={onTopLayout} style={styles.top}>
        <View style={[styles.header, { marginHorizontal: 22 * sx }]}>
          <Text style={[styles.city, font('700')]} numberOfLines={1} accessibilityRole="header">
            {dest.name}
            {dayNo !== undefined && trip ? <Text style={[font('500'), { fontSize: 15 }]}>{` · day ${dayNo} of ${trip.days}`}</Text> : null}
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

        <View style={[styles.clockRow, { marginHorizontal: 22 * sx }]}>
          <Text style={[styles.clock, font(dusk.font.clock.weight)]} accessibilityLabel={`It is ${formatHHMM(clock.minute)}`}>
            {formatHHMM(clock.minute)}
          </Text>
          <Text style={[styles.weather, font('700')]} numberOfLines={2}>
            {weather}
          </Text>
        </View>
        <Text style={[styles.models, font('500'), { marginHorizontal: 22 * sx }]} numberOfLines={2}>
          {models}
        </Text>

        <DayStrip days={days} selected={day.date} sx={sx} onPick={date => setPick({ date, at: clock.date })} />
      </View>

      <DayTimeline key={day.date} b={b} onOpen={nav.openPlace} day={day} sx={sx} width={width} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// The day strip

function DayStrip({ days, selected, sx, onPick }: { days: PlanDay[]; selected: string; sx: number; onPick: (date: string) => void }) {
  const scroll = useRef<ScrollView>(null);
  const xs = useRef(new Map<string, number>());
  const pad = 16 * sx;
  // Keep the picked day in view (a long trip runs past the window's edge).
  const reveal = useCallback(
    (date: string, animated: boolean) => {
      const x = xs.current.get(date);
      if (x !== undefined) scroll.current?.scrollTo({ x: Math.max(0, x - pad - 48), animated });
    },
    [pad],
  );
  useEffect(() => reveal(selected, true), [selected, reveal]);
  return (
    <ScrollView
      ref={scroll}
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="radiogroup"
      accessibilityLabel="Days"
      style={styles.strip}
      contentContainerStyle={[styles.stripContent, { paddingHorizontal: pad }]}
    >
      {days.map(d => (
        <DayChip
          key={d.date}
          day={d}
          selected={d.date === selected}
          onPress={() => onPick(d.date)}
          onLayout={e => {
            xs.current.set(d.date, e.nativeEvent.layout.x);
            if (d.date === selected) reveal(d.date, false);
          }}
        />
      ))}
    </ScrollView>
  );
}

/** "NOV Sun 15": a glass pill; the picked day is prominent glass, scaled to 1.04 like GlassChip. */
function DayChip({ day, selected, onPress, onLayout }: { day: PlanDay; selected: boolean; onPress: () => void; onLayout: (e: LayoutChangeEvent) => void }) {
  const reduce = useReduceMotion();
  const scale = useRef(new Animated.Value(selected ? dusk.motion.selectScale : 1)).current;
  useEffect(() => {
    const to = selected ? dusk.motion.selectScale : 1;
    if (reduce) {
      scale.setValue(to);
      return;
    }
    const run = Animated.timing(scale, {
      toValue: to,
      duration: dusk.motion.replan,
      useNativeDriver: true,
    });
    run.start();
    return () => run.stop();
  }, [selected, reduce, scale]);
  const label = [day.spoken, day.today ? 'today' : '', day.tripDay ? `day ${day.tripDay} of the trip` : ''].filter(Boolean).join(', ');
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={label} onPress={onPress} {...axPress(onPress)} onLayout={onLayout} style={styles.dayTouch}>
      <Animated.View style={{ transform: [{ scale }] }}>
        <Glass kind={selected ? 'prominent' : 'clear'} radius={999} style={styles.dayChip}>
          {day.today ? <View style={styles.todayDot} /> : null}
          {day.month ? <Text style={[styles.dayMonth, font('800')]}>{day.month.toUpperCase()}</Text> : null}
          <Text style={[onGlass, font('700'), { fontSize: 13 }]}>{day.label}</Text>
        </Glass>
      </Animated.View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// The picked day's timeline

function DayTimeline({ b, onOpen, day, sx, width }: { b: Buddy; onOpen: (placeId: string) => void; day: PlanDay; sx: number; width: number }) {
  const { clock, location, visited } = b.situation;
  const trip = b.trip;
  const today = day.date === clock.date;
  const stops = useMemo(() => (trip ? stopsOn(trip, day.date) : []), [trip, day.date]);
  const rows = useMemo(() => dayTimeline(stops, { now: today ? clock.minute : undefined }), [stops, today, clock.minute]);

  // Right now: the live suggestions (the model's picks once it has thought).
  const nowRecs = useMemo(() => (today ? b.recs.slice(0, NOW_CARDS) : []), [today, b.recs]);

  // The free times: the recommender's own ranking (code, no model) as if the clock were then and
  // the traveller at the stop before (else where they are now, or at their base on another day),
  // each time its best place that no stop, "now" or earlier time already has.
  const { index, companion } = b;
  const picks = useMemo(() => {
    const start = today ? location : trip?.base?.point ?? location;
    const lists = rows.map(row => {
      if (!row.open || row.now || row.minute === undefined) return [];
      const beforeId = placeBefore(stops, row.minute);
      const before = beforeId ? index.place(beforeId) : undefined;
      const sit: Situation = {
        clock: { date: day.date, minute: row.minute },
        location: before?.point ?? start,
        locationLabel: before?.name ?? 'where you are',
        visited,
      };
      return companion.recommender.candidates(trip, sit);
    });
    const taken = [...stops.flatMap(s => (s.placeId ? [s.placeId] : [])), ...nowRecs.map(r => r.placeId)];
    return pickDistinct(lists, taken, 1).map(list =>
      list.map<Recommendation>(c => ({
        placeId: c.place.id,
        reason: templateReason(c),
        candidate: c,
        fromModel: false,
      })),
    );
  }, [rows, stops, today, location, trip, visited, day.date, index, companion, nowRecs]);
  const recsFor = (row: TimelineRow, i: number) => (row.now ? nowRecs : picks[i] ?? []);

  // Which cards are in or near view, for the glass names (see MAX_GLASS).
  const [boxes, setBoxes] = useState<Record<string, { y: number; h: number }>>({});
  const [view, setView] = useState({ y: 0, h: 0 });
  const scroll = useRef<ScrollView>(null);
  const scrolledTo = useRef<number | undefined>(undefined);
  const onRowLayout = (row: TimelineRow) => (e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout;
    setBoxes(prev => (prev[row.key]?.y === y && prev[row.key]?.h === height ? prev : { ...prev, [row.key]: { y, h: height } }));
    // On today, open at "now" (stops earlier in the day stay above it), and follow it when a
    // tapped time moves it. The glass names follow too, in case the scroll sends no event.
    if (row.now && scrolledTo.current !== clock.minute) {
      scrolledTo.current = clock.minute;
      const to = Math.max(0, y - 8);
      scroll.current?.scrollTo({ y: to, animated: false });
      viewAt(to);
      setUnder(to > EDGE_UNDER);
    }
  };
  const viewAt = (offset: number) => {
    const y = Math.round(offset / 60) * 60;
    setView(v => (v.y === y ? v : { ...v, y }));
  };
  // Whether anything has scrolled up under the day strip (see EdgeShade).
  const [under, setUnder] = useState(false);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    viewAt(e.nativeEvent.contentOffset.y);
    setUnder(e.nativeEvent.contentOffset.y > EDGE_UNDER);
  };
  const glassIds = new Set<string>();
  if (view.h > 0) {
    rows.forEach((row, i) => {
      const box = boxes[row.key];
      if (!box || box.y + box.h < view.y - GLASS_MARGIN || box.y > view.y + view.h + GLASS_MARGIN) return;
      for (const r of recsFor(row, i)) if (glassIds.size < MAX_GLASS) glassIds.add(r.placeId);
    });
  }

  const pad = 12 * sx;
  const cardW = width - 2 * pad - TIME_W;
  const empty = !today && rows.every((row, i) => row.stops.length === 0 && recsFor(row, i).length === 0);

  return (
    <View style={styles.timeline}>
      <ScrollView
        ref={scroll}
        accessibilityLabel={`Plan for ${day.spoken}`}
        style={styles.timeline}
        contentContainerStyle={{
          paddingHorizontal: pad,
          paddingTop: 6,
          paddingBottom: TAB_BAR_RESERVE,
        }}
        showsVerticalScrollIndicator={false}
        alwaysBounceVertical={false}
        scrollEventThrottle={100}
        onScroll={onScroll}
        onLayout={e => {
          const h = Math.round(e.nativeEvent.layout.height);
          setView(v => (v.h === h ? v : { ...v, h }));
        }}
      >
        {empty ? (
          <Glass kind="clear" style={styles.empty}>
            <Text style={[onGlass, font('700'), { fontSize: 15 }]}>Nothing planned or open on {day.label}</Text>
            <Text style={[styles.emptyHint, font('500')]}>Tell your buddy in Chat what you would like to do that day.</Text>
          </Glass>
        ) : (
          <View>
            <View pointerEvents="none" style={styles.rail} />
            {rows.map((row, i) => {
              const recs = recsFor(row, i);
              const minute = row.minute;
              const setClock = minute !== undefined && !row.now ? () => b.setClock({ date: day.date, minute }) : undefined;
              return (
                <View key={row.key} onLayout={onRowLayout(row)} style={[styles.row, row.past && styles.pastRow]}>
                  {row.now ? <View pointerEvents="none" style={styles.nowLine} /> : null}
                  {/* The weather once per time (a stop and "now" can share one). */}
                  <TimeCell row={row} weather={minute !== undefined && rows[i - 1]?.minute !== minute ? weatherAt(b, day.date, minute) : []} day={day} onPress={setClock} />
                  <View style={[styles.rowBody, row.now && styles.nowBody]}>
                    {row.stops.map(s => {
                      const place = s.placeId ? b.index.place(s.placeId) : undefined;
                      return <StopCard key={s.id} stop={s} place={place} onPress={place ? () => onOpen(place.id) : undefined} />;
                    })}
                    {recs.map(r => (
                      <FadeIn key={r.placeId}>
                        <SuggestionCard rec={r} width={cardW} height={row.now ? NOW_CARD_H : CARD_H} reasonLines={row.now ? 3 : 2} glass={glassIds.has(r.placeId)} onPress={() => onOpen(r.placeId)} />
                      </FadeIn>
                    ))}
                    {row.open && recs.length === 0 ? (
                      <Text style={[styles.nothing, font('500')]}>{row.now ? 'Nothing fits right now. Ask your buddy what you feel like, or tap a later time.' : 'Nothing open nearby then.'}</Text>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
      <EdgeShade shown={under} />
    </View>
  );
}

/**
 * A soft shade across the timeline's top edge while something has scrolled up under it, so
 * cards leave under the day strip gently. It also hides the native Liquid Glass shadow a card
 * just above the edge still casts below it (cut off flat by the edge, it reads as a seam).
 */
function EdgeShade({ shown }: { shown: boolean }) {
  const reduce = useReduceMotion();
  const a = useRef(new Animated.Value(shown ? 1 : 0)).current;
  useEffect(() => {
    if (reduce) {
      a.setValue(shown ? 1 : 0);
      return;
    }
    const run = Animated.timing(a, {
      toValue: shown ? 1 : 0,
      duration: dusk.motion.replan,
      useNativeDriver: true,
    });
    run.start();
    return () => run.stop();
  }, [shown, reduce, a]);
  return (
    <Animated.View pointerEvents="none" style={[styles.edgeShade, { opacity: a }]}>
      <LinearGradient style={StyleSheet.absoluteFill} locations={EDGE_SHADE.map(s => s[0])} colors={EDGE_SHADE.map(s => ground(s[1]))} />
    </Animated.View>
  );
}

/** "19°" and, when rain is likely enough to matter, "40% rain", from the saved forecast. */
function weatherAt(b: Buddy, date: string, minute: number): string[] {
  const h = b.index.forecastAt({ date, minute });
  if (!h) return [];
  return [`${Math.round(h.temperatureC)}°`, ...(h.precipitationChance >= RAIN_SHOWN ? [`${h.precipitationChance}% rain`] : [])];
}

/** The time on the left, with its dot on the rail. A time can be tapped to set the clock to it. */
function TimeCell({ row, weather, day, onPress }: { row: TimelineRow; weather: string[]; day: PlanDay; onPress?: () => void }) {
  const cell = (
    <View style={styles.timeCell}>
      {row.now ? <Text style={[styles.nowLabel, font('800')]}>Now</Text> : null}
      <Text style={[row.now ? styles.nowTime : styles.time, font(row.now ? '700' : '800')]} numberOfLines={2}>
        {row.label}
      </Text>
      {weather.map(w => (
        <Text key={w} style={[styles.timeWeather, font('600')]} numberOfLines={1}>
          {w}
        </Text>
      ))}
      <View style={[styles.dot, row.now && styles.nowDot]} />
    </View>
  );
  if (!onPress) return cell;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.label}, ${day.spoken}`}
      accessibilityHint="Sets the clock to this time"
      onPress={onPress}
      {...axPress(onPress)}
      hitSlop={6}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      {cell}
    </Pressable>
  );
}

/** A planned stop: glass with the place's photo, its times, and whether it is booked. */
function StopCard({ stop, place, onPress }: { stop: Stop; place?: Place; onPress?: () => void }) {
  const sub = [stopSpan(stop), stop.fixed ? 'Booked' : 'Planned', place && place.name !== stop.title ? place.name : undefined].filter(Boolean).join(' · ');
  return (
    <Pressable
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={`${stop.title}. ${sub}`}
      accessibilityHint={onPress ? 'Opens the place' : undefined}
      onPress={onPress}
      {...axPress(onPress)}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Glass kind="clear" radius={20} style={[styles.stopCard, styles.softShadow]}>
        {place ? <PlacePhoto place={place} style={styles.stopThumb} /> : <View style={[styles.stopThumb, styles.stopThumbEmpty]} />}
        <View style={styles.stopText}>
          <Text style={[onGlass, font('700'), { fontSize: 14, lineHeight: 18 }]} numberOfLines={2}>
            {stop.title}
          </Text>
          <Text style={[styles.stopSub, font('600')]} numberOfLines={1}>
            {sub}
          </Text>
        </View>
      </Glass>
    </Pressable>
  );
}

function SuggestionCard({ rec, width, height, reasonLines, glass, onPress }: { rec: Recommendation; width: number; height: number; reasonLines: number; glass: boolean; onPress: () => void }) {
  const place = rec.candidate.place;
  const walk = `${rec.candidate.walkMinutes} min walk`;
  // The walk has its own pill; a reason written by code starts with it too.
  const reason = rec.fromModel ? rec.reason : reasonWithoutWalk(rec.reason);
  // How many lines the reason takes: estimated at first, then as laid out.
  const [lines, setLines] = useState(() => estimateLines(reason, width - 2 * REASON_X, reasonLines));
  const shownLines = Math.min(lines, reasonLines);
  // The name, whole, gets the card's width and the height under the reason, sized to fit one line.
  const room = height - (reason ? REASON_TOP + shownLines * REASON_LINE : REASON_TOP - 6) - NAME_GAP;
  const nameSize = glassWordSize(place.name, Math.max(80, width - 2 * NAME_INSET), Math.min(NAME_MAX, nameSizeForRoom(place.name, room)));
  const fallback = <GlassText place={place} size={nameSize} left={NAME_INSET} />;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${place.name}, ${walk}.${reason ? ` ${reason}` : ''}`}
      accessibilityHint="Opens the place"
      onPress={onPress}
      {...axPress(onPress)}
      style={({ pressed }) => [
        styles.cardShadow,
        {
          opacity: pressed ? 0.9 : 1,
          transform: [{ scale: pressed ? 0.99 : 1 }],
        },
      ]}
    >
      <View style={[styles.card, { height }]}>
        <PlacePhoto place={place} style={StyleSheet.absoluteFill} />
        <PhotoFade stops={CARD_FADE} />
        {/* The photo again with the name in 3D liquid glass, whole, just above the card's edge. */}
        {glass ? (
          <LiquidGlass
            photo={placePhotoSource(place.id)}
            lines={[
              {
                text: place.name,
                size: nameSize,
                baseline: nameBaseline(place.name, nameSize),
              },
            ]}
            align="left"
            inset={NAME_INSET}
            fade={CARD_FADE}
            fallback={fallback}
          />
        ) : (
          fallback
        )}
        <View pointerEvents="none" style={styles.cardRim} />
        <Glass kind="clear" radius={999} style={styles.walkPill}>
          <Text style={[onGlass, font('700'), { fontSize: 11.5 }]}>{walk}</Text>
        </Glass>
        {reason ? (
          <Text
            style={[styles.reason, font('600')]}
            numberOfLines={reasonLines}
            onTextLayout={e => {
              const n = Math.max(1, e.nativeEvent.lines.length);
              if (n !== lines) setLines(n);
            }}
          >
            {reason}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * Lines a reason will take at 13 px SF Pro Semibold in `width` px, until it has been laid out:
 * about 0.55 em a character, and a few characters a line lost to word wrapping.
 */
function estimateLines(text: string | undefined, width: number, max: number): number {
  if (!text) return 0;
  const perLine = Math.max(8, Math.floor(width / (13 * 0.55)) - 4);
  return Math.min(max, Math.max(1, Math.ceil(text.length / perLine)));
}

/** Cards fade and slide in when they appear (a re-plan, another day); snaps with reduce-motion. */
function FadeIn({ children }: { children: React.ReactNode }) {
  const reduce = useReduceMotion();
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) {
      a.setValue(1);
      return;
    }
    const run = Animated.timing(a, {
      toValue: 1,
      duration: dusk.motion.replan,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    run.start();
    return () => run.stop();
  }, [a, reduce]);
  return (
    <Animated.View
      style={{
        opacity: a,
        transform: [
          {
            translateY: a.interpolate({
              inputRange: [0, 1],
              outputRange: [10, 0],
            }),
          },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}

const shadowText = (radius: number, alpha: number): TextStyle => ({
  textShadowColor: ground(alpha),
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: radius,
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: dusk.color.ground },
  hero: { position: 'absolute', left: 0, right: 0, top: 0, overflow: 'hidden' },
  top: { paddingTop: TOP },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, minHeight: 28 },
  city: { flexShrink: 1, fontSize: 22, letterSpacing: -0.44, color: dusk.color.text, ...shadowText(4, 0.45) },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  thinking: { fontSize: 11, color: dusk.color.text2, ...shadowText(3, 0.6) },
  clockRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 14, marginTop: 8 },
  clock: { fontSize: CLOCK_SIZE, lineHeight: Math.round(CLOCK_SIZE * 1.05), letterSpacing: dusk.font.clock.letterSpacing * 0.8, color: dusk.color.text, ...shadowText(5, 0.4) },
  weather: { flex: 1, fontSize: 13.5, lineHeight: 18, paddingBottom: 7, color: dusk.color.text, ...shadowText(4, 0.55) },
  models: { fontSize: 11, lineHeight: 15, marginTop: 2, color: dusk.color.textSoft, ...shadowText(3, 0.65) },
  // The strip clips what it holds, so it reaches STRIP_SHADOW px further down (and gives them back
  // below) to keep the chips' shadows whole.
  strip: { flexGrow: 0, marginTop: 6, marginBottom: -STRIP_SHADOW },
  stripContent: { gap: 6, alignItems: 'center', paddingTop: 2, paddingBottom: 2 + STRIP_SHADOW },
  dayTouch: { minHeight: dusk.size.touch, justifyContent: 'center' },
  dayChip: { height: 38, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, shadowOpacity: 0.22, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } },
  /** Lighter than Glass's own shadow: over the ambient photo a heavy one reads as a dark smear. */
  softShadow: { shadowOpacity: 0.2, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
  dayMonth: { fontSize: 10.5, letterSpacing: 0.9, color: white(0.82) },
  todayDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: dusk.color.white, shadowColor: dusk.color.white, shadowOpacity: 0.8, shadowRadius: 4 },
  timeline: { flex: 1 },
  edgeShade: { position: 'absolute', left: 0, right: 0, top: -EDGE_ABOVE, height: EDGE_ABOVE + EDGE_BELOW },
  rail: { position: 'absolute', left: RAIL_X, top: 0, bottom: 14, width: 1, backgroundColor: white(0.16) },
  row: { flexDirection: 'row', marginBottom: 14, minHeight: 36 },
  pastRow: { opacity: 0.5 },
  nowLine: { position: 'absolute', left: RAIL_X, right: 0, top: 8, height: 1.5, backgroundColor: white(0.85) },
  rowBody: { flex: 1, gap: 8 },
  nowBody: { paddingTop: 22 },
  timeCell: { width: TIME_W, paddingRight: TIME_W - RAIL_X + 6, minHeight: 36 },
  // Over the ambient photo: tight text shadows (a wide one is clipped into a visible box on macOS).
  time: { fontSize: 13, lineHeight: 18, color: dusk.color.text, fontVariant: ['tabular-nums'], ...shadowText(3, 0.55) },
  nowLabel: { fontSize: 12, lineHeight: 16, color: dusk.color.white, ...shadowText(3, 0.55) },
  nowTime: { fontSize: 12, lineHeight: 16, color: white(0.85), fontVariant: ['tabular-nums'], ...shadowText(3, 0.55) },
  timeWeather: { fontSize: 11, lineHeight: 14, color: dusk.color.text2, ...shadowText(3, 0.6) },
  dot: { position: 'absolute', left: RAIL_X - 3.5, top: 5.5, width: 7, height: 7, borderRadius: 3.5, backgroundColor: white(0.55) },
  nowDot: { left: RAIL_X - 5, top: 4, width: 10, height: 10, borderRadius: 5, backgroundColor: dusk.color.white, shadowColor: dusk.color.white, shadowOpacity: 0.9, shadowRadius: 6 },
  stopCard: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 8, paddingRight: 12 },
  stopThumb: { width: 46, height: 46, borderRadius: 13 },
  stopThumbEmpty: { backgroundColor: white(0.08) },
  stopText: { flex: 1, gap: 2 },
  stopSub: { fontSize: 11.5, lineHeight: 15, color: dusk.color.textSoft },
  cardShadow: { borderRadius: dusk.radius.card - 4, backgroundColor: dusk.color.raised, shadowColor: dusk.color.ground, shadowOpacity: 0.4, shadowRadius: 10, shadowOffset: { width: 0, height: 5 } },
  card: { borderRadius: dusk.radius.card - 4, overflow: 'hidden', backgroundColor: dusk.color.raised },
  cardRim: { position: 'absolute', left: 16, right: 16, top: 0, height: 1, backgroundColor: white(0.35) },
  walkPill: { position: 'absolute', left: 10, top: 10, height: 26, paddingHorizontal: 11, justifyContent: 'center' },
  reason: { position: 'absolute', left: REASON_X, right: REASON_X, top: REASON_TOP, fontSize: 13, lineHeight: REASON_LINE, color: dusk.color.white, ...shadowText(4, 0.8) },
  nothing: { fontSize: 12.5, lineHeight: 17, color: dusk.color.text2, paddingTop: 1, ...shadowText(3, 0.6) },
  empty: { padding: 22, gap: 6 },
  emptyHint: { fontSize: 14, lineHeight: 19, color: dusk.color.textSoft },
});
