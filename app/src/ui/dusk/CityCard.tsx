import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { PackIndex } from '../../core/pack';
import type { Trip } from '../../core/types';
import type { KnownCity, PackPrepared } from '../screens/types';
import { axPress, Glass, onGlass } from './Glass';
import { nameBaseline, nameSizeForRoom } from './GlassText';
import { GlassWord, glassWordSize } from './GlassWord';
import { LinearGradient, useBox } from './Gradient';
import { LiquidGlass } from './LiquidGlass';
import { PhotoFade, SharpImage } from './Photos';
import { dusk, font, white } from './tokens';

// The cities Wilson knows, as photo cards stacked on the home (after Panora's month cards): the
// city's photo, its name in liquid-glass letters standing whole above the card's bottom edge, a
// pill with what the guide holds, when it was prepared, and the city's own name. Tapping a card
// opens that city's guide. Below the card, the plain helpers the home uses to tell a prepared
// city from one Wilson has yet to learn: matching typed names, and reading which city an imported
// itinerary is for. None of it goes online; the world list is a few lines of names in code.

/** Dark behind the pill at the top and behind the glass letters at the bottom. */
const CARD_FADE: [number, number][] = [
  [0, 0.55],
  [0.36, 0.14],
  [0.58, 0.04],
  [1, 0.5],
];
/** Room kept at the card's sides for the glass letters. */
const NAME_INSET = 14;
/** At most this share of the card's height goes to the name. */
const NAME_ROOM = 0.5;
/** A dusk sky for a city without a photo. */
const NO_PHOTO = ['#7A5A7E', '#3D2F45', dusk.color.ground];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** "Nov 15": the preparer's own calendar day, read straight from the ISO string; undefined if never prepared. */
export function preparedDay(preparedAt: string | null | undefined): string | undefined {
  const m = preparedAt ? /^(\d{4})-(\d{2})-(\d{2})/.exec(preparedAt) : null;
  return m ? `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}` : undefined;
}

/** The card's pill: "60 places · ready offline", or that it still needs preparing. */
export function cityPill(p: PackPrepared): string {
  return p.preparedAt ? `${plural(p.places, 'place')} · ready offline` : 'Not prepared yet';
}

/** The line under the pill: "Prepared Nov 15 · 81 facts · 55 photos", or how to prepare it. */
export function cityPreparedLine(p: PackPrepared): string {
  const day = preparedDay(p.preparedAt);
  if (!day) return 'Run node scripts/prepare-pack.mjs while online';
  return `Prepared ${day} · ${plural(p.facts, 'fact')} · ${plural(p.photos + (p.heroes ?? 0), 'photo')}`;
}

/** A pack as a card: its destination, its prepared.json with the pack's own counts, and what the pack doesn't say. */
export function cityFromPack(index: PackIndex, prepared: Omit<PackPrepared, 'places' | 'facts'> & Partial<PackPrepared>, extra: Pick<KnownCity, 'localName' | 'photo' | 'aliases'> = {}): KnownCity {
  const d = index.destination;
  return {
    id: d.id,
    name: d.name,
    country: d.country,
    ...extra,
    prepared: { ...prepared, places: index.pack.places.length, facts: index.pack.facts.length, photos: prepared.photos ?? 0 },
  };
}

/** A chevron pointing right (decorative: the card carries the label). */
const OpenIcon = ({ size = 14, color = dusk.color.white }: { size?: number; color?: string }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M9 5l7 7-7 7" />
  </Svg>
);

/**
 * One city's card. `height` is the whole card; the photo covers it, the name is as large as fits
 * its width and half its height. While `opening` (tapped before Wilson woke up), the round button
 * in the corner spins.
 */
export function CityCard({ city, height, onPress, opening, style }: { city: KnownCity; height: number; onPress: () => void; opening?: boolean; style?: StyleProp<ViewStyle> }) {
  const box = useBox();
  const [hover, setHover] = useState(false);
  const w = box.size?.width ?? 0;
  const name = city.name;
  const size = w > 0 ? Math.max(28, Math.min(glassWordSize(name, w - 2 * NAME_INSET, 140), Math.floor(nameSizeForRoom(name, height * NAME_ROOM)))) : 0;
  const lift = size ? nameBaseline(name, size) : 0;
  const p = city.prepared;
  const pill = cityPill(p);
  const line = cityPreparedLine(p);
  const label = [`${name}${city.localName && city.localName !== name ? ` (${city.localName})` : ''}, ${city.country}`, pill, line].join('. ');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={`Opens Wilson's ${name} guide`}
      accessibilityState={{ busy: !!opening }}
      onPress={onPress}
      {...axPress(onPress)}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      style={({ pressed }) => [{ height, opacity: pressed ? 0.9 : 1 }, styles.shadow, style]}>
      <View style={styles.card} onLayout={box.onLayout}>
        {city.photo !== undefined ? <SharpImage source={city.photo} /> : <LinearGradient colors={NO_PHOTO} style={StyleSheet.absoluteFill} />}
        <PhotoFade stops={CARD_FADE} />
        {/* The photo again with the name in 3D liquid glass, whole; the SVG letters show until it has drawn. */}
        {size > 0 ? (
          <LiquidGlass
            photo={city.photo}
            lines={[{ text: name, size, baseline: lift }]}
            inset={NAME_INSET}
            fade={CARD_FADE}
            fallback={<GlassWord text={name} size={size} cut={0} lift={lift} inset={NAME_INSET} label={null} />}
          />
        ) : null}
        <View pointerEvents="none" style={[styles.rim, { borderColor: white(hover ? 0.34 : 0.14) }]} />
        <View pointerEvents="none" style={styles.top}>
          <View style={styles.topLeft}>
            <Glass kind="clear" radius={999} style={styles.pill}>
              <Text style={[onGlass, styles.pillText]} numberOfLines={1}>
                {pill}
              </Text>
            </Glass>
            <Text style={[onGlass, styles.line]} numberOfLines={1}>
              {line}
            </Text>
          </View>
          <View style={styles.topRight}>
            {city.localName && city.localName !== name ? (
              <Text style={[onGlass, styles.local]} numberOfLines={1}>
                {city.localName}
              </Text>
            ) : null}
            <Glass kind="clear" radius={16} style={styles.open}>
              {opening ? <ActivityIndicator size="small" color={dusk.color.white} /> : <OpenIcon />}
            </Glass>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

/**
 * The cities as a vertical stack of cards, first on top (more cities stack under it later). Every
 * card is `cardHeight` tall, 12 px apart. Memo'd: the home re-renders with every change in the app
 * state (a reply streaming in), and the cards (each a WebGL page) need not.
 */
export const CityStack = React.memo(function CityStack({ cities, cardHeight, opening, onOpen }: { cities: KnownCity[]; cardHeight: number; opening?: string; onOpen: (id: string) => void }) {
  return (
    <View style={styles.stack}>
      {cities.map(c => (
        <CityCard key={c.id} city={c} height={cardHeight} opening={opening === c.id} onPress={() => onOpen(c.id)} />
      ))}
    </View>
  );
});

// --- Telling cities apart, in plain code.

/** Lower case, no accents or apostrophes, punctuation as single spaces: "Xi'an, China!" → "xian china". */
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'‘`´]/g, '')
    .replace(/[\s!-/:-@[-`{-~ -¿ -⁯　-〿！-／]+/g, ' ')
    .trim();
}

/** True when `term` (normalized) is in `text` (normalized) as whole words; names in other scripts (巴黎) anywhere. */
function mentions(text: string, term: string): boolean {
  if (!term) return false;
  // eslint-disable-next-line no-control-regex
  if (/[^\u0000-\u007f]/.test(term)) return text.includes(term);
  return ` ${text} `.includes(` ${term} `);
}

/** How many of `terms` appear in `text`. */
function countMentions(text: string, terms: string[]): number {
  return terms.filter(t => mentions(text, normalizeName(t))).length;
}

/**
 * Cities someone might plan instead, with a few landmarks each, so an itinerary that never names
 * its city can still be placed. Only for saying "this looks like Paris"; nothing is looked up.
 */
const WORLD: { name: string; names: string[]; landmarks: string[] }[] = [
  { name: 'Paris', names: ['Paris', 'París', '巴黎'], landmarks: ['Eiffel', 'Louvre', 'Montmartre', 'Notre-Dame', 'Sacré-Coeur', 'Sacré-Cœur', 'Champs-Élysées', "Musée d'Orsay", 'Arc de Triomphe', 'Tuileries', 'Le Marais', 'Versailles'] },
  { name: "Xi'an", names: ["Xi'an", 'Xian', '西安'], landmarks: ['Terracotta', 'Wild Goose Pagoda', 'Muslim Quarter', 'Huaqing', 'Beilin'] },
  { name: 'Madrid', names: ['Madrid'], landmarks: ['Prado', 'Retiro', 'Puerta del Sol', 'Reina Sofía', 'Bernabéu', 'Gran Vía'] },
  { name: 'Barcelona', names: ['Barcelona'], landmarks: ['Sagrada Família', 'Park Güell', 'La Rambla', 'Las Ramblas', 'Casa Batlló', 'Camp Nou', 'Barceloneta', 'La Pedrera'] },
  { name: 'Granada', names: ['Granada'], landmarks: ['Alhambra', 'Albaicín', 'Generalife', 'Sacromonte'] },
  { name: 'Córdoba', names: ['Córdoba', 'Cordova'], landmarks: ['Mezquita', 'Medina Azahara'] },
  { name: 'Lisbon', names: ['Lisbon', 'Lisboa'], landmarks: ['Belém', 'Alfama', 'Sintra', 'Bairro Alto', 'Chiado'] },
  { name: 'Rome', names: ['Rome', 'Roma'], landmarks: ['Colosseum', 'Colosseo', 'Vatican', 'Trevi', 'Pantheon', 'Trastevere', 'Sistine'] },
  { name: 'Florence', names: ['Florence', 'Firenze'], landmarks: ['Uffizi', 'Ponte Vecchio', 'Boboli', 'Piazzale Michelangelo'] },
  { name: 'Venice', names: ['Venice', 'Venezia'], landmarks: ['Rialto', 'San Marco', "St Mark's", 'Murano', 'Burano', 'Gondola'] },
  { name: 'London', names: ['London'], landmarks: ['Big Ben', 'Tower Bridge', 'British Museum', 'Buckingham', 'Westminster', 'Camden'] },
  { name: 'Amsterdam', names: ['Amsterdam'], landmarks: ['Rijksmuseum', 'Anne Frank', 'Van Gogh Museum', 'Jordaan'] },
  { name: 'Berlin', names: ['Berlin'], landmarks: ['Brandenburg Gate', 'Reichstag', 'Museum Island', 'Checkpoint Charlie'] },
  { name: 'Prague', names: ['Prague', 'Praha'], landmarks: ['Charles Bridge', 'Prague Castle'] },
  { name: 'New York', names: ['New York', 'NYC', 'Manhattan', 'Brooklyn'], landmarks: ['Central Park', 'Times Square', 'Brooklyn Bridge', 'Statue of Liberty'] },
  { name: 'Tokyo', names: ['Tokyo', '東京', '东京'], landmarks: ['Shibuya', 'Shinjuku', 'Sensō-ji', 'Senso-ji', 'Asakusa', 'Harajuku'] },
  { name: 'Kyoto', names: ['Kyoto', '京都'], landmarks: ['Fushimi Inari', 'Kinkaku-ji', 'Arashiyama', 'Gion'] },
  { name: 'Beijing', names: ['Beijing', 'Peking', '北京'], landmarks: ['Forbidden City', 'Great Wall', 'Tiananmen', 'Summer Palace'] },
  { name: 'Shanghai', names: ['Shanghai', '上海'], landmarks: ['The Bund', 'Yu Garden', 'Pudong'] },
  { name: 'Marrakech', names: ['Marrakech', 'Marrakesh'], landmarks: ['Jemaa el-Fnaa', 'Majorelle'] },
];

/** Every name a known city answers to, normalized. */
function cityNames(c: KnownCity): string[] {
  return [...new Set([c.name, c.localName ?? '', c.id, ...(c.aliases ?? [])].map(normalizeName).filter(Boolean))];
}

/** True when `text` is just that name, or the name with a country or a few words around it ("Seville, Spain", "trip to Seville"). */
function namesCity(text: string, names: string[]): boolean {
  const n = normalizeName(text);
  return names.some(k => n === k || n.startsWith(`${k} `) || n.endsWith(` ${k}`));
}

/** The prepared city someone typed ("sevilla", "Seville, Spain"), if it is one. */
export function findKnownCity(text: string, cities: KnownCity[]): KnownCity | undefined {
  return cities.find(c => namesCity(text, cityNames(c)));
}

/** A typed city name as the home shows it: the usual spelling of a city it knows of ("xian" → "Xi'an"), else tidied. */
export function displayCityName(text: string): string {
  const typed = text.replace(/\s+/g, ' ').trim().slice(0, 40);
  const world = WORLD.find(w => namesCity(typed, w.names.map(normalizeName)));
  if (world) return world.name;
  // All lower case ("lyon", "san sebastian"): capitalise each word; otherwise as typed.
  return typed === typed.toLowerCase() ? typed.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') : typed;
}

/** First words of a question or a request to Wilson rather than a place ("Tell me about…", "what's on tonight"). */
const ASKING = new Set(
  'what whats where wheres when why how hows who whos which is are was can could should would will do does did tell show give find recommend suggest help explain describe translate say i im ive id ill my me we were lets please hi hello hey hola wilson any anything thanks thank ok okay'.split(' '),
);
/** Words of a wish rather than a city's name ("somewhere warm", "anywhere sunny"). */
const VAGUE = new Set('somewhere anywhere someplace elsewhere nowhere warm warmer sunny abroad'.split(' '));

/** What the home's input was given: a city Wilson knows, one he would have to learn, a wish, or a question for him. */
export type HomeInput = { kind: 'city'; city: KnownCity } | { kind: 'learn'; name: string } | { kind: 'vague' } | { kind: 'ask'; text: string };

/**
 * Reads what was typed on the home, in plain code: a prepared city ("sevilla", "trip to Seville")
 * opens it; a city Wilson knows of by name, anywhere in the text ("I'd love to see Paris"), is one
 * to learn; a question or a sentence ("Tell me the story of the cathedral") goes to Wilson; a wish
 * ("somewhere warm") gets the note on how he learns a city; anything else short is taken as a
 * city's name he hasn't learned.
 */
export function readHomeInput(text: string, cities: KnownCity[]): HomeInput | undefined {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  const known = findKnownCity(t, cities);
  if (known) return { kind: 'city', city: known };
  const n = normalizeName(t);
  const words = n.split(' ').filter(Boolean);
  const world = WORLD.find(w => !cities.some(c => namesCity(w.name, cityNames(c))) && w.names.some(name => mentions(n, normalizeName(name))));
  if (world) return { kind: 'learn', name: world.name };
  if (t.includes('?') || ASKING.has(words[0] ?? '') || words.length > 5) return { kind: 'ask', text: t };
  const mentioned = cities.find(c => cityNames(c).some(k => mentions(n, k)));
  if (mentioned) return { kind: 'city', city: mentioned };
  if (words.some(w => VAGUE.has(w))) return { kind: 'vague' };
  return { kind: 'learn', name: displayCityName(t) };
}

/**
 * What to run on a Mac that is online to prepare a city's pack (scripts/prepare-pack.mjs takes the
 * pack's folder name). The script prepares Seville today; a new city's pack starts as a folder
 * under app/src/pack with its destination.json and places.json.
 */
export function prepareCommand(city: string): string {
  const slug = normalizeName(displayCityName(city))
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
    .replace(/ +/g, '-');
  return `node scripts/prepare-pack.mjs --dest ${slug || '<city>'}`;
}

/** Which city an imported itinerary is for. */
export type TripCity = { kind: 'known'; city: KnownCity } | { kind: 'other'; name: string } | { kind: 'unknown' };

/**
 * Reads which city an imported trip is for from its places: stops matched to the pack's places
 * count twice, a known city's names once each; for other cities their names count twice and their
 * landmarks once. The pack's own city wins ties. A trip that matches nothing and names no city is
 * 'unknown'; one with no stops at all is taken as the pack's city.
 */
export function tripCity(trip: Trip, index: PackIndex, cities: KnownCity[]): TripCity {
  const here = cities.find(c => c.id === index.destination.id) ?? cities[0];
  if (!here) return { kind: 'unknown' };
  if (trip.stops.length === 0) return { kind: 'known', city: here };
  const text = normalizeName([trip.description ?? '', trip.base?.name ?? '', ...trip.stops.flatMap(s => [s.title ?? '', s.note ?? ''])].join('\n'));
  const matched = trip.stops.filter(s => s.placeId && index.place(s.placeId)).length;
  const score = (c: KnownCity) => (c === here ? matched * 2 : 0) + countMentions(text, cityNames(c));
  const known = cities.map(c => ({ city: c, score: score(c) })).sort((a, b) => b.score - a.score || (a.city === here ? -1 : b.city === here ? 1 : 0))[0];
  const isKnown = (w: (typeof WORLD)[number]) => cities.some(c => namesCity(w.name, cityNames(c)));
  const other = WORLD.filter(w => !isKnown(w))
    .map(w => ({ name: w.name, score: countMentions(text, w.names) * 2 + countMentions(text, w.landmarks) }))
    .sort((a, b) => b.score - a.score)[0];
  if (known && known.score > 0 && known.score >= (other?.score ?? 0)) return { kind: 'known', city: known.city };
  if (other && other.score > 0) return { kind: 'other', name: other.name };
  return { kind: 'unknown' };
}

const styles = StyleSheet.create({
  stack: { gap: 12 },
  shadow: { borderRadius: dusk.radius.card, shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 10 } },
  card: { flex: 1, borderRadius: dusk.radius.card, overflow: 'hidden', backgroundColor: dusk.color.raised },
  rim: { ...StyleSheet.absoluteFillObject, borderRadius: dusk.radius.card, borderWidth: StyleSheet.hairlineWidth },
  top: { position: 'absolute', top: 14, left: 14, right: 14, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  topLeft: { flexShrink: 1, alignItems: 'flex-start', gap: 7 },
  pill: { height: 28, justifyContent: 'center', paddingHorizontal: 12 },
  pillText: { ...font('700'), fontSize: 11.5 },
  // Small type straight on the photo: a deeper shadow than onGlass's, so it reads over busy façades.
  line: { ...font('600'), fontSize: 11.5, lineHeight: 15, color: dusk.color.textSoft, marginLeft: 4, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4 },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  local: { ...font('600'), fontSize: 13, color: dusk.color.textSoft },
  open: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
});
