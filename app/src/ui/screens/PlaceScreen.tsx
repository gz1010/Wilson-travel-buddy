import React, { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatHHMM, openState } from '../../core/time';
import type { Fact, Place } from '../../core/types';
import { CATEGORY_LABEL, directions } from '../dusk/format';
import { axPress, Glass, GlassButton, GlassIconButton, OfflineChip, onGlass } from '../dusk/Glass';
import { CloseIcon, MapIcon, WaveIcon } from '../dusk/Icons';
import { MicOrb } from '../dusk/Nav';
import { PhotoFade, PlacePhoto } from '../dusk/Photos';
import { dusk, font, ground, white } from '../dusk/tokens';
import type { ChatLine } from '../useBuddy';
import type { ScreenProps } from './types';
import { useScreenSize } from '../dusk/Screen';

// AntPlace: one place. Its pack photo on top fading into the ground, the name, how far it is
// and whether it is open, the summary, then the "From your <city> guide" card: the question asked
// about this place and its streamed answer, every fact the pack has about it, and questions to ask
// when the pack has few. All of that scrolls in the space above Add to day · Map · Ask, and the card
// grows to meet them, so the page never ends in an empty band. No tab bar here: the close orb goes
// back to Now.

const W = dusk.layout.phoneWidth;
const H = dusk.layout.phoneHeight;
const PHOTO_H = dusk.layout.placeHeroHeight; // 470
const CONTENT_TOP = 366;
const BOTTOM = 34;
const BTN = dusk.size.button; // 54
const CLOSE = 42;
const TOP = 56;
/** About the Offline chip's width, so the pill never runs under it. */
const OFFLINE_W = 80;
/** The soft edge where the scrolling card meets the buttons. */
const EDGE_FADE = 22;
/** With fewer facts than this, the card offers questions to ask. */
const FEW_FACTS = 3;
const QUESTIONS = ["What's special here?", 'When is it quietest?', 'Is it worth it in the rain?'];

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** True when the text names the place (its name, local name or an alias). */
function mentions(text: string, place: Place): boolean {
  const t = norm(text);
  return [place.name, place.localName, ...(place.aliases ?? [])].some(n => !!n && n.trim().length > 2 && t.includes(norm(n)));
}

/** The latest question and the buddy line that answers it. */
function lastExchange(chat: ChatLine[]): { index: number; question: ChatLine; answer?: ChatLine } | undefined {
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i].who === 'you') {
      const next = chat[i + 1];
      return { index: i, question: chat[i], answer: next && next.who === 'buddy' ? next : undefined };
    }
  }
  return undefined;
}

/**
 * A question chip sends "<q> (about <name>)"; the card shows just the question. Greedy, so a name
 * with its own brackets ("Las Setas (Metropol Parasol)") is cut too.
 */
const shownQuestion = (text: string) => text.replace(/\s*\(about .+\)\s*$/, '');

/**
 * "Wikipedia · CC BY-SA 4.0" for a fact that names where it came from. Facts written for the pack
 * have neither field. Read loosely: source and license are optional on Fact.
 */
function attribution(fact: Fact): string | undefined {
  const { source, license } = fact as Fact & { source?: string; license?: string };
  let from: string | undefined;
  if (typeof source === 'string' && source) {
    const wiki = /^https?:\/\/([a-z-]+)\.(?:m\.)?wikipedia\.org\//i.exec(source);
    const host = /^https?:\/\/(?:www\.)?([^/?#]+)/i.exec(source);
    from = wiki ? (wiki[1].toLowerCase() === 'en' ? 'Wikipedia' : `Wikipedia (${wiki[1].toLowerCase()})`) : host ? host[1] : undefined;
  }
  const lic = typeof license === 'string' && license ? license : undefined;
  if (!from && !lic) return undefined;
  return [from && `From ${from}`, lic].filter(Boolean).join(' · ');
}

export function PlaceScreen({ b, nav }: ScreenProps) {
  const { width, height } = useScreenSize();
  const sx = width / W;
  // Vertical rhythm follows the window height: the mockup at 844, tighter down to the 700 minimum.
  const sy = Math.min(1.1, Math.max(0.8, height / H));
  const photoH = Math.round(PHOTO_H * sy);
  const contentTop = Math.round(CONTENT_TOP * sy);
  const bottom = Math.round(BOTTOM * Math.min(1, sy));

  const place: Place | undefined = (nav.placeId ? b.index.place(nav.placeId) : undefined) ?? (b.recs[0] ? b.index.place(b.recs[0].placeId) : undefined);

  // Nothing to show: back to Now.
  useEffect(() => {
    if (!place) nav.go('now');
  }, [place, nav]);

  // The chat length when the user asked from this screen: anything from there on is about this place.
  const [askedFrom, setAskedFrom] = useState<number>();

  // Once the page scrolls, the top row gets a dark fade so text never runs under the pill and orb.
  const scrollY = useRef(new Animated.Value(0)).current;
  const topFade = scrollY.interpolate({ inputRange: [0, 90], outputRange: [0, 1], extrapolate: 'clamp' });

  if (!place) return <View style={styles.root} />;

  const { clock, location } = b.situation;
  const city = b.index.destination.name;

  // Top-left pill: the suggestion rank, or the category.
  const rank = b.recs.findIndex(r => r.placeId === place.id);
  const pill = rank >= 0 ? `Suggested for ${formatHHMM(clock.minute)} · #${rank + 1}` : CATEGORY_LABEL[place.category] ?? place.category;

  // "350 m north · 4 min walk · outdoor · open until 20:00"
  const dir = directions(location, place.point, b.metersTo(place.point));
  const inDay = !!b.trip?.stops.some(s => s.placeId === place.id);
  const open = openState(place.hours, clock);
  const openText = open.open
    ? open.closesAt
      ? `open until ${open.closesAt}`
      : open.unknown
        ? 'hours not in the guide'
        : 'always open'
    : open.opensAt
      ? `closed · opens ${open.opensAt}`
      : 'closed';
  const distanceLine = [
    dir.here ? 'You are here' : `${dir.distance} ${dir.word}`,
    `${dir.walk} min walk`,
    place.indoor ? 'indoor' : 'outdoor',
    openText,
  ].join(' · ');

  // The latest exchange, if it is about this place (or was asked here), goes at the top of the card.
  const ex = lastExchange(b.chat);
  const askedHere = askedFrom !== undefined && ex !== undefined && ex.index >= askedFrom;
  const aboutPlace = ex !== undefined && (askedHere || mentions(ex.question.text, place) || (!!ex.answer && mentions(ex.answer.text, place)));
  const listeningHere = askedFrom !== undefined && b.listening && !askedHere;
  const exchange = !listeningHere && aboutPlace ? ex : undefined;
  const speakingHere = b.speaking && !!exchange;

  const facts = b.index.facts(place.id);
  const few = facts.length < FEW_FACTS;
  const canAsk = !b.busy && !b.listening;

  const ask = () => {
    if (b.listening) {
      b.talk(); // tap again to stop
      return;
    }
    setAskedFrom(b.chat.length);
    if (b.runtime.audio.info.hasMicrophone) b.talk();
    else if (!b.busy) b.send(`Tell me about ${place.name}`);
  };

  const askQuestion = (q: string) => {
    if (!canAsk) return;
    setAskedFrom(b.chat.length);
    b.send(`${q} (about ${place.name})`);
  };

  const showMap = () => {
    b.setFocusId(place.id);
    nav.go('map');
  };

  const answer = exchange?.answer;
  const answerText = answer ? answer.text || (answer.pending ? '…' : '') : b.busy ? '…' : '';
  const answerPending = !answer || (!!answer.pending && !answer.text);

  return (
    <View style={styles.root}>
      <Animated.ScrollView
        style={styles.scroll}
        contentContainerStyle={{ flexGrow: 1, paddingTop: contentTop, paddingBottom: EDGE_FADE }}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: false })}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}>
        {/* Top 470: the pack photo, fading into the ground (mockup gradient). */}
        <View style={[styles.photo, { height: photoH }]} pointerEvents="none">
          <PlacePhoto place={place} style={StyleSheet.absoluteFill} />
          <PhotoFade stops={[[0, 0.35], [0.2, 0], [0.52, 0], [0.82, 0.8], [1, 1]]} />
        </View>

        <View style={{ marginHorizontal: 22 * sx, gap: 10 }}>
          <Text style={[styles.title, font('600')]} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.75} accessibilityRole="header">
            {place.name}
          </Text>
          <Text style={[styles.distance, font('700')]}>{distanceLine}</Text>
          <Text style={[styles.summary, font('500')]}>{place.summary}</Text>
        </View>

        <Glass kind="clear" radius={26} style={[styles.card, { marginHorizontal: 14 * sx, marginTop: Math.round(24 * sy) }]}>
          <View style={styles.cardInner} accessibilityLabel={`From your ${city} guide`}>
            <View style={styles.labelRow}>
              {speakingHere && <WaveIcon size={14} />}
              <Text style={[styles.label, font('700')]}>
                {speakingHere ? `SPEAKING · FROM YOUR ${city.toUpperCase()} GUIDE` : `FROM YOUR ${city.toUpperCase()} GUIDE`}
              </Text>
            </View>

            {/* What the traveller asked about this place, and the answer as it streams. */}
            {listeningHere ? (
              <Text style={[styles.asked, font('500')]}>
                You asked: <Text style={[styles.askedQ, font('600')]}>{b.partial ? `“${b.partial}”` : 'Listening…'}</Text>
              </Text>
            ) : exchange ? (
              <View style={styles.exchange}>
                <Text style={[styles.asked, font('500')]}>
                  You asked: <Text style={[styles.askedQ, font('600')]}>{`“${shownQuestion(exchange.question.text)}”`}</Text>
                </Text>
                {!!answerText && (
                  <Text style={[styles.answer, font('500'), answerPending ? styles.pending : null]} accessibilityLiveRegion="polite">
                    {answerText}
                  </Text>
                )}
              </View>
            ) : null}
            {/* Facts or question chips always follow, so the exchange always gets a divider. */}
            {(listeningHere || !!exchange) && <View style={styles.divider} />}

            {/* Every fact the pack has about this place. */}
            {facts.map(f => {
              const credit = attribution(f);
              return (
                <View key={f.id} style={styles.fact}>
                  <Text style={[styles.factTitle, font('700')]}>{f.title}</Text>
                  <Text style={[styles.factBody, font('500')]}>{f.body}</Text>
                  {!!credit && <Text style={[styles.credit, font('500')]}>{credit}</Text>}
                </View>
              );
            })}

            {/* Few or no facts: questions to ask instead. */}
            {few && (
              <View style={styles.questions}>
                <Text style={[styles.asked, font('500')]}>
                  {facts.length === 0 ? `The guide has no notes on ${place.name} yet. Ask your buddy:` : 'Ask your buddy:'}
                </Text>
                <View style={styles.chips}>
                  {QUESTIONS.map(q => (
                    <Pressable
                      key={q}
                      accessibilityRole="button"
                      accessibilityLabel={`Ask: ${q}`}
                      accessibilityState={{ disabled: !canAsk }}
                      disabled={!canAsk}
                      onPress={() => askQuestion(q)}
                      {...axPress(() => askQuestion(q), !canAsk)}
                      style={({ pressed }) => ({ opacity: !canAsk ? 0.45 : pressed ? 0.8 : 1 })}>
                      <Glass kind="clear" radius={dusk.radius.pill} style={styles.chip}>
                        <Text style={[onGlass, font('700'), styles.chipText]}>{q}</Text>
                      </Glass>
                    </Pressable>
                  ))}
                </View>
              </View>
            )}
          </View>
        </Glass>
      </Animated.ScrollView>

      {/* Bottom row, under the scroll area; the card fades into it. */}
      <View style={[styles.actions, { paddingLeft: 22 * sx, paddingRight: 22 * sx, paddingBottom: bottom }]}>
        <View style={styles.edge} pointerEvents="none">
          <PhotoFade stops={[[0, 0], [1, 1]]} />
        </View>
        <GlassButton
          label={inDay ? 'In your day' : 'Add to day'}
          disabled={inDay}
          accessibilityLabel={inDay ? `${place.name} is in your day` : `Add ${place.name} to your day`}
          onPress={() => b.addToTrip(place.id)}
          style={{ flex: 1 }}
        />
        <GlassIconButton accessibilityLabel="Show on map" onPress={showMap} size={BTN} kind="clear">
          <MapIcon size={20} />
        </GlassIconButton>
        <MicOrb listening={b.listening} onPress={ask} size={BTN} />
      </View>

      {/* Top row: what this place is to you, and the close orb back to Now. */}
      <Animated.View style={[styles.topFade, { opacity: topFade }]} pointerEvents="none">
        <PhotoFade stops={[[0, 1], [0.55, 0.85], [1, 0]]} />
      </Animated.View>
      <Glass kind="clear" radius={999} style={[styles.pill, { left: 18 * sx, maxWidth: width - 18 * sx * 2 - CLOSE - OFFLINE_W - 16 }]}>
        <Text style={[onGlass, font('700'), { fontSize: 12 }]} numberOfLines={1}>
          {pill}
        </Text>
      </Glass>
      <OfflineChip style={[styles.offline, { right: 18 * sx + CLOSE + 8 }]} />
      <GlassIconButton accessibilityLabel="Close" onPress={() => nav.go('now')} size={CLOSE} style={[styles.close, { right: 18 * sx }]}>
        <CloseIcon size={14} />
      </GlassIconButton>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: dusk.color.ground },
  scroll: { flex: 1 },
  photo: { position: 'absolute', left: 0, right: 0, top: 0 },
  title: {
    color: dusk.color.text,
    fontSize: 40,
    lineHeight: 42,
    letterSpacing: -1.6,
    textShadowColor: ground(0.5),
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 16,
  },
  distance: { color: dusk.color.direction, fontSize: 13 },
  summary: { color: dusk.color.textSoft, fontSize: 14, lineHeight: 21 },
  // Grows to the buttons when the content is short.
  card: { flexGrow: 1 },
  cardInner: { padding: 16, gap: 14 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { color: dusk.color.text2, fontSize: 11, letterSpacing: 0.66 },
  exchange: { gap: 8 },
  asked: { color: dusk.color.text2, fontSize: 13, lineHeight: 18 },
  askedQ: { color: dusk.color.text },
  answer: { color: dusk.color.text, fontSize: 15, lineHeight: 22 },
  pending: { color: dusk.color.pending },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: white(0.18) },
  fact: { gap: 4 },
  factTitle: { color: dusk.color.text, fontSize: 13, lineHeight: 18 },
  factBody: { color: dusk.color.textSoft, fontSize: 14, lineHeight: 20 },
  credit: { color: dusk.color.text2, fontSize: 11, lineHeight: 15, marginTop: 2 },
  questions: { gap: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { height: 34, justifyContent: 'center', paddingHorizontal: 14 },
  chipText: { fontSize: 13 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 12 },
  edge: { position: 'absolute', left: 0, right: 0, top: -EDGE_FADE, height: EDGE_FADE },
  topFade: { position: 'absolute', left: 0, right: 0, top: 0, height: TOP + CLOSE + 22 },
  pill: { position: 'absolute', top: TOP + 5, paddingVertical: 8, paddingHorizontal: 13 },
  close: { position: 'absolute', top: TOP },
  // The Offline chip (28 tall) centred on the 42 px close orb.
  offline: { position: 'absolute', top: TOP + (CLOSE - 28) / 2 },
});
