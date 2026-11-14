import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DefaultCompanion } from '../core/companion';
import { distanceMeters } from '../core/geo';
import type { PackIndex } from '../core/pack';
import { SentenceChunker } from '../core/sentences';
import { parseHHMM, shiftClock, formatHHMM } from '../core/time';
import { sortStops, tripDay } from '../core/trip';
import type { Clock, GeoPoint, Lang, Recommendation, Situation, Trip } from '../core/types';
import type { Runtime } from '../services/runtime';
import * as storage from '../services/storage';

export interface ChatLine {
  id: string;
  who: 'you' | 'buddy';
  text: string;
  pending?: boolean;
  error?: boolean;
}

let lineCounter = 0;
const lineId = () => `l${++lineCounter}`;

/** Where the demo starts: the first forecast day at 10:00, in the city centre. */
function initialSituation(index: PackIndex): Situation {
  const first = index.pack.forecast.hours[0]?.time.slice(0, 10) ?? '2026-11-15';
  return { clock: { date: first, minute: 10 * 60 }, location: index.destination.center, locationLabel: 'the city centre', visited: [] };
}

function labelFor(index: PackIndex, point: GeoPoint): string {
  const [near] = index.nearest(point, 1);
  return near && near.meters < 400 ? near.place.name : 'the map point you chose';
}

/**
 * All app state and actions. Screens read from here; nothing else talks to
 * the companion, the model or the audio helper.
 */
export function useBuddy(rt: Runtime, index: PackIndex) {
  const [trip, setTripState] = useState<Trip | undefined>();
  const [tripIsNew, setTripIsNew] = useState(false);
  const [situation, setSituation] = useState<Situation>(() => initialSituation(index));
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [recsThinking, setRecsThinking] = useState(false);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [partial, setPartial] = useState('');
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [focusId, setFocusId] = useState<string>();
  const [mode, setMode] = useState<'home' | 'translator'>('home');

  // The companion reads the latest state through refs, so it never sees a stale trip.
  const tripRef = useRef(trip);
  const sitRef = useRef(situation);
  tripRef.current = trip;
  sitRef.current = situation;

  const setTrip = useCallback(async (next: Trip | undefined) => {
    setTripState(next);
    tripRef.current = next;
    if (next?.base?.point) {
      setSituation(s => (s.locationLabel === 'the city centre' ? { ...s, location: next.base!.point!, locationLabel: next.base!.name } : s));
    }
    await storage.saveTrip(next);
  }, []);

  const companion = useMemo(
    () =>
      new DefaultCompanion(rt.llm, index, {
        trip: () => tripRef.current,
        situation: () => sitRef.current,
        saveTrip: async t => {
          await setTrip(t);
          setTripIsNew(true);
        },
      }),
    [rt.llm, index, setTrip],
  );

  // Restore the saved trip and visited places.
  useEffect(() => {
    storage.loadTrip().then(t => t && setTripState(t)).catch(() => {});
    storage.loadVisited().then(v => setSituation(s => ({ ...s, visited: v }))).catch(() => {});
  }, []);

  // --- Voice output: one sentence at a time, microphone muted while speaking.
  // speechGen goes up on every stop, so sentences queued before a stop are dropped.
  const speechQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingSpeech = useRef(0);
  const speechGen = useRef(0);
  const say = useCallback(
    (text: string, lang: Lang = 'en') => {
      if (!text.trim()) return;
      const gen = speechGen.current;
      pendingSpeech.current++;
      setSpeaking(true);
      rt.audio.setMuted(true);
      speechQueue.current = speechQueue.current
        .then(() => (gen === speechGen.current ? rt.audio.speak(text, lang) : undefined))
        .catch(() => {})
        .finally(() => {
          if (gen !== speechGen.current) return; // cancelled by stopSpeaking
          if (--pendingSpeech.current === 0) {
            setSpeaking(false);
            rt.audio.setMuted(false);
          }
        });
    },
    [rt.audio],
  );
  const stopSpeaking = useCallback(() => {
    speechGen.current++;
    pendingSpeech.current = 0;
    rt.audio.stopSpeaking();
    rt.audio.setMuted(false); // sent before talk()'s listen.start
    setSpeaking(false);
  }, [rt.audio]);

  // --- Sending text (typed, or heard by the microphone) to the companion.
  const send = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t) return;
      const replyId = lineId();
      setChat(c => [...c, { id: lineId(), who: 'you', text: t }, { id: replyId, who: 'buddy', text: '', pending: true }]);
      setBusy(true);
      const chunker = new SentenceChunker();
      let streamed = '';
      // If the user stops the voice mid-reply, the rest of this reply stays silent.
      const replyGen = speechGen.current;
      const speak = (s: string, lang?: Lang) => {
        if (replyGen === speechGen.current) say(s, lang);
      };
      const update = (patch: Partial<ChatLine>) => setChat(c => c.map(l => (l.id === replyId ? { ...l, ...patch } : l)));
      await companion.handle(t, ev => {
        switch (ev.type) {
          case 'status':
            setStatus(ev.text);
            break;
          case 'token':
            streamed += ev.text;
            update({ text: streamed });
            chunker.push(ev.text).forEach(s => speak(s, ev.lang));
            break;
          case 'done':
            if (streamed) chunker.flush().forEach(s => speak(s, ev.lang));
            else speak(ev.text, ev.lang);
            update({ text: ev.text || streamed, pending: false });
            break;
          case 'recommendations':
            setRecs(ev.items);
            break;
          case 'trip':
            break; // saved through the companion context
          case 'focus':
            setFocusId(ev.placeId);
            break;
          case 'translator':
            setMode('translator');
            break;
          case 'error':
            update({ text: `Something went wrong: ${ev.text}`, pending: false, error: true });
            break;
        }
      });
      setStatus(undefined);
      setBusy(false);
    },
    [companion, say],
  );

  // --- The microphone button.
  const talk = useCallback(async () => {
    if (listening) {
      rt.audio.stopListening();
      return;
    }
    stopSpeaking();
    setListening(true);
    setPartial('');
    try {
      const heard = await rt.audio.listen(setPartial, 'en');
      setPartial('');
      setListening(false);
      if (heard.text.trim()) await send(heard.text);
    } catch (e) {
      setListening(false);
      setPartial('');
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }, [listening, rt.audio, send, stopSpeaking]);

  // --- Recommendations refresh whenever the trip or the situation changes.
  const refineToken = useRef(0);
  useEffect(() => {
    setRecs(companion.recommender.quick(trip, situation));
    const token = ++refineToken.current;
    const timer = setTimeout(async () => {
      setRecsThinking(true);
      const refined = await companion.recommender.refine(trip, situation);
      if (token === refineToken.current) setRecs(refined);
      if (token === refineToken.current) setRecsThinking(false);
    }, 700);
    return () => clearTimeout(timer);
  }, [companion, trip, situation]);

  // --- Situation controls.
  const setClock = useCallback((clock: Clock) => setSituation(s => ({ ...s, clock })), []);
  const shiftMinutes = useCallback((m: number) => setSituation(s => ({ ...s, clock: shiftClock(s.clock, m) })), []);
  const setLocation = useCallback(
    (point: GeoPoint, label?: string) => setSituation(s => ({ ...s, location: point, locationLabel: label ?? labelFor(index, point) })),
    [index],
  );
  const setLocationByName = useCallback(
    (text: string) => {
      const place = index.findPlace(text);
      if (place) setLocation(place.point, place.name);
      return !!place;
    },
    [index, setLocation],
  );

  // --- Itinerary actions.
  const addToTrip = useCallback(
    async (placeId: string) => {
      const place = index.place(placeId);
      if (!place) return;
      const sit = sitRef.current;
      const base: Trip = tripRef.current ?? { startDate: sit.clock.date, days: 1, interests: [], stops: [], description: '' };
      const day = tripDay(base, sit.clock.date) ?? 1;
      const start = formatHHMM(Math.ceil(sit.clock.minute / 15) * 15);
      const stop = { id: `stop-${Date.now().toString(36)}`, title: place.name, placeId, day, start, durationMinutes: place.visitMinutes, fixed: false };
      await setTrip({ ...base, stops: sortStops([...base.stops, stop]) });
    },
    [index, setTrip],
  );
  const removeStop = useCallback(async (id: string) => {
    const t = tripRef.current;
    if (t) await setTrip({ ...t, stops: t.stops.filter(s => s.id !== id) });
  }, [setTrip]);
  const markVisited = useCallback((placeId: string) => {
    setSituation(s => {
      const visited = [...new Set([...s.visited, placeId])];
      storage.saveVisited(visited).catch(() => {});
      return { ...s, visited };
    });
  }, []);
  const clearTrip = useCallback(async () => {
    await setTrip(undefined);
    setTripIsNew(false);
    setSituation(s => ({ ...s, visited: [] }));
    storage.saveVisited([]).catch(() => {});
  }, [setTrip]);

  /** Distance from "you" to a place, for the cards. */
  const metersTo = useCallback((point: GeoPoint) => distanceMeters(situation.location, point), [situation.location]);

  return {
    index,
    runtime: rt,
    companion,
    trip,
    tripIsNew,
    confirmTrip: () => setTripIsNew(false),
    situation,
    recs,
    recsThinking,
    chat,
    partial,
    listening,
    speaking,
    busy,
    status,
    focusId,
    setFocusId,
    mode,
    setMode,
    send,
    talk,
    say,
    stopSpeaking,
    setClock,
    shiftMinutes,
    setLocation,
    setLocationByName,
    addToTrip,
    removeStop,
    markVisited,
    clearTrip,
    metersTo,
    parseHHMM,
  };
}

export type Buddy = ReturnType<typeof useBuddy>;
