import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DefaultCompanion, withStop } from '../core/companion';
import { distanceMeters, formatDistance } from '../core/geo';
import type { PackIndex } from '../core/pack';
import { SentenceChunker } from '../core/sentences';
import { parseHHMM, shiftClock } from '../core/time';
import type { Cited, Clock, GeoPoint, Heard, Lang, LocationFix, Recommendation, Situation, Trip, WakeEvent } from '../core/types';
import { LevelFeed } from '../services/audio/wake';
import type { Runtime } from '../services/runtime';
import * as storage from '../services/storage';
import { VoiceLoop, type VoiceLoopDeps } from './voiceLoop';

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

  // --- Voice output: microphone muted while speaking. Each sentence goes to the helper the moment
  // it is complete: the helper generates it while the one before is still playing, so sentences
  // follow each other without a gap (it used to wait for the previous one to finish first).
  // speechGen goes up on every stop; the helper drops what it had queued (speak.stop).
  const speechQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingSpeech = useRef(0);
  const speechGen = useRef(0);
  // Ref copies for the voice handlers, which run outside a render (wake word, follow-ups).
  const speakingRef = useRef(false);
  const busyRef = useRef(false);
  const listeningRef = useRef(false);
  /** Wilson heard his name and is hearing the rest of the sentence (the helper's wake word has it). */
  const wakeCaptureRef = useRef(false);
  /** A sentence after the name that cancelVoice() dropped: its wake event is ignored when it comes. */
  const dropWake = useRef(false);
  const say = useCallback(
    (text: string, lang: Lang = 'en', onStart?: () => void) => {
      if (!text.trim()) return;
      const gen = speechGen.current;
      pendingSpeech.current++;
      speakingRef.current = true;
      setSpeaking(true);
      rt.audio.setMuted(true);
      // Resolves when this sentence has finished playing; sentences finish in the order they were sent.
      const spoken = rt.audio.speak(text, lang, onStart);
      speechQueue.current = speechQueue.current
        .then(() => spoken)
        .catch(() => {})
        .finally(() => {
          if (gen !== speechGen.current) return; // cancelled by stopSpeaking
          if (--pendingSpeech.current === 0) {
            speakingRef.current = false;
            setSpeaking(false);
            rt.audio.setMuted(false);
          }
        });
    },
    [rt.audio],
  );
  // A spoken exchange (VoiceLoop, below) reads these through a ref, so it is created once.
  const loopDeps = useRef<VoiceLoopDeps | undefined>(undefined);
  const [followUp, setFollowUp] = useState(false);
  const voiceLoop = useMemo(
    () =>
      new VoiceLoop({
        ask: (text, heardAt) => loopDeps.current?.ask(text, heardAt) ?? Promise.resolve({ spoke: false }),
        listen: quietMs => loopDeps.current?.listen(quietMs) ?? Promise.resolve({ text: '' }),
        say: text => loopDeps.current?.say(text) ?? Promise.resolve(),
        onFollowUp: on => setFollowUp(on),
        canListen: () => loopDeps.current?.canListen?.() ?? false,
      }),
    [],
  );

  /** Stops the voice. It also ends a spoken exchange: tapping Wilson while he talks stops him (no barge-in). */
  const stopSpeaking = useCallback(() => {
    voiceLoop.cancel();
    speechGen.current++;
    pendingSpeech.current = 0;
    rt.audio.stopSpeaking();
    rt.audio.setMuted(false); // sent before talk()'s listen.start
    speakingRef.current = false;
    setSpeaking(false);
  }, [rt.audio, voiceLoop]);
  /** Says `text` and resolves once it (and anything queued before it) has played. */
  const sayAndWait = useCallback(
    async (text: string) => {
      say(text);
      await speechQueue.current;
    },
    [say],
  );

  // --- Sending text (typed, or heard by the microphone) to the companion. ask() resolves once the
  // answer has been spoken, saying whether any of it was (a voice exchange then listens for more).
  const ask = useCallback(
    async (text: string, heardAt?: number): Promise<{ spoke: boolean }> => {
      const t = text.trim();
      if (!t) return { spoke: false };
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
      busyRef.current = true;
      // If the user stops the voice mid-reply, the rest of this reply stays silent.
      const replyGen = speechGen.current;
      let spoke = false;
      let ended = false; // an error, or the companion opened Translate
      const speak = (s: string, lang?: Lang) => {
        if (replyGen !== speechGen.current || !s.trim()) return;
        spoke = true;
        say(s, lang, onFirstAudio);
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
            ended = true;
            setMode('translator');
            break;
          case 'error':
            ended = true;
            update({ text: `Something went wrong: ${ev.text}`, pending: false, error: true });
            break;
        }
      });
      setStatus(undefined);
      busyRef.current = false;
      setBusy(false);
      if (!spoke) return { spoke: false };
      await speechQueue.current; // this answer's last sentence has played (or the voice was stopped)
      return { spoke: !ended && replyGen === speechGen.current };
    },
    [companion, say],
  );
  /**
   * A typed (or tapped) question. It ends any spoken exchange: a follow-up listen still running
   * stops (what it heard is dropped), and none starts after this answer.
   */
  const send = useCallback(
    async (text: string, heardAt?: number) => {
      if (voiceLoop.active && listeningRef.current) rt.audio.stopListening();
      voiceLoop.cancel();
      await ask(text, heardAt);
    },
    [ask, rt.audio, voiceLoop],
  );

  /** One listen through the helper; { text: '' } when nothing was heard or it failed (the reason goes to status). */
  const listenOnce = useCallback(
    async (quietMs?: number): Promise<Heard> => {
      listeningRef.current = true;
      setListening(true);
      setPartial('');
      try {
        return await rt.audio.listen(setPartial, 'en', quietMs ? { quietMs } : undefined);
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
        return { text: '' };
      } finally {
        listeningRef.current = false;
        setPartial('');
        setListening(false);
      }
    },
    [rt.audio],
  );

  // --- The microphone button, and a tap on Wilson. While he listens, a tap finishes the sentence
  // (it is sent); otherwise it stops his voice and listens. After his spoken answer he listens for
  // a follow-up by himself (call and response, VoiceLoop).
  const talk = useCallback(async () => {
    // Also after "Wilson, …": the helper ends that sentence now and sends it.
    if (listeningRef.current || wakeCaptureRef.current) {
      rt.audio.stopListening();
      return;
    }
    stopSpeaking();
    await voiceLoop.listenFirst();
  }, [rt.audio, stopSpeaking, voiceLoop]);
  /** Ends whatever Wilson is doing by voice and drops a sentence still being heard (a close button). */
  const cancelVoice = useCallback(() => {
    voiceLoop.cancel();
    if (listeningRef.current) rt.audio.stopListening();
    if (wakeCaptureRef.current) {
      dropWake.current = true;
      wakeCaptureRef.current = false;
      // listening first: with wakeCapture still on, the wake word stays on between the two renders.
      setListening(false);
      setWakeCapture(false);
      setPartial('');
      // Restart the wake word: the helper drops the sentence now instead of recording it to the end
      // (it would also swallow a new "Wilson, …" said meanwhile).
      setWakeEpoch(n => n + 1);
    }
    if (speakingRef.current) stopSpeaking();
  }, [rt.audio, stopSpeaking, voiceLoop]);

  // --- The wake word: "Wilson, …" / "Hey Wilson" without a tap, fully offline (Argmax Whisper in
  // the helper reads each sentence's start). On by default and remembered; it listens only while
  // Wilson is idle (not listening, thinking or speaking) and nothing holds it (Translate needs the
  // microphone to itself: b.wake.hold('translate')). "Wilson, where is …" asks at once; "Wilson"
  // alone gets "Yes?" and a listen.
  const [wakeEnabled, setWakeEnabledState] = useState(true);
  const [wakeLoaded, setWakeLoaded] = useState(false);
  const [wakeListening, setWakeListening] = useState(false);
  const [wakeCapture, setWakeCapture] = useState(false);
  const wakeHolds = useRef(new Set<string>());
  const [wakeHeld, setWakeHeld] = useState(0);
  /** Goes up to restart the wake word (cancelVoice drops a sentence after the name). */
  const [wakeEpoch, setWakeEpoch] = useState(0);
  useEffect(() => {
    AsyncStorage.getItem(WAKE_KEY)
      .then(v => {
        if (v === '0') setWakeEnabledState(false);
      })
      .catch(() => {})
      .finally(() => setWakeLoaded(true));
  }, []);
  const setWakeEnabled = useCallback((on: boolean) => {
    setWakeEnabledState(on);
    AsyncStorage.setItem(WAKE_KEY, on ? '1' : '0').catch(() => {});
  }, []);
  /** Keeps the wake word off until the returned release() (Translate, while it is open). */
  const holdWake = useCallback((reason: string) => {
    const token = `${reason}#${++holdCounter}`;
    wakeHolds.current.add(token);
    setWakeHeld(wakeHolds.current.size);
    return () => {
      if (wakeHolds.current.delete(token)) setWakeHeld(wakeHolds.current.size);
    };
  }, []);
  const hasMic = rt.audio.info.hasMicrophone;
  const wakeAvailable = hasMic && rt.audio.info.wake === true && typeof rt.audio.wake === 'function';
  const wakeOn =
    wakeAvailable && wakeLoaded && wakeEnabled && wakeHeld === 0 && mode !== 'translator' && !(listening && !wakeCapture) && !speaking && !busy && !followUp;

  loopDeps.current = {
    ask,
    listen: listenOnce,
    say: sayAndWait,
    // Follow-ups need the helper build that ends a quiet listen after 6 s (the one with the wake word).
    canListen: () => hasMic && rt.audio.info.wake === true && wakeHolds.current.size === 0,
  };

  const endCapture = useCallback(() => {
    if (!wakeCaptureRef.current) return;
    wakeCaptureRef.current = false;
    // listening first: the other order passes through "listening, not after his name", which turns
    // the wake word off and on again (wake.stop, then wake.start) when the two renders are not batched.
    setListening(false);
    setWakeCapture(false);
    setPartial('');
  }, []);
  const onWake = useCallback(
    (e: WakeEvent) => {
      if (e.type === 'state') {
        setWakeListening(e.listening);
        return;
      }
      // Wilson is busy with something else (a sentence that raced a tap): ignore it.
      if (busyRef.current || speakingRef.current || listeningRef.current) {
        endCapture();
        return;
      }
      if (e.type === 'heard') {
        wakeCaptureRef.current = true;
        setWakeCapture(true);
        setListening(true);
        setPartial(e.text);
        return;
      }
      endCapture();
      if (dropWake.current) {
        dropWake.current = false; // the sentence cancelVoice() dropped
        return;
      }
      voiceLoop.wake(e.text, e.endedAt ?? Date.now()).catch(() => {});
    },
    [endCapture, voiceLoop],
  );
  useEffect(() => {
    if (!wakeOn || typeof rt.audio.wake !== 'function') return;
    const audio = rt.audio;
    let stop: (() => void) | undefined;
    // A moment's grace, so a follow-up listen starting right after the voice doesn't flap it on and off.
    const timer = setTimeout(() => {
      dropWake.current = false;
      stop = audio.wake?.(onWake);
    }, 400);
    return () => {
      clearTimeout(timer);
      stop?.(); // the helper drops a sentence it was still hearing
      endCapture();
      setWakeListening(false);
    };
  }, [wakeOn, wakeEpoch, rt.audio, onWake, endCapture]);
  // A sentence after the name ends within ~20 s; if the helper never says, stop showing it.
  useEffect(() => {
    if (!wakeCapture) return;
    const timer = setTimeout(endCapture, 25_000);
    return () => clearTimeout(timer);
  }, [wakeCapture, endCapture]);
  const wake = useMemo<WakeControl>(
    () => ({
      /** The toggle (remembered; on by default). */
      enabled: wakeEnabled,
      setEnabled: setWakeEnabled,
      /** True while the helper is listening for "Wilson" right now. */
      listening: wakeOn && wakeListening,
      /** False without the helper's microphone, or with an older helper build. */
      available: wakeAvailable,
      /** Keeps the wake word off until release() (e.g. while Translate is open): const release = b.wake.hold('translate'). */
      hold: holdWake,
    }),
    [wakeEnabled, setWakeEnabled, wakeOn, wakeListening, wakeAvailable, holdWake],
  );

  // --- Levels for Wilson's rings (microphone) and mouth (voice), straight from the helper. A feed,
  // not state: ten to twenty levels a second never re-render the screens.
  const levels = useMemo(() => new LevelFeed(), []);
  useEffect(() => {
    const audio = rt.audio;
    if (typeof audio.subscribeLevels !== 'function') return;
    return audio.subscribeLevels((kind, value) => levels.push(kind, value));
  }, [rt.audio, levels]);
  useEffect(() => {
    if (!listening) levels.push('mic', 0);
  }, [listening, levels]);
  useEffect(() => {
    if (!speaking) levels.push('voice', 0);
  }, [speaking, levels]);

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
    /** Ends a spoken exchange and drops a sentence still being heard (talk() instead sends it). */
    cancelVoice,
    /** True while Wilson listens for a follow-up after his answer (listening is true too). */
    followUp,
    /** The wake word: { enabled, setEnabled(on), listening, available, hold(reason) => release }. */
    wake,
    /** levels.subscribe(cb({ mic, voice })) => unsubscribe; levels.get() for the latest. 0-1 each. */
    levels,
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

/**
 * b.wake. The contract is enabled / setEnabled / listening; available and hold are extras, typed
 * optional so a test's stand-in Buddy needs only the contract (call them as b.wake.hold?.(…)).
 */
export interface WakeControl {
  /** The toggle (remembered; on by default). */
  enabled: boolean;
  setEnabled(on: boolean): void;
  /** True while the helper is listening for "Wilson" right now. */
  listening: boolean;
  /** False without the helper's microphone, or with a helper build from before the wake word. */
  available?: boolean;
  /** Keeps the wake word off until the returned release() is called (Translate, while it is open). */
  hold?(reason: string): () => void;
}

/** Whether the wake word is on ('1') or off ('0'); missing means on. */
const WAKE_KEY = 'travelbuddy.wake.v1';
let holdCounter = 0;

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
