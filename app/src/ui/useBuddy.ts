import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DefaultCompanion, withStop } from '../core/companion';
import { distanceMeters, formatDistance } from '../core/geo';
import type { PackIndex } from '../core/pack';
import { SentenceChunker } from '../core/sentences';
import { parseHHMM, shiftClock } from '../core/time';
import type { Cited, Clock, GeoPoint, Lang, LocationFix, Recommendation, Situation, Trip } from '../core/types';
import type { Runtime } from '../services/runtime';
import * as storage from '../services/storage';

export interface ChatLine {
  id: string;
  who: 'you' | 'buddy';
  text: string;
  pending?: boolean;
  error?: boolean;
  /** A buddy answer's guide facts (the latest answer's are also b.cited). */
  cited?: Cited;
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
  /** True once the saved trip (if any) has been read from storage. */
  const [tripLoaded, setTripLoaded] = useState(false);
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
  // The place on screen, so "is it worth it?" knows what "it" is.
  const focusRef = useRef(focusId);
  focusRef.current = focusId;
  /** The guide facts behind the latest answer (R1's panel and Chat show them); cleared on each send. */
  const [cited, setCited] = useState<Cited | undefined>();

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
        focus: () => focusRef.current,
      }),
    [rt.llm, index, setTrip],
  );

  // Restore the saved trip and visited places.
  useEffect(() => {
    storage
      .loadTrip()
      .then(t => t && setTripState(t))
      .catch(() => {})
      .finally(() => setTripLoaded(true));
    storage.loadVisited().then(v => setSituation(s => ({ ...s, visited: v }))).catch(() => {});
  }, []);

  // --- Latency: from when the user stopped speaking (reported by the helper; it includes the
  // silence wait and the final transcription) to when the reply's voice is actually playing.
  const [latency, setLatency] = useState<{ ms: number; voice: boolean } | undefined>();

  // --- Voice output: one sentence at a time, microphone muted while speaking.
  // speechGen goes up on every stop, so sentences queued before a stop are dropped.
  const speechQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingSpeech = useRef(0);
  const speechGen = useRef(0);
  const say = useCallback(
    (text: string, lang: Lang = 'en', onStart?: () => void) => {
      if (!text.trim()) return;
      const gen = speechGen.current;
      pendingSpeech.current++;
      setSpeaking(true);
      rt.audio.setMuted(true);
      speechQueue.current = speechQueue.current
        .then(() => (gen === speechGen.current ? rt.audio.speak(text, lang, onStart) : undefined))
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
    async (text: string, heardAt?: number) => {
      const t = text.trim();
      if (!t) return;
      // Only this reply's first sentence measures latency.
      const startedAt = heardAt ?? Date.now();
      let measured = false;
      const onFirstAudio = () => {
        if (measured) return;
        measured = true;
        setLatency({ ms: Date.now() - startedAt, voice: heardAt !== undefined });
      };
      const replyId = lineId();
      setChat(c => [...c, { id: lineId(), who: 'you', text: t }, { id: replyId, who: 'buddy', text: '', pending: true }]);
      setCited(undefined);
      setBusy(true);
      const chunker = new SentenceChunker();
      let streamed = '';
      // If the user stops the voice mid-reply, the rest of this reply stays silent.
      const replyGen = speechGen.current;
      const speak = (s: string, lang?: Lang) => {
        if (replyGen === speechGen.current) say(s, lang, onFirstAudio);
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
            update({ text: ev.text || streamed, pending: false, cited: ev.cited });
            if (ev.cited) setCited(ev.cited);
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
      const heardAt = heard.endedAt ?? Date.now();
      setPartial('');
      setListening(false);
      if (heard.text.trim()) await send(heard.text, heardAt);
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
  /** Goes up whenever "you" move, so the startup locate never overrides a tap made meanwhile. */
  const locationGen = useRef(0);
  const setLocation = useCallback(
    (point: GeoPoint, label?: string) => {
      locationGen.current++;
      setSituation(s => ({ ...s, location: point, locationLabel: label ?? labelFor(index, point) }));
    },
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

  // --- Locating the Mac: macOS Location (through the helper), else the last fix saved, else
  // the traveller taps the map. locateNote says why it fell back (or why macOS's fix was unusable).
  const [locating, setLocating] = useState(false);
  const [locateNote, setLocateNote] = useState<string>();
  const locateDeps = useMemo<LocateDeps>(
    () => ({
      ask: onError => (typeof rt.audio.locate === 'function' ? rt.audio.locate(onError) : Promise.resolve(undefined)),
      loadFix: loadLastFix,
      saveFix: saveLastFix,
      now: () => Date.now(),
    }),
    [rt.audio],
  );
  /** Moves "you" to where macOS (or the last saved fix) says; undefined when neither can. */
  const locate = useCallback(
    async (onNote?: (note: string) => void): Promise<Located | undefined> => {
      setLocating(true);
      try {
        const { located, note } = await findMe(index, locateDeps);
        setLocateNote(note);
        if (note && typeof onNote === 'function') onNote(note);
        if (located) setLocation(located.point, located.label);
        return located;
      } finally {
        setLocating(false);
      }
    },
    [index, locateDeps, setLocation],
  );
  // Once at startup, quietly: only while "you" are still at the default spot.
  const locatedAtStart = useRef(false);
  useEffect(() => {
    if (locatedAtStart.current) return;
    locatedAtStart.current = true;
    const gen = locationGen.current;
    findMe(index, locateDeps)
      .then(({ located }) => {
        if (located && gen === locationGen.current && sitRef.current.locationLabel === initialSituation(index).locationLabel) {
          setLocation(located.point, located.label);
        }
      })
      .catch(() => {});
  }, [index, locateDeps, setLocation]);

  // --- Itinerary actions.
  /**
   * Adds a place to a day: the clock's date unless `at.date` says another (a date outside the trip
   * grows the trip to include it), at `at.start` or the first free time that day (from now, on
   * today). Now's day strip and timeline show it at once. Already on that day: nothing changes.
   */
  const addToTrip = useCallback(
    async (placeId: string, at?: { date?: string; start?: string }) => {
      const place = index.place(placeId);
      if (!place) return;
      const before = tripRef.current;
      const next = withStop(before, place, sitRef.current.clock, at);
      if (next !== before) await setTrip(next);
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
  /** An imported itinerary (Chat's Import) becomes the trip: saved, and new like one the planner made. */
  const importTrip = useCallback(
    async (next: Trip) => {
      await setTrip(next);
      setTripIsNew(true);
    },
    [setTrip],
  );

  /** Distance from "you" to a place, for the cards. */
  const metersTo = useCallback((point: GeoPoint) => distanceMeters(situation.location, point), [situation.location]);

  return {
    index,
    runtime: rt,
    companion,
    trip,
    tripLoaded,
    tripIsNew,
    confirmTrip: () => setTripIsNew(false),
    situation,
    recs,
    recsThinking,
    chat,
    partial,
    latency,
    listening,
    speaking,
    busy,
    status,
    focusId,
    setFocusId,
    /** The guide facts behind the latest answer ({ placeId?, facts }), else undefined. */
    cited,
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
    /** macOS Location, else the last saved fix: { point, accuracy?, source: 'macos' | 'saved', at, label } or undefined. */
    locate,
    /** True while locate() waits for macOS (up to about 10 s). */
    locating,
    /** Why the last locate() fell back or gave up, to show near the map's locate button. */
    locateNote,
    addToTrip,
    removeStop,
    markVisited,
    clearTrip,
    importTrip,
    metersTo,
    parseHHMM,
  };
}

export type Buddy = ReturnType<typeof useBuddy>;

// ---------------------------------------------------------------------------
// Locating the Mac. A Mac has no GPS: macOS locates it from nearby Wi-Fi networks, so with
// Wi-Fi off it can't, and the app uses the last fix it saved, then a tap on the map. The app
// itself makes no network call: the helper asks macOS (CoreLocation), and the fix is stored here.

/** Where the last macOS fix inside the pack's map is kept. */
const LAST_FIX_KEY = 'travelbuddy.lastfix.v1';
/** How far outside the pack's map bounds a fix still counts as "on the map" (degrees, about 2 km). */
const MAP_MARGIN_DEG = 0.02;

/** What b.locate() returns. */
export interface Located {
  point: GeoPoint;
  /** Metres, when macOS gave one. */
  accuracy?: number;
  source: 'macos' | 'saved';
  /** When macOS made the fix, ms since 1970. */
  at: number;
  /** What "You:" now says: a place, a neighbourhood, or how old the saved fix is. */
  label: string;
}

export interface LocateDeps {
  /** macOS Location (through the helper); undefined when it can't, with the reason via onError. */
  ask(onError: (message: string) => void): Promise<LocationFix | undefined>;
  loadFix(): Promise<LocationFix | undefined>;
  saveFix(fix: LocationFix): Promise<void>;
  now(): number;
}

export async function loadLastFix(): Promise<LocationFix | undefined> {
  const raw = await AsyncStorage.getItem(LAST_FIX_KEY);
  if (!raw) return undefined;
  const fix: unknown = JSON.parse(raw);
  return isFix(fix) ? fix : undefined;
}

export async function saveLastFix(fix: LocationFix): Promise<void> {
  await AsyncStorage.setItem(LAST_FIX_KEY, JSON.stringify(fix));
}

function isFix(x: unknown): x is LocationFix {
  if (!x || typeof x !== 'object') return false;
  const f = x as Partial<LocationFix>;
  return (
    typeof f.lat === 'number' && Number.isFinite(f.lat) && Math.abs(f.lat) <= 90 &&
    typeof f.lon === 'number' && Number.isFinite(f.lon) && Math.abs(f.lon) <= 180 &&
    typeof f.at === 'number' && Number.isFinite(f.at) &&
    (f.accuracy === undefined || (typeof f.accuracy === 'number' && Number.isFinite(f.accuracy)))
  );
}

/** True when the point is on (or just off) the pack's offline map. */
export function onPackMap(index: PackIndex, p: GeoPoint): boolean {
  const [west, south, east, north] = index.destination.bounds;
  const m = MAP_MARGIN_DEG;
  return p.lat >= south - m && p.lat <= north + m && p.lon >= west - m && p.lon <= east + m;
}

/** "just now", "12 min ago", "2 h ago", "3 days ago". */
export function agoText(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.max(2, Math.round(h / 24))} days ago`;
}

/**
 * A name for a fix that reads after "You:" and after "near" (the prompts say "near <label>"):
 * the nearest place when the fix is that precise, else its neighbourhood, else undefined.
 */
export function placeLabel(index: PackIndex, p: GeoPoint, accuracy?: number): string | undefined {
  const [near] = index.nearest(p, 1);
  if (!near) return undefined;
  const acc = accuracy ?? 0;
  if (near.meters < 400 && acc <= 400) return near.place.name;
  if (near.place.neighborhood && near.meters < 1200 && acc <= 1500) return near.place.neighborhood;
  return undefined;
}

/** Ends a helper message with a full stop, so another sentence can follow it. */
const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/**
 * macOS first; if it can't, the last fix saved inside the pack's map; else nothing, and the note
 * says to tap the map. A macOS fix far from the pack (the Mac is not in the city) moves no one.
 */
export async function findMe(index: PackIndex, deps: LocateDeps): Promise<{ located?: Located; note?: string }> {
  let reason: string | undefined;
  const fix = await deps.ask(m => (reason = m)).catch((e: unknown) => {
    reason = e instanceof Error ? e.message : String(e);
    return undefined;
  });
  if (fix && isFix(fix)) {
    const point = { lat: fix.lat, lon: fix.lon };
    if (onPackMap(index, point)) {
      await deps.saveFix(fix).catch(() => {});
      return {
        located: { point, accuracy: fix.accuracy, source: 'macos', at: fix.at, label: placeLabel(index, point, fix.accuracy) ?? 'where macOS located you' },
      };
    }
    // Whole kilometres when far away ("5863 km", not "5863.3 km").
    const meters = distanceMeters(point, index.destination.center);
    const away = meters >= 100_000 ? `${Math.round(meters / 1000)} km` : formatDistance(meters);
    return { note: `macOS places this Mac ${away} from ${index.destination.name}, off the offline map. Tap the map to set where you are.` };
  }
  const why = sentence(reason ?? 'macOS could not locate this Mac.');
  const saved = await deps.loadFix().catch(() => undefined);
  if (saved && onPackMap(index, saved)) {
    const point = { lat: saved.lat, lon: saved.lon };
    const ago = agoText(deps.now() - saved.at);
    const name = placeLabel(index, point, saved.accuracy);
    return {
      located: {
        point,
        accuracy: saved.accuracy,
        source: 'saved',
        at: saved.at,
        label: name ? `${name} (last known, ${ago})` : `your last known spot (${ago})`,
      },
      note: `${why} Showing where macOS last located you, ${ago}.`,
    };
  }
  return { note: `${why} Tap the map to set where you are.` };
}
