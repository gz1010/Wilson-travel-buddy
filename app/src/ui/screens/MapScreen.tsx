import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { distanceMeters, formatDistance } from '../../core/geo';
import { fold } from '../../core/pack';
import type { GeoPoint, Place } from '../../core/types';
import { aerial, hasAerial, MAP_PALETTES, PAN_MARGIN, type MapLayer } from '../../map/mapHtml';
import { MapView, type MapPadding, type MapPin } from '../../map/MapView';
import { CATEGORY_LABEL, directions, HERE_METERS } from '../dusk/format';
import { axPress, Glass, GlassButton, OfflineChip, onGlass } from '../dusk/Glass';
import { nameBaseline } from '../dusk/GlassText';
import { glassWordSize } from '../dusk/GlassWord';
import { ArrowIcon, CloseIcon, SearchIcon } from '../dusk/Icons';
import { setTabBarTint } from '../dusk/Nav';
import { PhotoFade, PlacePhoto } from '../dusk/Photos';
import { dusk, font, ground, white } from '../dusk/tokens';
import type { ScreenProps } from './types';
import { noteMapTouch, tapWasOnOverlay } from '../touches';
import { useScreenSize } from '../dusk/Screen';

// AntMap: the offline map full screen, a glass search bar and a Layers button on top, and a glass
// card for the chosen place (or the first suggestion) above the tab bar, which DuskRoot draws.
//
// Where you are: "Locate me" asks macOS (b.locate: CoreLocation through the audio helper, which
// needs Wi-Fi networks nearby; else the last fix saved while online). When that fails, the
// traveller sets it: tapping the map moves you there, and "I'm here" (on a search result, on the
// bottom card) or "At my hotel" puts you at a place. The "You:" chip says where the buddy thinks
// you are; the map shows it as a glowing dot, with a ring for how sure macOS is.
//
// Layers: dark (the Dusk map), light (the same streets in white) and aerial (IGN's photos, when
// scripts/build-aerial.mjs has baked them in). The choice is remembered. Over the light map and
// the photos the glass is smoked a little, so its white type still reads.

const DESIGN_WIDTH = dusk.layout.phoneWidth;
const TOP = 56;
const SEARCH_HEIGHT = 46;
const ROW_HEIGHT = 54;
const CHIP_HEIGHT = 28;
const CARD_BOTTOM = 104;
const HEADER_HEIGHT = 92;
const NAME_SIZE = 44;
const LOCATE_HEIGHT = 40;
/** Below this window height (390×700 is the minimum) the card's reason gets two lines, not three. */
const SHORT_WINDOW = 760;
const MAX_RESULTS = 5;
/** How long the "Couldn't locate" note stays up. */
const NOTE_MS = 9000;
const CANT_LOCATE = "Couldn't locate this Mac. Tap the map to set where you are.";
const TAP_TO_SET = /\s*Tap the map to set where you are\.?\s*$/;

const LAYER_KEY = 'travelbuddy.mapLayer.v1';
const LAYERS: { id: MapLayer; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'aerial', label: 'Aerial' },
];
/**
 * A dark wash over the glass on the bright layers, so white type keeps its contrast. A flat wash,
 * not Liquid Glass's own tint: seen on macOS 26, the native tint is faint, and while the window is
 * not the key window the glass turns a milky white and drops it, which left every label on the
 * white map unreadable. The wash reads the same either way (and on the tab bar, via setTabBarTint).
 */
const SHADE: Record<MapLayer, string | undefined> = { dark: undefined, light: ground(0.6), aerial: ground(0.4) };
/** The last layer chosen, for the next time the map opens in this run (storage answers later). */
let rememberedLayer: MapLayer | undefined;
const isLayer = (v: unknown): v is MapLayer => v === 'dark' || v === 'light' || (v === 'aerial' && hasAerial);

/** A position from b.locate: macOS Location now, or the last fix saved while online. */
interface Fix {
  point: GeoPoint;
  accuracy?: number;
  source: 'macos' | 'saved';
  /** What "You:" says, when b.locate has already moved you there (it names the place itself). */
  label?: string;
}

/** What Locate me says: a line, and the helper's reason under it. */
interface Note {
  text: string;
  detail?: string;
}

export function MapScreen({ b, nav }: ScreenProps) {
  const { width, height } = useScreenSize();
  const sx = (x: number) => Math.round((x * width) / DESIGN_WIDTH);
  const [query, setQuery] = useState('');
  /** The result list is closed (a pick, Escape, a tap on the map) until the text changes again. */
  const [closed, setClosed] = useState(false);
  const [active, setActive] = useState(0);
  const [layer, setLayer] = useState<MapLayer>(rememberedLayer ?? 'dark');
  const [layersOpen, setLayersOpen] = useState(false);
  const [locating, setLocating] = useState(false);
  const [note, setNote] = useState<Note>();
  const [fix, setFix] = useState<Fix>();
  const [recenterKey, setRecenterKey] = useState(0);
  const [cardHeight, setCardHeight] = useState(0);
  const input = useRef<TextInput>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The remembered layer (once per run; later mounts start on it straight away).
  useEffect(() => {
    if (rememberedLayer) return;
    let live = true;
    AsyncStorage.getItem(LAYER_KEY)
      .then(v => {
        if (live && isLayer(v)) {
          rememberedLayer = v;
          setLayer(v);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // The tab bar is smoked like the map's own glass while a bright layer shows (its white icons
  // vanished over the white map).
  useEffect(() => {
    setTabBarTint(SHADE[layer]);
    return () => setTabBarTint(undefined);
  }, [layer]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(undefined), NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);

  const shade = SHADE[layer];
  const dest = b.index.destination;
  const you = b.situation.location;

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

  // While typing: the five places that best match, by name, local name, kind or neighbourhood.
  const typed = query.trim();
  const results = useMemo(() => {
    if (!typed) return [];
    const hits = searchPlaces(b.index.pack.places, typed, you);
    if (hits.length || typed.length < 3) return hits;
    // The guide's own matcher knows aliases and phrases ("the old town").
    const found = b.index.findPlace(typed);
    return found ? [{ place: found, score: 1, meters: distanceMeters(you, found.point) }] : [];
  }, [b.index, typed, you]);
  // Open only while it draws something, so a tap on the map is never spent closing nothing.
  const showList = !!typed && !closed && (results.length > 0 || typed.length >= 2);
  const activeRow = Math.min(active, Math.max(0, results.length - 1));

  // The card shows the focused place, else the first suggestion, else nothing.
  const place: Place | undefined = (b.focusId ? b.index.place(b.focusId) : undefined) ?? (b.recs[0] ? b.index.place(b.recs[0].placeId) : undefined);
  const rec = place ? b.recs.find(r => r.placeId === place.id) : undefined;
  const inDay = !!place && !!b.trip?.stops.some(s => s.placeId === place.id);
  const atPlace = !!place && b.metersTo(place.point) < HERE_METERS;

  // Where the traveller is staying, when the trip names a place the guide knows.
  const base = b.trip?.base;
  const basePoint = base?.point;

  // macOS's fix, while "you" is still where it put you: the ring and the chip's second line.
  const located = fix && fix.point.lat === you.lat && fix.point.lon === you.lon ? fix : undefined;

  // The open part of the map, between the glass on top and the card and Locate row below.
  const hasCard = !!place;
  const padding = useMemo<MapPadding>(() => {
    const top = TOP + SEARCH_HEIGHT + 8 + 44 + 24;
    let bottom = CARD_BOTTOM + (hasCard ? cardHeight + 12 : 0) + LOCATE_HEIGHT + 24;
    if (height - top - bottom < 120) bottom = Math.max(60, height - top - 120);
    return { top, bottom, left: 40, right: 40 };
  }, [height, hasCard, cardHeight]);

  const closeList = () => {
    setClosed(true);
    input.current?.blur();
  };

  const focus = (p: Place) => {
    b.setFocusId(p.id);
    setQuery(p.name);
    closeList();
  };

  /** Moves "you" to a place and keeps it on the card, so the map flies there and the card reads Here. */
  const imHere = (p: Place) => {
    b.setLocation(p.point, p.name);
    b.setFocusId(p.id);
    setNote(undefined);
  };

  const hereFromSearch = (p: Place) => {
    imHere(p);
    setQuery('');
    closeList();
  };

  const atHotel = () => {
    if (!base || !basePoint) return;
    b.setLocation(basePoint, base.name);
    if (base.placeId && b.index.place(base.placeId)) b.setFocusId(base.placeId);
  };

  const submit = () => {
    const first = results[activeRow];
    if (first) focus(first.place);
  };

  const onMapPress = (p: GeoPoint) => {
    // A click on a control over the map reaches the map too on macOS (see ui/touches.ts): not a map tap.
    if (tapWasOnOverlay()) return;
    // A tap on the map first closes what floats over it.
    if (layersOpen) setLayersOpen(false);
    else if (showList) closeList();
    else {
      setNote(undefined);
      b.setLocation(p);
    }
  };

  const clearSearch = () => {
    setQuery('');
    setClosed(false);
    input.current?.focus();
  };

  const chooseLayer = (l: MapLayer) => {
    setLayer(l);
    rememberedLayer = l;
    setLayersOpen(false);
    AsyncStorage.setItem(LAYER_KEY, l).catch(() => {});
  };

  // b.locating is true while any b.locate() call waits for macOS (the quiet startup locate doesn't set it).
  const busy = locating || (b as unknown as { locating?: unknown }).locating === true;

  /**
   * Asks macOS where the Mac is (b.locate falls back to the last fix saved while online and moves
   * "you" itself), and recentres on you either way, so the button also finds you on the map.
   */
  const locateMe = async () => {
    if (busy) return;
    setLayersOpen(false);
    setNote(undefined);
    const locate = (b as unknown as { locate?: (onNote?: (note: string) => void) => Promise<unknown> }).locate;
    let got: Fix | undefined;
    let said: string | undefined;
    if (typeof locate === 'function') {
      setLocating(true);
      try {
        got = readFix(await locate(n => (said = n)));
      } catch {
        got = undefined;
      }
      if (!alive.current) return;
      setLocating(false);
    }
    if (!got) {
      // The helper's reason, under the sentence that says what to do.
      const reason = said?.replace(TAP_TO_SET, '').trim();
      setNote({ text: CANT_LOCATE, detail: reason && !/could ?n[o']t locate this Mac\.?$/i.test(reason) ? reason : undefined });
    } else if (got.label === undefined && !inArea(got.point, dest.bounds)) {
      const km = Math.round(distanceMeters(got.point, centre(dest.bounds)) / 1000);
      setNote({ text: CANT_LOCATE, detail: `macOS puts this Mac ${km} km from ${dest.name}, off the offline map.` });
    } else {
      setFix(got);
      if (got.label === undefined) b.setLocation(got.point, fixLabel(b.index.nearest(got.point, 1)[0]));
      // "macOS could not locate this Mac. Showing where it last located you, 2 h ago."
      if (said) setNote({ text: said });
    }
    setRecenterKey(k => k + 1);
  };

  // Up and down move through the results; Escape clears the search (macOS keys on the text field).
  const keys: object = {
    keyDownEvents: [{ key: 'ArrowDown' }, { key: 'ArrowUp' }],
    onKeyDown: (e: { nativeEvent: { key: string } }) => {
      if (e.nativeEvent.key === 'ArrowDown') setActive(a => Math.min(a + 1, Math.max(0, results.length - 1)));
      else if (e.nativeEvent.key === 'ArrowUp') setActive(a => Math.max(0, a - 1));
    },
    enableFocusRing: false,
  };

  const locateRowBottom = CARD_BOTTOM + (hasCard ? cardHeight + 12 : 12);
  const youHint = located
    ? `${located.source === 'macos' ? 'Located by macOS' : 'Last fix saved online'}${located.accuracy ? ` · ±${formatMeters(located.accuracy)}` : ''}`
    : 'Tap the map to move';

  return (
    <View style={styles.root}>
      <View style={StyleSheet.absoluteFill} onStartShouldSetResponderCapture={noteMapTouch}>
        <MapView
          theme="dusk"
          layer={layer}
          bounds={dest.bounds}
          pins={pins}
          you={you}
          youAccuracy={located?.accuracy}
          focusId={b.focusId}
          recenterKey={recenterKey}
          padding={padding}
          onPress={onMapPress}
          onSelect={id => b.setFocusId(id)}
        />
      </View>

      {/* Search and layers, top. */}
      <View pointerEvents="box-none" style={[styles.top, { left: sx(14), right: sx(14) }]}>
        <View pointerEvents="box-none" style={styles.searchRow}>
          <Glass kind="clear" radius={dusk.radius.pill} wash={shade} style={styles.search}>
            <SearchIcon size={16} color={dusk.color.text} />
            <TextInput
              ref={input}
              value={query}
              onChangeText={t => {
                setQuery(t);
                setClosed(false);
                setActive(0);
                setLayersOpen(false);
              }}
              onSubmitEditing={submit}
              onKeyPress={e => {
                if (e.nativeEvent.key === 'Escape') {
                  setQuery('');
                  closeList();
                }
              }}
              submitBehavior="submit"
              placeholder="Search places or neighbourhoods"
              placeholderTextColor={dusk.color.text2}
              returnKeyType="search"
              autoCorrect={false}
              spellCheck={false}
              keyboardAppearance="dark"
              accessibilityLabel="Search places"
              selectionColor={white(0.3)}
              cursorColor={dusk.color.white}
              {...keys}
              style={[font('500'), styles.input]}
            />
            {query ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear the search"
                onPress={clearSearch}
                {...axPress(clearSearch)}
                hitSlop={12}
                style={styles.clear}>
                <CloseIcon size={10} color={dusk.color.text} strokeWidth={2.6} />
              </Pressable>
            ) : null}
          </Glass>
          <RoundButton
            label="Map layers"
            selected={layersOpen}
            wash={shade}
            onPress={() => {
              if (!layersOpen && showList) closeList();
              setLayersOpen(!layersOpen);
            }}>
            <LayersIcon />
          </RoundButton>
        </View>

        {/* Where the buddy thinks you are, and how to change it. */}
        <View pointerEvents="box-none" style={styles.chipRow}>
          <Glass kind="clear" radius={dusk.radius.pill} wash={shade} style={styles.you}>
            <View
              style={styles.youInner}
              accessible
              accessibilityLiveRegion="polite"
              accessibilityLabel={`You are at ${b.situation.locationLabel}. ${youHint}.`}>
              <View style={[styles.youDot, layer === 'light' && styles.youDotLight]} />
              {/* Two lines, so the place name gets the chip's whole width (one line cut most names at 390). */}
              <View style={styles.youLines}>
                <Text numberOfLines={1} style={[onGlass, font('700'), styles.youText]}>
                  {`You: ${b.situation.locationLabel}`}
                </Text>
                <Text numberOfLines={1} style={[font('600'), styles.hint]}>
                  {youHint}
                </Text>
              </View>
            </View>
          </Glass>
          <OfflineChip wash={shade} />
        </View>
        {base && basePoint && (
          <View pointerEvents="box-none" style={styles.chipRow}>
            <Chip label="At my hotel" wash={shade} onPress={atHotel} accessibilityLabel={`I'm at my hotel, ${base.name}`} />
          </View>
        )}
      </View>

      {/* Locate me on the right; on the left, what it said, and the photos' credit. */}
      <View pointerEvents="box-none" style={[styles.locateRow, { left: sx(14), right: sx(14), bottom: locateRowBottom }]}>
        <View pointerEvents="box-none" style={styles.notes}>
          {note ? (
            <Glass kind="clear" radius={18} wash={ground(0.55)} style={styles.note}>
              <View accessible accessibilityLiveRegion="polite" accessibilityLabel={note.detail ? `${note.text} ${note.detail}` : note.text}>
                <Text numberOfLines={3} style={[onGlass, font('600'), styles.noteText]}>
                  {note.text}
                </Text>
                {note.detail ? (
                  <Text numberOfLines={2} style={[font('500'), styles.noteDetail]}>
                    {note.detail}
                  </Text>
                ) : null}
              </View>
            </Glass>
          ) : null}
          {layer === 'aerial' && hasAerial ? (
            <View style={styles.credit} accessible accessibilityLabel={`Aerial photos: ${aerial.attribution}`}>
              {/* The licence wants the credit legible: it wraps rather than being cut (it is wider than the column at 390-430). */}
              <Text numberOfLines={2} style={[font('600'), styles.creditText]}>
                {creditLine(aerial.attribution)}
              </Text>
            </View>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Locate me"
          accessibilityHint="Asks macOS where this Mac is and centres the map on you"
          accessibilityState={{ busy }}
          onPress={locateMe}
          {...axPress(locateMe)}
          style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
          <Glass kind={located ? 'prominent' : 'clear'} radius={dusk.radius.pill} wash={shade} style={styles.locate}>
            {busy ? <ActivityIndicator size="small" color={dusk.color.white} style={styles.spinner} /> : <LocateIcon filled={!!located} />}
            <Text style={[onGlass, font('700'), styles.locateText]}>{busy ? 'Locating…' : 'Locate me'}</Text>
          </Glass>
        </Pressable>
      </View>

      {/* The chosen place, above the tab bar. */}
      {place && (
        <View
          style={[styles.card, { left: sx(12), right: sx(12) }]}
          onLayout={e => {
            const h = Math.round(e.nativeEvent.layout.height);
            if (h !== cardHeight) setCardHeight(h);
          }}>
          <Glass kind="clear" radius={dusk.radius.sheet} wash={shade} style={styles.cardGlass}>
            <View style={styles.cardClip}>
              <View style={styles.header} accessibilityLabel={`Selected place: ${place.name}`}>
                <PlacePhoto place={place} style={StyleSheet.absoluteFill} />
                <PhotoFade stops={[[0, 0], [0.3, 0], [1, 0.6]]} />
                <Text numberOfLines={1} ellipsizeMode="clip" accessibilityRole="header" style={[font('800'), styles.name, nameStyle(place.name, width - 2 * sx(12))]}>
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
                <PlaceDirections from={you} place={place} meters={b.metersTo(place.point)} />
                {rec && (
                  <Text numberOfLines={height < SHORT_WINDOW ? 2 : 3} style={[font('500'), styles.reason]}>
                    {rec.reason}
                  </Text>
                )}
                <View style={styles.buttons}>
                  <GlassButton
                    label={inDay ? '✓ In your day' : 'Add to day'}
                    kind="prominent"
                    height={48}
                    disabled={inDay}
                    onPress={() => b.addToTrip(place.id)}
                    // Added is a settled state (dim label), not a faded-out button.
                    style={[styles.button, inDay && styles.settled]}
                    textStyle={[styles.buttonText, inDay && styles.settledText]}
                    wash={shade}
                    accessibilityLabel={inDay ? `${place.name} is in your day` : `Add ${place.name} to your day`}
                  />
                  <GlassButton
                    label="About it"
                    kind="clear"
                    height={48}
                    onPress={() => nav.openPlace(place.id)}
                    style={styles.button}
                    textStyle={[font('700'), styles.buttonText]}
                    wash={shade}
                    accessibilityLabel={`About ${place.name}`}
                  />
                </View>
              </View>
            </View>
          </Glass>
        </View>
      )}

      {/* Search results, over the chips and the card (drawn last, so on top). */}
      {showList && (
        <View pointerEvents="box-none" style={[styles.listWrap, { left: sx(14), right: sx(14) }]}>
          {results.length ? (
            <Glass kind="clear" radius={24} wash={ground(0.5)} style={styles.list}>
              {results.map((r, i) => (
                <View key={r.place.id} style={[styles.row, i === activeRow && styles.rowActive]}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${r.place.name}, ${placeMeta(r.place, r.meters)}. Show on the map`}
                    onPress={() => focus(r.place)}
                    {...axPress(() => focus(r.place))}
                    style={styles.rowText}>
                    <Text numberOfLines={1} style={[onGlass, font('700'), styles.rowName]}>
                      {r.place.name}
                    </Text>
                    {/* The distance always shows; a long neighbourhood gives way first. */}
                    <View style={styles.metaRow}>
                      <Text numberOfLines={1} style={[font('500'), styles.rowMeta, styles.metaKind]}>
                        {[CATEGORY_LABEL[r.place.category], r.place.neighborhood].filter(Boolean).join(' · ')}
                      </Text>
                      <Text numberOfLines={1} style={[font('500'), styles.rowMeta]}>
                        {` · ${formatDistance(r.meters)}`}
                      </Text>
                    </View>
                  </Pressable>
                  <Chip label="Focus" onPress={() => focus(r.place)} accessibilityLabel={`Show ${r.place.name} on the map`} />
                  <Chip label="I'm here" prominent onPress={() => hereFromSearch(r.place)} accessibilityLabel={`I'm at ${r.place.name}`} />
                </View>
              ))}
            </Glass>
          ) : typed.length >= 2 ? (
            <Glass kind="clear" radius={dusk.radius.pill} wash={ground(0.5)} style={styles.missed}>
              <Text numberOfLines={1} style={[font('600'), styles.missedText]} accessibilityLiveRegion="polite">
                {`No “${typed}” in the ${dest.name} guide`}
              </Text>
            </Glass>
          ) : null}
        </View>
      )}

      {/* The three base maps. */}
      {layersOpen && (
        <Glass kind="clear" radius={24} wash={ground(0.45)} style={[styles.layers, { right: sx(14) }]}>
          {LAYERS.map(l => (
            <LayerTile key={l.id} layer={l.id} label={l.label} selected={layer === l.id} disabled={l.id === 'aerial' && !hasAerial} onPress={() => chooseLayer(l.id)} />
          ))}
        </Glass>
      )}
    </View>
  );
}

// --- Search -----------------------------------------------------------------------------------

interface Hit {
  place: Place;
  score: number;
  meters: number;
}

/** Words that say nothing about which place ("the", "de la"), dropped when others remain. */
const FILLER = new Set(['the', 'of', 'a', 'de', 'del', 'la', 'las', 'los', 'el', 'y', 'and']);

/**
 * The places that best match what was typed, accent- and case-insensitive. Every word must start
 * a word (or, from three letters, sit inside one) of the name, local name or aliases, the kind
 * ("cafe", "tapas") or the neighbourhood; the name counts most. Ties go to the nearer place.
 */
function searchPlaces(places: Place[], text: string, from: GeoPoint, limit = MAX_RESULTS): Hit[] {
  const q = fold(text).replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q) return [];
  const all = q.split(' ');
  const content = all.filter(w => !FILLER.has(w));
  const words = content.length ? content : all;
  const hits: Hit[] = [];
  for (const place of places) {
    const name = fold(place.name);
    const fields: [string, number][] = [
      [name, 100],
      [fold([place.localName, ...(place.aliases ?? [])].filter(Boolean).join(' · ')), 80],
      [fold(`${CATEGORY_LABEL[place.category] ?? ''} ${place.category.replace(/-/g, ' ')}`), 55],
      [fold(place.neighborhood ?? ''), 45],
    ];
    let score = 0;
    for (const w of words) {
      let best = 0;
      for (const [field, weight] of fields) best = Math.max(best, wordMatch(field, w) * weight);
      if (!best) {
        score = 0;
        break;
      }
      score += best;
    }
    if (!score) continue;
    if (name.startsWith(q)) score += 60;
    else if (name.includes(q)) score += 25;
    hits.push({ place, score, meters: distanceMeters(from, place.point) });
  }
  return hits.sort((a, b) => b.score - a.score || a.meters - b.meters).slice(0, limit);
}

/** 1 when w starts a word of text, 0.6 when (three letters or more) it sits inside one, else 0. */
function wordMatch(text: string, w: string): number {
  let inside = false;
  for (let i = text.indexOf(w); i >= 0; i = text.indexOf(w, i + 1)) {
    if (i === 0 || !/[a-z0-9]/.test(text[i - 1])) return 1;
    inside = true;
  }
  return inside && w.length >= 3 ? 0.6 : 0;
}

/** "Café · Centro · 450 m" */
function placeMeta(p: Place, meters: number): string {
  return [CATEGORY_LABEL[p.category], p.neighborhood, formatDistance(meters)].filter(Boolean).join(' · ');
}

// --- Position ---------------------------------------------------------------------------------

/** Accepts b.locate's answer ({ point, accuracy, source, label }, or a bare { lat, lon }); anything else is no fix. */
function readFix(v: unknown): Fix | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as { point?: { lat?: unknown; lon?: unknown }; lat?: unknown; lon?: unknown; accuracy?: unknown; source?: unknown; label?: unknown };
  const p = o.point && typeof o.point === 'object' ? o.point : o;
  const lat = typeof p.lat === 'number' ? p.lat : NaN;
  const lon = typeof p.lon === 'number' ? p.lon : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  const accuracy = typeof o.accuracy === 'number' && o.accuracy > 0 ? o.accuracy : undefined;
  return { point: { lat, lon }, accuracy, source: o.source === 'saved' ? 'saved' : 'macos', label: typeof o.label === 'string' ? o.label : undefined };
}

/** Inside the part of the destination the map can show. */
function inArea(p: GeoPoint, [w, s, e, n]: [number, number, number, number]): boolean {
  return p.lon >= w - PAN_MARGIN && p.lon <= e + PAN_MARGIN && p.lat >= s - PAN_MARGIN && p.lat <= n + PAN_MARGIN;
}

function centre([w, s, e, n]: [number, number, number, number]): GeoPoint {
  return { lat: (s + n) / 2, lon: (w + e) / 2 };
}

/** "near Plaza Nueva", or a plain phrase when no place is close. */
function fixLabel(near: { place: Place; meters: number } | undefined): string {
  return near && near.meters < 250 ? `near ${near.place.name}` : 'where macOS put you';
}

/**
 * "Aerial: PNOA máxima actualidad CC BY 4.0 scne.es", with the licence and the site held together
 * (no-break spaces), so a wrap falls before "CC BY" rather than leaving "scne.es" alone.
 */
function creditLine(attribution: string): string {
  return `Aerial: ${attribution.replace(/CC BY(?:-[A-Z]+)* [\d.]+(?: \S+)?$/, m => m.replace(/ /g, '\u00a0'))}`;
}

function formatMeters(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

// --- Pieces -----------------------------------------------------------------------------------

/** A small glass chip that does one thing (Focus, I'm here, At my hotel). The touch target is 44 tall. */
function Chip({ label, onPress, prominent, wash, accessibilityLabel }: { label: string; onPress: () => void; prominent?: boolean; wash?: string; accessibilityLabel?: string }) {
  const slop = (dusk.size.touch - CHIP_HEIGHT) / 2;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      {...axPress(onPress)}
      hitSlop={{ top: slop, bottom: slop, left: 4, right: 4 }}
      style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}>
      <Glass kind={prominent ? 'prominent' : 'clear'} radius={dusk.radius.pill} wash={wash} style={styles.chip}>
        <Text style={[onGlass, font('700'), styles.chipText]}>{label}</Text>
      </Glass>
    </Pressable>
  );
}

/** A round glass button the size of the search bar's height (Layers). */
function RoundButton({ label, selected, wash, onPress, children }: { label: string; selected?: boolean; wash?: string; onPress: () => void; children: React.ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: !!selected }}
      onPress={onPress}
      {...axPress(onPress)}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
      <Glass kind={selected ? 'prominent' : 'clear'} radius={SEARCH_HEIGHT / 2} wash={wash} style={styles.round}>
        {children}
      </Glass>
    </Pressable>
  );
}

const TILE_W = 84;
const TILE_H = 58;

/** One base map to choose: a little picture of it and its name. */
function LayerTile({ layer, label, selected, disabled, onPress }: { layer: MapLayer; label: string; selected: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={disabled ? `${label} map, not prepared` : `${label} map`}
      accessibilityState={{ selected, disabled: !!disabled }}
      accessibilityHint={disabled ? 'Run scripts/build-aerial.mjs while online to add the photos' : undefined}
      disabled={disabled}
      onPress={onPress}
      {...axPress(onPress, disabled)}
      style={({ pressed }) => [styles.tile, { opacity: disabled ? 0.45 : pressed ? 0.85 : 1 }]}>
      <View style={[styles.preview, selected ? styles.previewOn : null]}>
        {layer === 'aerial' ? <AerialPreview /> : <StreetsPreview palette={layer === 'light' ? MAP_PALETTES.light : MAP_PALETTES.dark} />}
      </View>
      <Text numberOfLines={1} style={[onGlass, font(selected ? '800' : '600'), styles.tileText]}>
        {label}
      </Text>
      {disabled ? <Text style={[font('500'), styles.tileNote]}>Not prepared</Text> : null}
    </Pressable>
  );
}

/** A few streets, a park and the river in the layer's own colours (fixed size, so SVG is safe on macOS). */
function StreetsPreview({ palette: p }: { palette: (typeof MAP_PALETTES)['dark'] }) {
  const w = TILE_W - 4;
  const h = TILE_H - 4;
  return (
    <Svg width={w} height={h}>
      <Rect x={0} y={0} width={w} height={h} fill={p.earth} />
      <Rect x={46} y={6} width={22} height={16} rx={2} fill={p.parks} />
      <Rect x={8} y={30} width={16} height={12} rx={1.5} fill={p.buildings} stroke={p.buildingLine} strokeWidth={0.5} />
      <Rect x={30} y={34} width={12} height={10} rx={1.5} fill={p.buildings} stroke={p.buildingLine} strokeWidth={0.5} />
      <Path d={`M-4 ${h - 8} C 20 ${h - 14}, 36 ${h + 2}, ${w + 4} ${h - 12}`} stroke={p.water} strokeWidth={7} fill="none" />
      <Path d={`M0 22 L${w} 28 M26 0 L22 ${h} M${w - 12} 0 L${w - 22} ${h}`} stroke={p.casing} strokeWidth={5} fill="none" strokeLinecap="round" />
      <Path d={`M0 22 L${w} 28 M26 0 L22 ${h} M${w - 12} 0 L${w - 22} ${h}`} stroke={p.major} strokeWidth={3} fill="none" strokeLinecap="round" />
    </Svg>
  );
}

/** A real aerial tile from the middle of the destination. */
function AerialPreview() {
  const uri = useMemo(() => {
    const tiles = aerial.tiles;
    const area = aerial.bounds;
    if (!tiles || !area) return undefined;
    const lon = (area[0] + area[2]) / 2;
    const lat = (area[1] + area[3]) / 2;
    for (const z of [16, 15, aerial.maxzoom, aerial.minzoom]) {
      const n = 2 ** z;
      const x = Math.floor(((lon + 180) / 360) * n);
      const r = (lat * Math.PI) / 180;
      const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
      const b64 = tiles[`${z}/${x}/${y}`];
      if (b64) return `data:image/jpeg;base64,${b64}`;
    }
    const any = Object.values(tiles)[0];
    return any ? `data:image/jpeg;base64,${any}` : undefined;
  }, []);
  return uri ? <Image source={{ uri }} resizeMode="cover" style={styles.previewImage} /> : <View style={[styles.previewImage, { backgroundColor: MAP_PALETTES.aerial.bg }]} />;
}

/** Layers: two stacked sheets (the Dusk canvas's icon). */
function LayersIcon({ size = 18, color = dusk.color.white }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round">
      <Path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5" />
    </Svg>
  );
}

/** The location arrow; filled while "you" is where macOS put you. */
function LocateIcon({ size = 16, color = dusk.color.white, filled }: { size?: number; color?: string; filled?: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? color : 'none'} stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round">
      <Path d="M20.5 3.5 3.6 10.7l7.1 2.6 2.6 7.1z" />
    </Svg>
  );
}

/** Room the card's name keeps from the card's left and right edges. */
const NAME_LEFT = 14;
const NAME_RIGHT = 14;
/** In a line box of 1.05 em, SF Pro's baseline sits this share of the size above the box's bottom. */
const NAME_DESCENT = 0.245;

/**
 * The card's place name, whole: as large as NAME_SIZE allows while the whole name fits the card's
 * width on one line (long names such as "Confitería La Campana" used to run off the right edge),
 * standing on the photo's bottom edge, lifted when it has descenders (g, p, y, brackets) so they
 * show too. Sized with the glass names' SF Pro Heavy metrics, which the Bold here never exceeds.
 */
function nameStyle(name: string, cardWidth: number) {
  const size = glassWordSize(name, cardWidth - NAME_LEFT - NAME_RIGHT, NAME_SIZE);
  return {
    fontSize: size,
    lineHeight: Math.round(size * 1.05),
    letterSpacing: size * dusk.font.placeName.tracking,
    bottom: Math.round(nameBaseline(name, size) - size * NAME_DESCENT),
  };
}

/** Arrow to the place, distance with a compass word, and walking time. */
function PlaceDirections({ from, place, meters }: { from: Place['point']; place: Place; meters: number }) {
  const { here, bearing, distance, word: dir, walk } = directions(from, place.point, meters);
  return (
    <View style={styles.dirRow} accessible accessibilityLabel={here ? 'You are here' : `${distance} ${dir}, ${walk} minute walk`}>
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
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // The text field takes its own height from the font and sits in the middle of the bar: given
  // the bar's full height, macOS draws the text at the top of it.
  search: { flex: 1, height: SEARCH_HEIGHT, flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 16, paddingRight: 12 },
  input: { flex: 1, minWidth: 0, fontSize: 15, color: dusk.color.text, paddingVertical: 0, paddingHorizontal: 0 },
  clear: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: white(0.2) },
  round: { width: SEARCH_HEIGHT, height: SEARCH_HEIGHT, alignItems: 'center', justifyContent: 'center' },
  listWrap: { position: 'absolute', top: TOP + SEARCH_HEIGHT + 8 },
  list: { paddingVertical: 6, paddingHorizontal: 6 },
  row: { height: ROW_HEIGHT, flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 12, paddingRight: 6, borderRadius: 18 },
  rowActive: { backgroundColor: white(0.1) },
  rowText: { flex: 1, minWidth: 0, justifyContent: 'center', alignSelf: 'stretch' },
  rowName: { fontSize: 15, lineHeight: 19 },
  rowMeta: { fontSize: 12, lineHeight: 16, color: dusk.color.text2 },
  metaRow: { flexDirection: 'row' },
  metaKind: { flexShrink: 1 },
  missed: { alignSelf: 'flex-start', maxWidth: '100%', height: 32, justifyContent: 'center', paddingHorizontal: 14 },
  missedText: { fontSize: 13, color: dusk.color.textSoft },
  layers: { position: 'absolute', top: TOP + SEARCH_HEIGHT + 8, flexDirection: 'row', gap: 8, padding: 10 },
  tile: { width: TILE_W, alignItems: 'center', gap: 5 },
  preview: { width: TILE_W, height: TILE_H, borderRadius: 14, overflow: 'hidden', borderWidth: 2, borderColor: white(0.18), alignItems: 'center', justifyContent: 'center' },
  previewOn: { borderColor: white(0.95) },
  previewImage: { width: TILE_W - 4, height: TILE_H - 4 },
  tileText: { fontSize: 12 },
  tileNote: { fontSize: 11, color: dusk.color.text2, marginTop: -3 },
  chipRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  you: { flexShrink: 1, minHeight: CHIP_HEIGHT, justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 5 },
  youInner: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  youDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: dusk.color.you, borderWidth: 1, borderColor: white(0.7) },
  youDotLight: { backgroundColor: MAP_PALETTES.light.you, borderColor: dusk.color.white },
  youLines: { flexShrink: 1 },
  youText: { fontSize: 12, lineHeight: 16 },
  hint: { fontSize: 11, lineHeight: 14, color: dusk.color.text2 },
  chip: { height: CHIP_HEIGHT, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12 },
  chipText: { fontSize: 12 },
  locateRow: { position: 'absolute', flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  notes: { flex: 1, minWidth: 0, alignItems: 'flex-start', gap: 6 },
  note: { maxWidth: '100%', paddingHorizontal: 14, paddingVertical: 9 },
  noteText: { fontSize: 13, lineHeight: 17 },
  noteDetail: { fontSize: 12, lineHeight: 16, marginTop: 2, color: dusk.color.text2 },
  credit: { maxWidth: '100%', minHeight: 22, justifyContent: 'center', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 11, backgroundColor: ground(0.6) },
  creditText: { fontSize: 11, lineHeight: 14, color: dusk.color.text2 },
  locate: { height: LOCATE_HEIGHT, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 14 },
  locateText: { fontSize: 13 },
  spinner: { width: 16, height: 16 },
  card: { position: 'absolute', bottom: CARD_BOTTOM },
  cardGlass: { shadowOpacity: 0.45, shadowRadius: 22, shadowOffset: { width: 0, height: 18 } },
  cardClip: { borderRadius: dusk.radius.sheet, overflow: 'hidden' },
  header: { height: HEADER_HEIGHT, overflow: 'hidden' },
  hereChip: { position: 'absolute', top: 10, right: 10 },
  // Size, line height, tracking and bottom come from nameStyle (fitted to the name).
  name: { position: 'absolute', left: NAME_LEFT, right: NAME_RIGHT, color: white(0.94) },
  body: { paddingTop: 16, paddingHorizontal: 18, paddingBottom: 18, gap: 10 },
  dirRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  big: { fontSize: 26, letterSpacing: -0.78, color: dusk.color.text },
  small: { fontSize: 13, color: dusk.color.text2 },
  reason: { fontSize: 14, lineHeight: 19.6, color: dusk.color.textSoft },
  buttons: { flexDirection: 'row', gap: 8 },
  button: { flex: 1 },
  settled: { opacity: 1 },
  settledText: { color: dusk.color.text2 },
  buttonText: { fontSize: 14 },
});
