import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { formatHHMM, openState } from '../../core/time';
import type { Place } from '../../core/types';
import { CATEGORY_LABEL, directions } from '../dusk/format';
import { Glass, GlassButton, GlassIconButton, OfflineChip, onGlass } from '../dusk/Glass';
import { CloseIcon, MapIcon, WaveIcon } from '../dusk/Icons';
import { MicOrb } from '../dusk/Nav';
import { PhotoFade, PlacePhoto } from '../dusk/Photos';
import { dusk, font, ground } from '../dusk/tokens';
import type { ChatLine } from '../useBuddy';
import type { ScreenProps } from './types';

// AntPlace: one place. Its pack photo on top fading into the ground, the name, how far it is
// and whether it is open, the guide card (the latest answer about it, or a fact from the pack),
// and Add to day · Map · Ask. No tab bar here: the close orb goes back to Now.

const W = dusk.layout.phoneWidth;
const PHOTO_H = dusk.layout.placeHeroHeight; // 470
const CONTENT_TOP = 366;
const BOTTOM = 34;
const BTN = dusk.size.button; // 54
const CLOSE = 42;
/** About the Offline chip's width, so the pill never runs under it. */
const OFFLINE_W = 80;

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

export function PlaceScreen({ b, nav }: ScreenProps) {
  const { width } = useWindowDimensions();
  const sx = width / W;

  const place: Place | undefined = (nav.placeId ? b.index.place(nav.placeId) : undefined) ?? (b.recs[0] ? b.index.place(b.recs[0].placeId) : undefined);

  // Nothing to show: back to Now.
  useEffect(() => {
    if (!place) nav.go('now');
  }, [place, nav]);

  // The chat length when the user asked from this screen: anything from there on is about this place.
  const [askedFrom, setAskedFrom] = useState<number>();

  if (!place) return <View style={styles.root} />;

  const { clock, location } = b.situation;
  const city = b.index.destination.name.toUpperCase();

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

  // The guide card: the latest exchange if it is about this place (or was asked here), else a fact.
  const ex = lastExchange(b.chat);
  const askedHere = askedFrom !== undefined && ex !== undefined && ex.index >= askedFrom;
  const aboutPlace = ex !== undefined && (askedHere || mentions(ex.question.text, place) || (!!ex.answer && mentions(ex.answer.text, place)));
  const listeningHere = askedFrom !== undefined && b.listening && !askedHere;
  const fact = b.index.facts(place.id)[0];

  const answerText = (a?: ChatLine) => (a ? a.text || (a.pending ? '…' : '') : b.busy ? '…' : '');

  const ask = () => {
    if (b.listening) {
      b.talk(); // tap again to stop
      return;
    }
    setAskedFrom(b.chat.length);
    if (b.runtime.audio.info.hasMicrophone) b.talk();
    else if (!b.busy) b.send(`Tell me about ${place.name}`);
  };


  const showMap = () => {
    b.setFocusId(place.id);
    nav.go('map');
  };

  const label = (speaking: boolean) => (
    <View style={styles.labelRow}>
      {speaking && <WaveIcon size={14} />}
      <Text style={[styles.label, font('700')]}>{speaking ? `SPEAKING · FROM YOUR ${city} GUIDE` : `FROM YOUR ${city} GUIDE`}</Text>
    </View>
  );

  let card: React.ReactNode;
  if (listeningHere) {
    card = (
      <>
        <Text style={[styles.asked, font('500')]}>
          You asked: <Text style={[styles.askedQ, font('600')]}>{b.partial ? `“${b.partial}”` : 'Listening…'}</Text>
        </Text>
        {label(false)}
      </>
    );
  } else if (ex && aboutPlace) {
    const text = answerText(ex.answer);
    card = (
      <>
        <Text style={[styles.asked, font('500')]}>
          You asked: <Text style={[styles.askedQ, font('600')]}>{`“${ex.question.text}”`}</Text>
        </Text>
        {!!text && (
          <Text style={[styles.answer, font('500'), ex.answer?.pending && !ex.answer.text ? { color: dusk.color.pending } : null]} accessibilityLiveRegion="polite">
            {text}
          </Text>
        )}
        {label(b.speaking)}
      </>
    );
  } else if (fact) {
    card = (
      <>
        <Text style={[styles.askedQ, font('600'), { fontSize: 13 }]}>{fact.title}</Text>
        <Text style={[styles.answer, font('500')]}>{fact.body}</Text>
        {label(false)}
      </>
    );
  } else {
    card = (
      <>
        <Text style={[styles.asked, font('500')]}>{`Ask your buddy about ${place.name}: tap the mic.`}</Text>
        {label(false)}
      </>
    );
  }

  return (
    <View style={styles.root}>
      <ScrollView style={StyleSheet.absoluteFill} contentContainerStyle={{ paddingTop: CONTENT_TOP, paddingBottom: BOTTOM + BTN + 28 }} showsVerticalScrollIndicator={false}>
        {/* Top 470: the pack photo, fading into the ground (mockup gradient). */}
        <View style={styles.photo} pointerEvents="none">
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

        <Glass kind="clear" radius={26} style={[styles.card, { marginHorizontal: 14 * sx }]}>
          <View accessibilityLabel="Guide answer" style={{ gap: 8 }}>
            {card}
          </View>
        </Glass>
      </ScrollView>

      {/* Top row: what this place is to you, and the close orb back to Now. */}
      <Glass kind="clear" radius={999} style={[styles.pill, { left: 18 * sx, maxWidth: width - 18 * sx * 2 - CLOSE - OFFLINE_W - 16 }]}>
        <Text style={[onGlass, font('700'), { fontSize: 12 }]} numberOfLines={1}>
          {pill}
        </Text>
      </Glass>
      <OfflineChip style={[styles.offline, { right: 18 * sx + CLOSE + 8 }]} />
      <GlassIconButton accessibilityLabel="Close" onPress={() => nav.go('now')} size={CLOSE} style={[styles.close, { right: 18 * sx }]}>
        <CloseIcon size={14} />
      </GlassIconButton>

      {/* Bottom row over a fade so the card scrolls away under it. */}
      <View style={styles.bottomFade} pointerEvents="none">
        <PhotoFade stops={[[0, 0], [0.45, 0.85], [1, 1]]} />
      </View>
      <View style={[styles.actions, { left: 22 * sx, right: 22 * sx }]}>
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
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: dusk.color.ground },
  photo: { position: 'absolute', left: 0, right: 0, top: 0, height: PHOTO_H },
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
  card: { marginTop: 28, padding: 16 },
  asked: { color: dusk.color.text2, fontSize: 13, lineHeight: 18 },
  askedQ: { color: dusk.color.text },
  answer: { color: dusk.color.text, fontSize: 15, lineHeight: 22 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { color: dusk.color.text2, fontSize: 11, letterSpacing: 0.66 },
  pill: { position: 'absolute', top: 61, paddingVertical: 8, paddingHorizontal: 13 },
  close: { position: 'absolute', top: 56 },
  // The Offline chip (28 tall) centred on the 42 px close orb.
  offline: { position: 'absolute', top: 56 + (CLOSE - 28) / 2 },
  bottomFade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: BOTTOM + BTN + 40 },
  actions: { position: 'absolute', bottom: BOTTOM, flexDirection: 'row', alignItems: 'center', gap: 10 },
});
