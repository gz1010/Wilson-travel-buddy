import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, PanResponder, Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
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
import { HomeLink } from '../dusk/Nav';
import { CloseIcon } from '../dusk/Icons';
import { dusk, font, ground, white } from '../dusk/tokens';
import type { Buddy, ChatLine } from '../useBuddy';
import type { ScreenProps } from './types';
import { isDeclined, levelFor, UNSURE_LINE, useLevel, useMood, useWilsonMotion, WilsonFace, type WilsonLevel, type WilsonMood, type WilsonMotion } from './WilsonLive';

// AntNow, by days: a compact header (the city photo for the time of day, the clock, the weather,
// the Offline chip and the on-device models), a strip of the trip's days, and the picked day as a
// timeline: times on the left, that day's planned stops and suggestions on the right, and on
// today a "now" line with the suggestions for right now. DuskRoot draws the tab bar.
//
// Wilson rides the "now" line (48 px, in the time column under the clock): tap him to talk (what
// he hears and answers shows in a bubble on the line), tap another time or drag him to it and he
// glides there in 240 ms while the day re-plans around him. The times before "now" stay, dimmed,
// so a time keeps its place when he moves to it. The floating Wilson is hidden here (DuskRoot).

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
/** Wilson on the timeline, and where his top sits in the "now" row: under "Now", the time and its weather lines. */
const WILSON = 48;
const NOW_HEAD = 16 + 16 + 8;
const WEATHER_LINE = 14;
const wilsonTopIn = (weatherLines: number) => NOW_HEAD + weatherLines * WEATHER_LINE;
/** Once per app session: the hint on the line ("tap me…") goes after the first time he is tapped or moved. */
let introduced = false;
/** A move's re-plan is laid out within this many ms; later layouts are the clock set elsewhere. */
const MOVE_SETTLE = 800;
// macOS-only View prop the iOS typings lack: dragging Wilson must never drag the window.
const NO_WINDOW_DRAG = { mouseDownCanMoveWindow: false } as object;

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
          {/* The city's name leads back home, to the cities Wilson knows (HomeLink, W1). */}
          <HomeLink nav={nav} city={dest.name}>
            <Text style={[styles.city, font('700')]} numberOfLines={1} accessibilityRole="header">
              {dest.name}
              {dayNo !== undefined && trip ? <Text style={[font('500'), { fontSize: 15 }]}>{` · day ${dayNo} of ${trip.days}`}</Text> : null}
            </Text>
          </HomeLink>
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

      <DayTimeline key={day.date} b={b} onOpen={nav.openPlace} onChat={() => nav.go('setup')} day={day} sx={sx} width={width} />
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

/**
 * The day's rows; on today also the free times before "now", dimmed as past. Wilson moves along
 * the day, so a time must keep its place when he moves to it or away from it (dayTimeline alone
 * drops the free times before "now", which pulled the whole day up under him).
 */
function dayRows(stops: readonly Stop[], now: number | undefined): TimelineRow[] {
  const rows = dayTimeline(stops, { now });
  if (now === undefined) return rows;
  const have = new Set(rows.map(r => r.key));
  const earlier = dayTimeline(stops)
    .filter(r => r.open && r.minute !== undefined && r.minute < now && !have.has(r.key))
    .map(r => ({ ...r, past: true }));
  if (!earlier.length) return rows;
  const out: TimelineRow[] = [];
  let i = 0;
  for (const row of rows) {
    while (i < earlier.length && row.minute !== undefined && earlier[i].minute! < row.minute) out.push(earlier[i++]);
    out.push(row);
  }
  return [...out, ...earlier.slice(i)];
}

function DayTimeline({ b, onOpen, onChat, day, sx, width }: { b: Buddy; onOpen: (placeId: string) => void; onChat: () => void; day: PlanDay; sx: number; width: number }) {
  const { clock, location, visited } = b.situation;
  const trip = b.trip;
  const today = day.date === clock.date;
  const reduce = useReduceMotion();
  const stops = useMemo(() => (trip ? stopsOn(trip, day.date) : []), [trip, day.date]);
  const rows = useMemo(() => dayRows(stops, today ? clock.minute : undefined), [stops, today, clock.minute]);

  // Right now: the live suggestions (the model's picks once it has thought), less any place already
  // in this day's plan (the recommender skips only booked stops; "+ Add" on one would add it twice).
  const nowRecs = useMemo(() => {
    if (!today) return [];
    const planned = new Set(stops.flatMap(s => (s.placeId ? [s.placeId] : [])));
    return b.recs.filter(r => !planned.has(r.placeId)).slice(0, NOW_CARDS);
  }, [today, b.recs, stops]);

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
    // The times still to come choose first; the times already past (dimmed) take what is left.
    const order = rows.map((_, i) => i).sort((a, c) => Number(rows[a].past) - Number(rows[c].past) || a - c);
    const chosen = pickDistinct(
      order.map(i => lists[i]),
      taken,
      1,
    );
    const byRow: (typeof chosen)[number][] = [];
    order.forEach((i, k) => (byRow[i] = chosen[k]));
    return byRow.map(list =>
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
  /** The scroll offset as it is (view.y is rounded). */
  const scrollTop = useRef(0);
  /** When Wilson last moved along the day (a tapped time, a drop): the view holds and he glides. */
  const movedAt = useRef(0);
  const onRowLayout = (row: TimelineRow) => (e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout;
    setBoxes(prev => (prev[row.key]?.y === y && prev[row.key]?.h === height ? prev : { ...prev, [row.key]: { y, h: height } }));
    // On today, open at "now" (stops earlier in the day stay above it), and follow it when the
    // clock is set elsewhere. The glass names follow too, in case the scroll sends no event.
    if (row.now && scrolledTo.current !== clock.minute) {
      scrolledTo.current = clock.minute;
      const to = Math.max(0, y - 8);
      if (Date.now() - movedAt.current < MOVE_SETTLE) {
        // Wilson moved along the day: the view stays, unless his new time is out of it.
        movedAt.current = 0;
        if (view.h > 0 && (y < scrollTop.current || y + NOW_HEAD + WILSON > scrollTop.current + view.h)) scroll.current?.scrollTo({ y: to, animated: !reduce });
        return;
      }
      scroll.current?.scrollTo({ y: to, animated: false });
      scrollTop.current = to;
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
    scrollTop.current = e.nativeEvent.contentOffset.y;
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
  /** The weather beside a time: once per time (a stop and "now" can share one). */
  const weatherFor = (i: number) => {
    const minute = rows[i].minute;
    return minute !== undefined && rows[i - 1]?.minute !== minute ? weatherAt(b, day.date, minute) : [];
  };

  // --- Wilson on the line.
  const level = useLevel(b);
  // He thinks while the day re-plans around him, too.
  const mood = useMood(b, { replan: true });
  const hasMic = b.runtime.audio.info.hasMicrophone;
  /** The bubble shows exchanges from here on: none from before Now opened, and a tap starts afresh. */
  const [from, setFrom] = useState(() => b.chat.length);
  const [intro, setIntro] = useState(!introduced);
  const introduce = () => {
    introduced = true;
    setIntro(false);
  };
  /** Moves Wilson (and the clock) to a time of this day; the day re-plans around him. */
  const moveTo = (minute: number) => {
    introduce();
    if (today && minute === clock.minute) return;
    movedAt.current = Date.now();
    b.setClock({ date: day.date, minute });
  };
  /** Tap: talk; while he listens, send; while he thinks or speaks, stop him (no barge-in). Without a microphone, Chat. */
  const tapWilson = () => {
    introduce();
    if (b.listening) b.talk();
    else if (b.speaking || b.busy) b.stopSpeaking();
    else if (hasMic) {
      setFrom(b.chat.length);
      b.talk();
    } else onChat();
  };
  const wilsonLabel = b.listening ? 'Wilson is listening. Tap to send' : b.speaking || b.busy ? 'Wilson. Tap to stop him' : hasMic ? 'Wilson. Tap to talk' : 'Wilson. Tap to write to him in Chat';
  const nowIndex = today ? rows.findIndex(r => r.now) : -1;
  const nowBox = nowIndex >= 0 ? boxes[rows[nowIndex].key] : undefined;
  // The times he can be dragged to, top to bottom, and the one his centre is over.
  const timed = rows.filter(r => r.minute !== undefined && boxes[r.key]);
  const rowAt = (top: number) => {
    let hit = timed[0];
    for (const r of timed) if (boxes[r.key].y <= top + WILSON / 2) hit = r;
    return hit;
  };
  const firstBox = timed.length ? boxes[timed[0].key] : undefined;
  const lastBox = timed.length ? boxes[timed[timed.length - 1].key] : undefined;
  const rider =
    nowBox && firstBox && lastBox ? (
      <WilsonRider
        y={nowBox.y + wilsonTopIn(weatherFor(nowIndex).length)}
        minY={firstBox.y}
        maxY={lastBox.y + Math.max(NOW_HEAD, lastBox.h - WILSON)}
        mood={mood}
        level={level}
        reduce={reduce}
        label={wilsonLabel}
        onTap={tapWilson}
        timeAt={top => {
          const r = rowAt(top);
          return r && (r.now ? `Now · ${r.label}` : r.label);
        }}
        onDrop={top => {
          const r = rowAt(top);
          if (!r || r.now || r.minute === undefined) return false;
          moveTo(r.minute);
          return true;
        }}
        onStep={dir => {
          const at = timed.findIndex(t => t.now);
          const r = at >= 0 ? timed[at + dir] : undefined;
          if (r && r.minute !== undefined) moveTo(r.minute);
        }}
      />
    ) : null;

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
        {/* Another day: Wilson stays on today's line, and says how to bring him here. */}
        {!today ? (
          <>
            <Pressable accessibilityRole="button" accessibilityLabel={`${wilsonLabel}. Tap a time to move him to ${day.spoken}`} onPress={tapWilson} {...axPress(tapWilson)} style={({ pressed }) => [styles.away, { opacity: pressed ? 0.85 : 1 }]}>
              <WilsonFace size={32} mood={mood} level={levelFor(mood, level)} decorative />
              <Text style={[styles.awayText, font('600')]} numberOfLines={2}>{`Tap a time and I'll move to ${day.spoken}.`}</Text>
            </Pressable>
            {/* Talked to here (a tap, or "Wilson, …"): what he hears and answers shows under him, as on today's line. */}
            <WilsonSays b={b} from={from} intro={false} onChat={onChat} onClose={() => setFrom(b.chat.length)} style={styles.awaySays} />
          </>
        ) : null}
        {empty ? (
          <Glass kind="clear" style={styles.empty}>
            <Text style={[onGlass, font('700'), { fontSize: 15 }]}>Nothing planned or open on {day.label}</Text>
            <Text style={[styles.emptyHint, font('500')]}>Tell Wilson in Chat what you would like to do that day.</Text>
          </Glass>
        ) : (
          <View>
            <View pointerEvents="none" style={styles.rail} />
            {rows.map((row, i) => {
              const recs = recsFor(row, i);
              const minute = row.minute;
              const setClock = minute !== undefined && !row.now ? () => moveTo(minute) : undefined;
              return (
                <View key={row.key} testID={`row-${row.key}`} onLayout={onRowLayout(row)} style={[styles.row, row.past && styles.pastRow]}>
                  {row.now ? <View pointerEvents="none" style={styles.nowLine} /> : null}
                  <TimeCell row={row} weather={weatherFor(i)} day={day} onPress={setClock} />
                  <View style={[styles.rowBody, row.now && styles.nowBody]}>
                    {row.now ? <WilsonSays b={b} from={from} intro={intro} onChat={onChat} onClose={() => setFrom(b.chat.length)} /> : null}
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
                      <Text style={[styles.nothing, font('500')]}>{row.now ? 'Nothing fits right now. Ask Wilson what you feel like, or move him to a later time.' : 'Nothing open nearby then.'}</Text>
                    ) : null}
                  </View>
                </View>
              );
            })}
            {rider}
          </View>
        )}
      </ScrollView>
      <EdgeShade shown={under} />
    </View>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * His liquid-glass feel while he is dragged along the day, as the floating Wilson does it (after
 * liquid-glass-studio): picked up he lifts and his rim lights; moving he stretches along the way he
 * goes, more the faster; let go he wobbles back round. All native-driven. Reduce motion: no
 * stretching or lifting, only the light.
 */
function dragGlass(m: WilsonMotion | undefined) {
  const k = { y: 0, t: 0, vy: 0 };
  let relax: ReturnType<typeof setTimeout> | undefined;
  const spring = (v: Animated.Value, toValue: number, stiffness: number, damping: number) => Animated.spring(v, { toValue, stiffness, damping, mass: 1, useNativeDriver: true }).start();
  return {
    pickUp(reduce: boolean) {
      if (!m) return;
      k.t = 0;
      k.vy = 0;
      if (!reduce) spring(m.lift, 1, 320, 18);
      Animated.timing(m.moving, { toValue: 0.4, duration: 140, useNativeDriver: true }).start();
    },
    track(y: number, reduce: boolean) {
      if (!m) return;
      const now = Date.now();
      if (k.t) k.vy += ((y - k.y) / clamp(now - k.t, 4, 64) - k.vy) * 0.35; // smoothed px/ms
      k.y = y;
      k.t = now;
      const speed = Math.abs(k.vy);
      if (!reduce) {
        if (speed > 0.04) m.angle.setValue(k.vy > 0 ? Math.PI / 2 : -Math.PI / 2);
        m.stretch.setValue(Math.min(0.26, speed * 0.15));
      }
      m.moving.setValue(Math.min(1, 0.4 + speed * 0.5));
      // A pause mid-drag: round again (still held).
      if (relax) clearTimeout(relax);
      relax = setTimeout(() => {
        k.vy = 0;
        spring(m.stretch, 0, 300, 14);
        Animated.timing(m.moving, { toValue: 0.4, duration: 180, useNativeDriver: true }).start();
      }, 70);
    },
    release(reduce: boolean) {
      if (!m) return;
      if (relax) clearTimeout(relax);
      k.t = 0;
      k.vy = 0;
      if (reduce) {
        m.stretch.setValue(0);
        m.lift.setValue(0);
      } else {
        spring(m.stretch, 0, 300, 8);
        spring(m.lift, 0, 260, 14);
      }
      Animated.timing(m.moving, { toValue: 0, duration: 340, useNativeDriver: true }).start();
    },
  };
}

interface RiderProps {
  /** Where his top belongs: the "now" row's Wilson slot, in the timeline's coordinates. */
  y: number;
  /** How far he can be dragged. */
  minY: number;
  maxY: number;
  mood: WilsonMood;
  level: WilsonLevel;
  reduce: boolean;
  label: string;
  onTap: () => void;
  /** The time under him at this top, for the pill shown while he is dragged. */
  timeAt: (top: number) => string | undefined;
  /** Dropped here: true when that moves the clock (he then glides to his new place once the day re-plans). */
  onDrop: (top: number) => boolean;
  /** VoiceOver's increment and decrement: the next or the previous time. */
  onStep: (dir: 1 | -1) => void;
}

/**
 * Wilson on the timeline. He glides (240 ms) to wherever "now" is laid out; drag him up or down
 * the day and let go on a time to move "now" there. `top` is a layout prop, not a transform:
 * AppKit owns a view's layer transform and can reset it, but keeps the frame (as in dusk/Buddy.tsx).
 * Reduce motion: no gliding, he is just there.
 */
function WilsonRider({ y, minY, maxY, mood, level, reduce, label, onTap, timeAt, onDrop, onStep }: RiderProps) {
  const top = useRef(new Animated.Value(y)).current;
  /** Where he is, or is heading. */
  const at = useRef(y);
  const mountedAt = useRef(Date.now());
  const dragging = useRef(false);
  const [dragTime, setDragTime] = useState<string>();
  const landing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const live = useRef({ y, minY, maxY, reduce, onTap, timeAt, onDrop });
  live.current = { y, minY, maxY, reduce, onTap, timeAt, onDrop };
  const fx = useWilsonMotion();
  const glass = useMemo(() => dragGlass(fx), [fx]);

  const glide = useCallback(
    (to: number) => {
      if (landing.current !== undefined) clearTimeout(landing.current);
      landing.current = undefined;
      top.stopAnimation();
      at.current = to;
      // Not while the first layouts settle (the rows above him are still being measured).
      if (live.current.reduce || Date.now() - mountedAt.current < 600) top.setValue(to);
      else Animated.timing(top, { toValue: to, duration: dusk.motion.replan, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
    },
    [top],
  );
  useEffect(() => {
    if (!dragging.current && at.current !== y) glide(y);
  }, [y, glide]);
  useEffect(
    () => () => {
      if (landing.current !== undefined) clearTimeout(landing.current);
    },
    [],
  );

  // A press that moves less than a few points is a tap.
  const pan = useMemo(() => {
    const start = { v: 0 };
    let moved = false;
    const finish = (to: number) => {
      dragging.current = false;
      setDragTime(undefined);
      glass.release(live.current.reduce);
      const { minY: lo, maxY: hi } = live.current;
      const dropped = clamp(to, lo, hi);
      top.setValue(dropped);
      at.current = dropped;
      if (live.current.onDrop(dropped)) {
        // The day re-plans: the new "now" moves his y and he glides there; if it lands where it was, go anyway.
        landing.current = setTimeout(() => glide(live.current.y), 400);
      } else glide(live.current.y);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        moved = false;
        top.stopAnimation(v => {
          start.v = v;
        });
      },
      onPanResponderMove: (_e, g) => {
        if (!moved) {
          if (Math.abs(g.dx) + Math.abs(g.dy) < 5) return;
          moved = true;
          dragging.current = true;
          glass.pickUp(live.current.reduce);
        }
        const { minY: lo, maxY: hi, timeAt: time } = live.current;
        const v = clamp(start.v + g.dy, lo, hi);
        top.setValue(v);
        glass.track(v, live.current.reduce);
        const t = time(v);
        setDragTime(prev => (prev === t ? prev : t));
      },
      onPanResponderRelease: (_e, g) => {
        if (moved) return finish(start.v + g.dy);
        // A tap; if it caught him mid-glide, let him finish the trip.
        if (Math.abs(start.v - live.current.y) > 0.5) glide(live.current.y);
        live.current.onTap();
      },
      onPanResponderTerminate: (_e, g) => {
        if (moved) finish(start.v + g.dy);
        else glide(live.current.y); // the press stopped a glide: finish it
      },
    });
  }, [top, glide, glass]);

  return (
    <>
      {dragTime ? (
        <Animated.View pointerEvents="none" style={[styles.dragTime, { top }]}>
          <Glass kind="prominent" radius={999} style={styles.dragPill}>
            <Text style={[onGlass, font('700'), { fontSize: 12.5, fontVariant: ['tabular-nums'] }]} numberOfLines={1}>
              {dragTime}
            </Text>
          </Glass>
        </Animated.View>
      ) : null}
      <Animated.View
        {...pan.panHandlers}
        {...NO_WINDOW_DRAG}
        accessible
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint="Drag him to another time, or tap a time, and the day re-plans around him"
        accessibilityActions={[
          { name: 'increment', label: 'Move to the next time' },
          { name: 'decrement', label: 'Move to the time before' },
        ]}
        onAccessibilityAction={e => {
          const name = e.nativeEvent.actionName;
          if (name === 'increment') onStep(1);
          else if (name === 'decrement') onStep(-1);
        }}
        {...axPress(onTap)}
        style={[styles.rider, { top, cursor: 'pointer' }]}>
        <WilsonFace size={WILSON} mood={mood} level={levelFor(mood, level)} decorative lifted={dragTime !== undefined} motion={fx} />
      </Animated.View>
    </>
  );
}

const lastExchange = (lines: ChatLine[]): { question: ChatLine; answer?: ChatLine } | undefined => {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].who === 'you') return { question: lines[i], answer: lines[i + 1]?.who === 'buddy' ? lines[i + 1] : undefined };
  }
  return undefined;
};

/**
 * What Wilson says on the "now" line: what he hears while he listens, then the question and his
 * answer (with "Wilson · from your <city> guide" when the guide's facts are behind it). Before
 * anyone has talked to him here, a one-line hint. Tapping an answer opens Chat with the whole
 * conversation; the small close button puts it away.
 */
function WilsonSays({ b, from, intro, onChat, onClose, style }: { b: Buddy; from: number; intro: boolean; onChat: () => void; onClose: () => void; style?: StyleProp<ViewStyle> }) {
  const city = b.index.destination.name;
  // After his spoken answer he waits a few seconds for a follow-up (useBuddy's followUp): until the
  // person starts talking, his answer stays on the line (as on the home and the floating Wilson).
  const quiet = b.listening && (b as unknown as { followUp?: unknown }).followUp === true && !b.partial;
  const ex = b.listening && !quiet ? undefined : lastExchange(b.chat.slice(from));
  let label = 'Wilson';
  let text: string;
  let heard: string | undefined;
  let pending = false;
  if (b.listening && !(quiet && ex)) {
    label = 'Wilson · listening';
    text = b.partial ? `“${b.partial}”` : 'Listening…';
    pending = !b.partial;
  } else if (ex) {
    const a = ex.answer;
    heard = ex.question.text;
    if (a && !a.pending && (a.cited?.facts?.length ?? 0) > 0) label = `Wilson · from your ${city} guide`;
    if (!a || (a.pending && !a.text)) {
      text = b.status ?? 'Thinking…';
      pending = true;
    } else text = !a.pending && isDeclined(a.text) ? UNSURE_LINE : a.text;
  } else if (intro) {
    text = b.runtime.audio.info.hasMicrophone ? "Tap me to talk, or tap another time and I'll move there." : "Tap me to chat, or tap another time and I'll move there.";
  } else return null;

  const body = (
    <Glass kind="clear" radius={20} style={[styles.says, styles.softShadow, style]}>
      <View style={styles.saysHead}>
        <Text style={[styles.saysLabel, font('700')]} numberOfLines={1}>
          {label}
        </Text>
        {ex ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} {...axPress(onClose)} hitSlop={10} style={({ pressed }) => [styles.saysClose, { opacity: pressed ? 0.7 : 1 }]}>
            <CloseIcon size={9} strokeWidth={2.6} />
          </Pressable>
        ) : null}
      </View>
      {heard ? (
        <Text style={[styles.saysHeard, font('500')]} numberOfLines={1}>
          {`“${heard}”`}
        </Text>
      ) : null}
      <Text style={[styles.saysText, font('500'), pending && { color: dusk.color.pending }]} numberOfLines={4} accessibilityLiveRegion="polite">
        {text}
      </Text>
    </Glass>
  );
  if (!ex) return body;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${text}`} accessibilityHint="Opens the conversation in Chat" onPress={onChat} {...axPress(onChat)} style={({ pressed }) => ({ opacity: pressed ? 0.9 : 1 })}>
      {body}
    </Pressable>
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
      {/* Room for Wilson, who rides over it (WilsonRider): his top is wilsonTopIn(weather.length). */}
      {row.now ? <View style={styles.wilsonSlot} /> : null}
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
  // Wilson on the line: his slot under the time (top = wilsonTopIn), the rider, and the time shown while he is dragged.
  wilsonSlot: { marginTop: NOW_HEAD - 32, height: WILSON },
  rider: { position: 'absolute', left: 0, width: WILSON, height: WILSON },
  dragTime: { position: 'absolute', left: RAIL_X + 12, height: WILSON, justifyContent: 'center' },
  dragPill: { height: 28, paddingHorizontal: 12, justifyContent: 'center' },
  says: { paddingTop: 9, paddingBottom: 11, paddingHorizontal: 14, gap: 3 },
  saysHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 18 },
  saysLabel: { flex: 1, fontSize: 11.5, lineHeight: 15, color: dusk.color.text2 },
  saysClose: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: white(0.14) },
  saysHeard: { fontSize: 12.5, lineHeight: 17, color: dusk.color.text2 },
  saysText: { fontSize: 14.5, lineHeight: 20, color: dusk.color.text },
  away: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 4, paddingRight: 8, marginBottom: 14, minHeight: dusk.size.touch },
  awayText: { flex: 1, fontSize: 13, lineHeight: 17, color: dusk.color.text2, ...shadowText(3, 0.6) },
  awaySays: { marginLeft: TIME_W, marginBottom: 14 },
  empty: { padding: 22, gap: 6 },
  emptyHint: { fontSize: 14, lineHeight: 19, color: dusk.color.textSoft },
});
