import React, { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatHHMM, openState } from '../../core/time';
import type { Fact, Place } from '../../core/types';
import { AmbientBackdrop, MeltingPhoto } from '../dusk/AmbientBackdrop';
import { CATEGORY_LABEL, directions } from '../dusk/format';
import { axPress, Glass, GlassButton, GlassIconButton, OfflineChip, onGlass } from '../dusk/Glass';
import { CloseIcon, MapIcon, WaveIcon } from '../dusk/Icons';
import { MicOrb } from '../dusk/Nav';
import { PhotoFade, PlacePhoto, placePhotoSource } from '../dusk/Photos';
import { dusk, font, ground, white } from '../dusk/tokens';
import type { ChatLine } from '../useBuddy';
import type { ScreenProps } from './types';
import { useScreenSize } from '../dusk/Screen';
import { isDeclined, levelFor, NEARBY_QUESTION, UNSURE_LINE, useLevel, useMood, WilsonFace, type WilsonMood } from './WilsonLive';

// AntPlace: one place. Its pack photo on top, sharp, melting into a blurred and darkened copy of
// itself that fills the window (AmbientBackdrop, as on Now), so the glass has colour behind it
// instead of flat black. Then the name, how far it is and whether it is open, the summary, then the
// guide card, headed by Wilson (32) and "Wilson · from your <city> guide": the question asked about
// this place and his streamed answer (or, when the guide declined it, "My guide doesn't cover that
// one. Want something nearby instead?"), every fact the pack has about it, and questions to ask
// when the pack has few. All of that scrolls behind Add to day · Map · Ask (which float on a soft
// shade), and the card grows to meet them, so the page never ends in an empty band. No tab bar
// here: the close orb goes back to Now.

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
/** The soft shade the buttons float on rises this far above them. */
const EDGE_FADE = 44;
/** Space between the end of the card and the buttons. */
const ACTIONS_GAP = 12;
/** Over the sharp photo: dark behind the pill and orb at the top, and a little behind the name. */
const HERO_SHADE: [number, number][] = [
  [0, 0.4],
  [0.2, 0],
  [0.55, 0],
  [0.82, 0.28],
  [1, 0],
];
/**
 * Under the buttons: clear at the top, then dark enough that facts scrolled under the row fade
 * away instead of fighting the buttons (and their glass, which shows what is behind it).
 */
const ACTIONS_SHADE: [number, number][] = [
  [0, 0],
  [0.3, 0.55],
  [0.6, 0.86],
  [1, 0.94],
];
/**
 * Once the page scrolls: behind the pill and close orb, so text never runs under them. Nearly
 * solid down to just under the orb (the clear glass chips showed the page's text through them).
 */
const TOP_SHADE: [number, number][] = [
  [0, 0.94],
  [0.72, 0.88],
  [1, 0],
];
/** The fallback scene tile (no photo, no backdrop) still fades into the ground. */
const TILE_FADE: [number, number][] = [
  [0, 0.35],
  [0.2, 0],
  [0.52, 0],
  [0.82, 0.8],
  [1, 1],
];
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

/**
 * "Photo: Ingo Mehling · CC BY-SA 4.0 · Wikimedia Commons": the pack keeps each photo's author and
 * licence (CC BY and BY-SA ask for the credit). Commons' author field is sometimes a sentence; this
 * keeps the name.
 */
function photoCredit(place: Place): string | undefined {
  const ref = place.photo;
  if (!ref) return undefined;
  let who = (typeof ref.credit === 'string' ? ref.credit : '')
    .trim()
    .replace(/^No machine-readable author provided\.\s*(.+?)\s+assumed\b.*$/i, '$1')
    .replace(/^Taken by the uploader,\s*/i, '')
    .replace(/\bw:[a-z-]+:(?:Usuario|User):/gi, '');
  if (/^unknown author$/i.test(who)) who = '';
  const from = typeof ref.source === 'string' && /commons\.wikimedia\.org/i.test(ref.source) ? 'Wikimedia Commons' : undefined;
  return [who ? `Photo: ${who}` : 'Photo', ref.license, from].filter(Boolean).join(' · ');
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
  // Wilson heads the guide card: his mood (happy when this place is added to the day) and his level.
  const wilsonNow = useMood(b);
  const wilsonLevel = useLevel(b);

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
  // The guide declined the question: he says so, and offers something nearby instead.
  const declined = !!answer && !answer.pending && isDeclined(answer.text);
  const askNearby = () => {
    if (!canAsk) return;
    setAskedFrom(b.chat.length);
    b.send(NEARBY_QUESTION);
  };
  // His face: this place's exchange first; otherwise his own mood when he is happy, waking, or
  // listening without a tap here ("Wilson, …", or the wait for a follow-up).
  const wilson: WilsonMood = listeningHere
    ? 'listening'
    : speakingHere
      ? 'speaking'
      : exchange && answerPending && b.busy
        ? 'thinking'
        : declined
          ? 'unsure'
          : wilsonNow === 'happy' || wilsonNow === 'waking' || wilsonNow === 'listening'
            ? wilsonNow
            : 'idle';

  // The place's photo: sharp on top, and blurred behind the whole page. Without one, the drawn
  // scene tile fades into the plain ground as before.
  const photo = placePhotoSource(place.id);
  const photoLine = photoCredit(place);
  // The buttons' row: 12 above, the 54 px buttons, the bottom inset. The page scrolls behind it.
  const actionsH = ACTIONS_GAP + BTN + bottom;

  return (
    <View style={styles.root}>
      <AmbientBackdrop source={photo} strength={0.7} />
      <Animated.ScrollView
        style={StyleSheet.absoluteFill}
        contentContainerStyle={{ flexGrow: 1, paddingTop: contentTop, paddingBottom: actionsH + ACTIONS_GAP }}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: false })}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}>
        {/* Top 470: the pack photo, melting into the blurred backdrop (or the scene tile into the ground). */}
        <View style={[styles.photo, { height: photoH }]} pointerEvents="none">
          {photo !== undefined ? (
            <>
              <MeltingPhoto source={photo} melt={Math.round(photoH * 0.42)} />
              <PhotoFade stops={HERO_SHADE} />
            </>
          ) : (
            <>
              <PlacePhoto place={place} style={StyleSheet.absoluteFill} />
              <PhotoFade stops={TILE_FADE} />
            </>
          )}
        </View>

        <View style={{ marginHorizontal: 22 * sx, gap: 10 }}>
          <Text style={[styles.title, font('700')]} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.75} accessibilityRole="header">
            {place.name}
          </Text>
          <Text style={[styles.distance, font('700')]}>{distanceLine}</Text>
          <Text style={[styles.summary, font('500')]}>{place.summary}</Text>
        </View>

        <Glass kind="clear" radius={26} style={[styles.card, { marginHorizontal: 14 * sx, marginTop: Math.round(24 * sy) }]}>
          <View style={styles.cardInner} accessibilityLabel={`Wilson · from your ${city} guide`}>
            <View style={styles.labelRow}>
              <WilsonFace size={32} mood={wilson} level={levelFor(wilson, wilsonLevel)} decorative />
              <Text style={[styles.wilsonLabel, font('600')]} numberOfLines={2}>
                {`Wilson · from your ${city} guide`}
              </Text>
              {speakingHere && (
                <View style={styles.speaking}>
                  <WaveIcon size={12} />
                  <Text style={[styles.label, font('700')]}>SPEAKING</Text>
                </View>
              )}
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
                {declined ? (
                  <>
                    <Text style={[styles.answer, font('500')]} accessibilityLiveRegion="polite">
                      {UNSURE_LINE}
                    </Text>
                    <View style={styles.chips}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Ask Wilson for something nearby instead"
                        accessibilityState={{ disabled: !canAsk }}
                        disabled={!canAsk}
                        onPress={askNearby}
                        {...axPress(askNearby, !canAsk)}
                        style={({ pressed }) => ({ opacity: !canAsk ? 0.45 : pressed ? 0.8 : 1 })}>
                        <Glass kind="prominent" radius={dusk.radius.pill} style={styles.chip}>
                          <Text style={[onGlass, font('700'), styles.chipText]}>Yes, something nearby</Text>
                        </Glass>
                      </Pressable>
                    </View>
                  </>
                ) : (
                  !!answerText && (
                    <Text style={[styles.answer, font('500'), answerPending ? styles.pending : null]} accessibilityLiveRegion="polite">
                      {answerText}
                    </Text>
                  )
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
                  {facts.length === 0 ? `My guide has no notes on ${place.name} yet. Ask me:` : 'Ask me:'}
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
        {/* The photo at the top is someone's work: its author and licence, as the pack records them. */}
        {photo !== undefined && !!photoLine ? (
          <Text style={[styles.credit, styles.photoCredit, font('500'), { marginHorizontal: 22 * sx }]} numberOfLines={2}>
            {photoLine}
          </Text>
        ) : null}
      </Animated.ScrollView>

      {/* Bottom row, floating over the page on a soft shade (it never ends in a hard edge). */}
      <View pointerEvents="box-none" style={[styles.actions, { height: actionsH, paddingLeft: 22 * sx, paddingRight: 22 * sx, paddingBottom: bottom }]}>
        <View style={[styles.edge, { height: actionsH + EDGE_FADE }]} pointerEvents="none">
          <PhotoFade stops={ACTIONS_SHADE} />
        </View>
        {/* Once added it is a settled state, not a faded button: a see-through (0.45) button let
            the facts scrolled under it show through its label. */}
        <GlassButton
          label={inDay ? '✓ In your day' : 'Add to day'}
          disabled={inDay}
          accessibilityLabel={inDay ? `${place.name} is in your day` : `Add ${place.name} to your day`}
          onPress={() => b.addToTrip(place.id)}
          style={inDay ? styles.settled : styles.grow}
          textStyle={inDay ? styles.settledText : undefined}
        />
        <GlassIconButton accessibilityLabel="Show on map" onPress={showMap} size={BTN} kind="clear">
          <MapIcon size={20} />
        </GlassIconButton>
        <MicOrb listening={b.listening} onPress={ask} size={BTN} />
      </View>

      {/* Top row: what this place is to you, and the close orb back to Now. */}
      <Animated.View style={[styles.topFade, { opacity: topFade }]} pointerEvents="none">
        <PhotoFade stops={TOP_SHADE} />
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
  photo: { position: 'absolute', left: 0, right: 0, top: 0 },
  // A tight shadow: macOS clips a wide text-shadow blur into a visible box over the photo.
  title: {
    color: dusk.color.text,
    fontSize: 40,
    lineHeight: 44,
    letterSpacing: -0.9,
    textShadowColor: ground(0.55),
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 5,
  },
  distance: { color: dusk.color.direction, fontSize: 13 },
  summary: { color: dusk.color.textSoft, fontSize: 14, lineHeight: 21 },
  // Grows to the buttons when the content is short.
  card: { flexGrow: 1 },
  cardInner: { padding: 16, gap: 14 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  label: { color: dusk.color.text2, fontSize: 11, letterSpacing: 0.66 },
  wilsonLabel: { flexShrink: 1, color: dusk.color.textSoft, fontSize: 13, lineHeight: 17 },
  speaking: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 6 },
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
  photoCredit: { marginTop: 12 },
  questions: { gap: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { height: 34, justifyContent: 'center', paddingHorizontal: 14 },
  chipText: { fontSize: 13 },
  actions: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: ACTIONS_GAP },
  edge: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  grow: { flex: 1 },
  settled: { flex: 1, opacity: 1 },
  settledText: { color: dusk.color.text2 },
  topFade: { position: 'absolute', left: 0, right: 0, top: 0, height: TOP + CLOSE + 40 },
  pill: { position: 'absolute', top: TOP + 5, paddingVertical: 8, paddingHorizontal: 13 },
  close: { position: 'absolute', top: TOP },
  // The Offline chip (28 tall) centred on the 42 px close orb.
  offline: { position: 'absolute', top: TOP + (CLOSE - 28) / 2 },
});
