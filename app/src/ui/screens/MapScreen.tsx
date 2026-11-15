import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Place } from '../../core/types';
import { MapView, type MapPin } from '../../map/MapView';
import { directions } from '../dusk/format';
import { Glass, GlassButton, OfflineChip } from '../dusk/Glass';
import { ArrowIcon, SearchIcon } from '../dusk/Icons';
import { PhotoFade, PlacePhoto } from '../dusk/Photos';
import { dusk, font, white } from '../dusk/tokens';
import type { ScreenProps } from './types';
import { useScreenSize } from '../dusk/Screen';

// AntMap: the offline map full screen, a glass search bar on top, and a glass card for the
// chosen place (or the first suggestion) above the tab bar, which DuskRoot draws.

const DESIGN_WIDTH = dusk.layout.phoneWidth;
const TOP = 56;
const SEARCH_HEIGHT = 46;
const CARD_BOTTOM = 104;
const HEADER_HEIGHT = 92;
const NAME_SIZE = 44;

export function MapScreen({ b, nav }: ScreenProps) {
  const { width } = useScreenSize();
  const sx = (x: number) => Math.round((x * width) / DESIGN_WIDTH);
  const [query, setQuery] = useState('');
  const [missed, setMissed] = useState<string>();

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

  // The card shows the focused place, else the first suggestion, else nothing.
  const place: Place | undefined = (b.focusId ? b.index.place(b.focusId) : undefined) ?? (b.recs[0] ? b.index.place(b.recs[0].placeId) : undefined);
  const rec = place ? b.recs.find(r => r.placeId === place.id) : undefined;
  const inDay = !!place && !!b.trip?.stops.some(s => s.placeId === place.id);

  // A Mac has no GPS and can't locate itself offline, so the person says where they are: tap the
  // map, or search a place and choose "I'm here".
  const trimmed = query.trim();
  const match = useMemo(() => (trimmed ? b.index.findPlace(trimmed) : undefined), [b.index, trimmed]);
  const hotel = b.trip?.base?.point ? { name: b.trip.base.name, point: b.trip.base.point } : undefined;
  const imHere = (p: Place) => {
    b.setLocation(p.point, p.name);
    b.setFocusId(p.id);
  };

  const submit = () => {
    const text = query.trim();
    if (!text) return;
    const found = b.index.findPlace(text);
    if (found) {
      b.setFocusId(found.id);
      setMissed(undefined);
    } else {
      setMissed(text);
    }
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
        <View pointerEvents="box-none" style={styles.underSearch}>
          <View pointerEvents="box-none" style={styles.chips}>
            {missed ? (
              <Glass kind="clear" radius={dusk.radius.pill} style={styles.missed}>
                <Text numberOfLines={1} style={[font('600'), styles.missedText]} accessibilityLiveRegion="polite">
                  {`No “${missed}” in the ${b.index.destination.name} guide`}
                </Text>
              </Glass>
            ) : match ? (
              <View style={styles.chipRow}>
                <SmallChip label="Focus" onPress={() => b.setFocusId(match.id)} accessibilityLabel={`Show ${match.name} on the map`} />
                <SmallChip label="I'm here" prominent onPress={() => imHere(match)} accessibilityLabel={`Set my location to ${match.name}`} />
              </View>
            ) : null}
            <Glass kind="clear" radius={dusk.radius.pill} style={styles.you}>
              <Text numberOfLines={1} style={[font('700'), styles.youText]} accessibilityLiveRegion="polite">
                {`You: ${b.situation.locationLabel}`}
              </Text>
              <Text numberOfLines={1} style={[font('500'), styles.youHint]}>
                Tap the map to move
              </Text>
            </Glass>
            {hotel && (
              <View style={styles.chipRow}>
                <SmallChip label="At my hotel" onPress={() => b.setLocation(hotel.point, hotel.name)} accessibilityLabel={`Set my location to ${hotel.name}`} />
              </View>
            )}
          </View>
          <OfflineChip />
        </View>
      </View>

      {/* The chosen place, above the tab bar. */}
      {place && (
        <Glass kind="clear" radius={dusk.radius.sheet} style={[styles.card, { left: sx(12), right: sx(12) }]}>
          <View style={styles.cardClip} accessibilityLabel={`Selected place: ${place.name}`}>
            <View style={styles.header}>
              <PlacePhoto place={place} style={StyleSheet.absoluteFill} />
              <PhotoFade stops={[[0, 0], [0.3, 0], [1, 0.6]]} />
              <Text numberOfLines={1} ellipsizeMode="clip" accessibilityRole="header" style={[font('800'), styles.name]}>
                {place.name}
              </Text>
            </View>
            <View style={styles.body}>
              <View style={styles.directionsRow}>
                <PlaceDirections from={b.situation.location} place={place} meters={b.metersTo(place.point)} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Set my location to ${place.name}`}
                  onPress={() => imHere(place)}
                  hitSlop={8}
                  style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                >
                  <Text style={[font('700'), styles.hereLink]}>I'm here</Text>
                </Pressable>
              </View>
              {rec && <Text style={[font('500'), styles.reason]}>{rec.reason}</Text>}
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

/** A small clear-glass chip button (28 tall) for the row under the search bar. */
function SmallChip({ label, onPress, prominent, accessibilityLabel }: { label: string; onPress: () => void; prominent?: boolean; accessibilityLabel?: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}>
      <Glass kind={prominent ? 'prominent' : 'clear'} radius={dusk.radius.pill} style={styles.smallChip}>
        <Text style={[font('700'), styles.smallChipText]}>{label}</Text>
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
  underSearch: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  chips: { flexShrink: 1, alignItems: 'flex-start', gap: 6 },
  chipRow: { flexDirection: 'row', gap: 6 },
  smallChip: { height: 28, justifyContent: 'center', paddingHorizontal: 12 },
  smallChipText: { fontSize: 12, color: dusk.color.text },
  you: { minHeight: 28, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 5 },
  youText: { fontSize: 12, color: dusk.color.text },
  youHint: { fontSize: 11, color: dusk.color.text2 },
  directionsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  hereLink: { fontSize: 13, color: dusk.color.text, textDecorationLine: 'underline' },
  missed: { flexShrink: 1, height: 28, justifyContent: 'center', paddingHorizontal: 12 },
  missedText: { fontSize: 12, color: dusk.color.textSoft },
  card: { position: 'absolute', bottom: CARD_BOTTOM, shadowOpacity: 0.45, shadowRadius: 22, shadowOffset: { width: 0, height: 18 } },
  cardClip: { borderRadius: dusk.radius.sheet, overflow: 'hidden' },
  header: { height: HEADER_HEIGHT, overflow: 'hidden' },
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
