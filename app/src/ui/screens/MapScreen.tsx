import React, { useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Place } from '../../core/types';
import { MapView, type MapPin } from '../../map/MapView';
import { directions, HERE_METERS } from '../dusk/format';
import { axPress, Glass, GlassButton, OfflineChip, onGlass } from '../dusk/Glass';
import { ArrowIcon, SearchIcon } from '../dusk/Icons';
import { PhotoFade, PlacePhoto } from '../dusk/Photos';
import { dusk, font, white } from '../dusk/tokens';
import type { ScreenProps } from './types';
import { useScreenSize } from '../dusk/Screen';

// AntMap: the offline map full screen, a glass search bar on top, and a glass card for the
// chosen place (or the first suggestion) above the tab bar, which DuskRoot draws.
//
// A Mac has no GPS and can't locate itself with Wi-Fi off, so the traveller sets where they are:
// the "You:" chip under the search bar says where the buddy thinks you are; tapping the map moves
// you there, and "I'm here" (on a search match, on the bottom card) or "At my hotel" puts you at a
// place.

const DESIGN_WIDTH = dusk.layout.phoneWidth;
const TOP = 56;
const SEARCH_HEIGHT = 46;
const MATCH_HEIGHT = 44;
const CHIP_HEIGHT = 28;
const CARD_BOTTOM = 104;
const HEADER_HEIGHT = 92;
const NAME_SIZE = 44;
/** Below this window height (390×700 is the minimum) the card's reason gets two lines, not three. */
const SHORT_WINDOW = 760;
/** Typing this many letters starts matching the search text to a place. */
const MIN_MATCH = 3;

export function MapScreen({ b, nav }: ScreenProps) {
  const { width, height } = useScreenSize();
  const sx = (x: number) => Math.round((x * width) / DESIGN_WIDTH);
  const [query, setQuery] = useState('');
  const [missed, setMissed] = useState<string>();
  const input = useRef<TextInput>(null);

  // Pins as the classic Home screen builds them: ranked suggestions, then trip stops, then places.
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

  // While typing: the place the search text names, if any. It offers Focus and I'm here.
  const typed = query.trim();
  const match = useMemo(() => (typed.length >= MIN_MATCH ? b.index.findPlace(typed) : undefined), [b.index, typed]);

  // The card shows the focused place, else the first suggestion, else nothing.
  const place: Place | undefined = (b.focusId ? b.index.place(b.focusId) : undefined) ?? (b.recs[0] ? b.index.place(b.recs[0].placeId) : undefined);
  const rec = place ? b.recs.find(r => r.placeId === place.id) : undefined;
  const inDay = !!place && !!b.trip?.stops.some(s => s.placeId === place.id);
  const atPlace = !!place && b.metersTo(place.point) < HERE_METERS;

  // Where the traveller is staying, when the trip names a place the guide knows.
  const base = b.trip?.base;
  const basePoint = base?.point;

  const focus = (p: Place) => {
    b.setFocusId(p.id);
    setMissed(undefined);
  };

  /** Moves "you" to a place and keeps it on the card, so the map flies there and the card reads Here. */
  const imHere = (p: Place) => {
    b.setLocation(p.point, p.name);
    b.setFocusId(p.id);
  };

  const hereFromSearch = (p: Place) => {
    imHere(p);
    setQuery('');
    setMissed(undefined);
    input.current?.blur();
  };

  const atHotel = () => {
    if (!base || !basePoint) return;
    b.setLocation(basePoint, base.name);
    if (base.placeId && b.index.place(base.placeId)) b.setFocusId(base.placeId);
  };

  const submit = () => {
    if (!typed) return;
    const found = match ?? b.index.findPlace(typed);
    if (found) focus(found);
    else setMissed(typed);
  };

  return (
    <View style={styles.root}>
      <View style={StyleSheet.absoluteFill}>
        <MapView
          theme="dusk"
          bounds={b.index.destination.bounds}
          pins={pins}
          you={b.situation.location}
          focusId={b.focusId}
          onPress={p => b.setLocation(p)}
          onSelect={id => b.setFocusId(id)}
        />
      </View>

      {/* Search, top. */}
      <View pointerEvents="box-none" style={[styles.top, { left: sx(14), right: sx(14) }]}>
        <Glass kind="clear" radius={dusk.radius.pill} style={styles.search}>
          <SearchIcon size={16} color={dusk.color.text} />
          <TextInput
            ref={input}
            value={query}
            onChangeText={t => {
              setQuery(t);
              if (missed) setMissed(undefined);
            }}
            onSubmitEditing={submit}
            placeholder="Where are you, or where to?"
            placeholderTextColor={dusk.color.text2}
            returnKeyType="search"
            autoCorrect={false}
            clearButtonMode="while-editing"
            keyboardAppearance="dark"
            accessibilityLabel="Search places"
            selectionColor={dusk.color.white}
            style={[font('600'), styles.input]}
          />
        </Glass>

        {/* The search text names a place: look at it, or say you're there. */}
        {match ? (
          <Glass kind="clear" radius={dusk.radius.pill} style={styles.match}>
            <Text numberOfLines={1} style={[onGlass, font('700'), styles.matchName]}>
              {match.name}
            </Text>
            <GlassButton
              label="Focus"
              kind="clear"
              height={32}
              onPress={() => focus(match)}
              textStyle={[font('700'), styles.smallButtonText]}
              accessibilityLabel={`Show ${match.name} on the map`}
            />
            <GlassButton
              label="I'm here"
              kind="prominent"
              height={32}
              onPress={() => hereFromSearch(match)}
              textStyle={styles.smallButtonText}
              accessibilityLabel={`I'm at ${match.name}`}
            />
          </Glass>
        ) : missed ? (
          <Glass kind="clear" radius={dusk.radius.pill} style={styles.missed}>
            <Text numberOfLines={1} style={[font('600'), styles.missedText]} accessibilityLiveRegion="polite">
              {`No “${missed}” in the ${b.index.destination.name} guide`}
            </Text>
          </Glass>
        ) : null}

        {/* Where the buddy thinks you are, and how to change it. */}
        <View pointerEvents="box-none" style={styles.chipRow}>
          <Glass kind="clear" radius={dusk.radius.pill} style={styles.you}>
            <View
              style={styles.youInner}
              accessible
              accessibilityLiveRegion="polite"
              accessibilityLabel={`You are at ${b.situation.locationLabel}. Tap the map to move.`}>
              <View style={styles.youDot} />
              {/* Two lines, so the place name gets the chip's whole width (one line cut most names at 390). */}
              <View style={styles.youLines}>
                <Text numberOfLines={1} style={[onGlass, font('700'), styles.youText]}>
                  {`You: ${b.situation.locationLabel}`}
                </Text>
                <Text numberOfLines={1} style={[font('600'), styles.hint]}>
                  Tap the map to move
                </Text>
              </View>
            </View>
          </Glass>
          <OfflineChip />
        </View>
        {base && basePoint && (
          <View pointerEvents="box-none" style={styles.chipRow}>
            <Chip label="At my hotel" onPress={atHotel} accessibilityLabel={`I'm at my hotel, ${base.name}`} />
          </View>
        )}
      </View>

      {/* The chosen place, above the tab bar. */}
      {place && (
        <Glass kind="clear" radius={dusk.radius.sheet} style={[styles.card, { left: sx(12), right: sx(12) }]}>
          <View style={styles.cardClip}>
            <View style={styles.header} accessibilityLabel={`Selected place: ${place.name}`}>
              <PlacePhoto place={place} style={StyleSheet.absoluteFill} />
              <PhotoFade stops={[[0, 0], [0.3, 0], [1, 0.6]]} />
              <Text numberOfLines={1} ellipsizeMode="clip" accessibilityRole="header" style={[font('800'), styles.name]}>
                {place.name}
              </Text>
              <View style={styles.hereChip}>
                {atPlace ? (
                  <Glass kind="clear" radius={dusk.radius.pill} style={styles.chip}>
                    <View style={styles.youDot} />
                    <Text style={[onGlass, font('700'), styles.chipText]}>You're here</Text>
                  </Glass>
                ) : (
                  <Chip label="I'm here" onPress={() => imHere(place)} accessibilityLabel={`I'm at ${place.name}`} />
                )}
              </View>
            </View>
            <View style={styles.body}>
              <PlaceDirections from={b.situation.location} place={place} meters={b.metersTo(place.point)} />
              {rec && (
                <Text numberOfLines={height < SHORT_WINDOW ? 2 : 3} style={[font('500'), styles.reason]}>
                  {rec.reason}
                </Text>
              )}
              <View style={styles.buttons}>
                <GlassButton
                  label={inDay ? 'In your day' : 'Add to day'}
                  kind="prominent"
                  height={48}
                  disabled={inDay}
                  onPress={() => b.addToTrip(place.id)}
                  style={styles.button}
                  textStyle={styles.buttonText}
                  accessibilityLabel={inDay ? `${place.name} is in your day` : `Add ${place.name} to your day`}
                />
                <GlassButton
                  label="About it"
                  kind="clear"
                  height={48}
                  onPress={() => nav.openPlace(place.id)}
                  style={styles.button}
                  textStyle={[font('700'), styles.buttonText]}
                  accessibilityLabel={`About ${place.name}`}
                />
              </View>
            </View>
          </View>
        </Glass>
      )}
    </View>
  );
}

/** A small clear-glass chip that does one thing (I'm here, At my hotel). The touch target is 44 tall. */
function Chip({ label, onPress, accessibilityLabel }: { label: string; onPress: () => void; accessibilityLabel?: string }) {
  const slop = (dusk.size.touch - CHIP_HEIGHT) / 2;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      {...axPress(onPress)}
      hitSlop={{ top: slop, bottom: slop, left: 4, right: 4 }}
      style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}>
      <Glass kind="clear" radius={dusk.radius.pill} style={styles.chip}>
        <Text style={[onGlass, font('700'), styles.chipText]}>{label}</Text>
      </Glass>
    </Pressable>
  );
}

/** Arrow to the place, distance with a compass word, and walking time. */
function PlaceDirections({ from, place, meters }: { from: Place['point']; place: Place; meters: number }) {
  const { here, bearing, distance, word: dir, walk } = directions(from, place.point, meters);
  return (
    <View style={styles.row} accessible accessibilityLabel={here ? 'You are here' : `${distance} ${dir}, ${walk} minute walk`}>
      {!here && <ArrowIcon size={30} bearing={bearing} />}
      <Text>
        <Text style={[font('300'), styles.big]}>{here ? 'Here' : distance}</Text>
        {!here && <Text style={[font('500'), styles.small]}>{` ${dir}`}</Text>}
      </Text>
      {!here && (
        <Text>
          <Text style={[font('300'), styles.big]}>{`${walk} min`}</Text>
          <Text style={[font('500'), styles.small]}> walk</Text>
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: dusk.map.background },
  top: { position: 'absolute', top: TOP, gap: 8 },
  search: { height: SEARCH_HEIGHT, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16 },
  input: { flex: 1, height: SEARCH_HEIGHT, fontSize: 14, color: dusk.color.text, padding: 0 },
  match: { height: MATCH_HEIGHT, flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 16, paddingRight: 6 },
  matchName: { flex: 1, fontSize: 13 },
  smallButtonText: { fontSize: 12 },
  missed: { alignSelf: 'flex-start', maxWidth: '100%', height: CHIP_HEIGHT, justifyContent: 'center', paddingHorizontal: 12 },
  missedText: { fontSize: 12, color: dusk.color.textSoft },
  chipRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  you: { flexShrink: 1, minHeight: CHIP_HEIGHT, justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 5 },
  youInner: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  youDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: dusk.color.you, borderWidth: 1, borderColor: white(0.7) },
  youLines: { flexShrink: 1 },
  youText: { fontSize: 12, lineHeight: 16 },
  hint: { fontSize: 11, lineHeight: 14, color: dusk.color.text2 },
  chip: { height: CHIP_HEIGHT, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12 },
  chipText: { fontSize: 12 },
  card: { position: 'absolute', bottom: CARD_BOTTOM, shadowOpacity: 0.45, shadowRadius: 22, shadowOffset: { width: 0, height: 18 } },
  cardClip: { borderRadius: dusk.radius.sheet, overflow: 'hidden' },
  header: { height: HEADER_HEIGHT, overflow: 'hidden' },
  hereChip: { position: 'absolute', top: 10, right: 10 },
  name: {
    position: 'absolute',
    left: 10,
    right: -200, // let long names run off the right edge, as the mockup does
    bottom: -Math.round(NAME_SIZE * 0.2),
    fontSize: NAME_SIZE,
    lineHeight: NAME_SIZE * 1.05,
    letterSpacing: NAME_SIZE * dusk.font.placeName.tracking,
    color: white(0.92),
  },
  body: { paddingTop: 16, paddingHorizontal: 18, paddingBottom: 18, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  big: { fontSize: 26, letterSpacing: -0.78, color: dusk.color.text },
  small: { fontSize: 13, color: dusk.color.text2 },
  reason: { fontSize: 14, lineHeight: 19.6, color: dusk.color.textSoft },
  buttons: { flexDirection: 'row', gap: 8 },
  button: { flex: 1 },
  buttonText: { fontSize: 14 },
});
