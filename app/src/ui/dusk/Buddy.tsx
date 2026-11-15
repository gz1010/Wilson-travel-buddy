import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import type { Fact } from '../../core/types';
import type { Buddy } from '../useBuddy';
import { axPress, Glass, onGlass } from './Glass';
import { CloseIcon } from './Icons';
import { useReduceMotion } from './motion';
import { TAB_BAR_BOTTOM, TAB_BAR_HEIGHT } from './Nav';
import { useScreenSize } from './Screen';
import { dusk, font, ground, white } from './tokens';
import { createWilsonMotion, Pivot, useWilsonLevel, useWilsonMood, Wilson, wilsonTint, type WilsonMood, type WilsonMotion } from './Wilson';

// The floating Wilson: the companion (dusk/Wilson.tsx) laid over every main screen. Drag him
// anywhere (he springs to the nearest side and remembers where); tap him to talk without leaving
// the page: a compact glass panel beside him shows what he hears, his answer as it streams, when he
// speaks, and the guide facts the answer came from. While dragged he behaves like liquid glass
// (after liquid-glass-studio): he stretches along the way he is thrown, his rim and glare light up
// with colour fringes at the edges, a few droplets trail behind and merge back in, and he wobbles
// to rest when let go. On macOS 26 his body is Apple's Liquid Glass, which refracts what is under him.

const SIZE = 64;
/** Gap between the orb and the window's sides. */
const EDGE = 12;
const TOP = 12;
/** Kept free at the bottom: the tab bar and a little air above it. */
const BOTTOM = TAB_BAR_BOTTOM + TAB_BAR_HEIGHT + 12;
/** Between the orb and its panel. */
const GAP = 10;
const PANEL_MAX_W = 300;
/** A panel growing upwards stops here, so the screens' headers (the Offline chip, the model names) stay in view. */
const PANEL_TOP = 104;
const STORE_KEY = 'travelbuddy.buddy.v1';

type Side = 'left' | 'right';
/** Where the orb rests: a side, and how far down the free height (0 top, 1 bottom). */
interface Spot {
  side: Side;
  frac: number;
}
/** Bottom right, just above the tab bar: where the mic orb used to be. */
const HOME: Spot = { side: 'right', frac: 1 };

/** The panel's heading and its dot per mood: the dot is white light, warm when happy, cool when unsure. */
const MOOD: Record<WilsonMood, { label: string; dot: string }> = {
  idle: { label: 'Wilson', dot: white(0.7) },
  listening: { label: 'Listening', dot: dusk.color.you },
  thinking: { label: 'Thinking', dot: dusk.color.direction },
  speaking: { label: 'Speaking', dot: dusk.color.white },
  happy: { label: 'Added to your day', dot: wilsonTint('happy').light },
  unsure: { label: 'Not in my guide', dot: wilsonTint('unsure').light },
  waking: { label: 'Waking up', dot: dusk.color.pending },
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The heading for a mood. Unsure after a failed answer (not a decline) doesn't claim "Not in my guide". */
function moodLabel(mood: WilsonMood, b: Buddy): string {
  if (mood !== 'unsure') return MOOD[mood].label;
  for (let i = b.chat.length - 1; i >= 0; i--) {
    const l = b.chat[i];
    if (l.who === 'buddy' && !l.pending) return l.error ? 'Unsure' : MOOD.unsure.label;
  }
  return MOOD.unsure.label;
}

function bounds(width: number, height: number) {
  const minY = TOP;
  return { minX: EDGE, maxX: Math.max(EDGE, width - SIZE - EDGE), minY, maxY: Math.max(minY, height - BOTTOM - SIZE) };
}

/** The lowest he rests on a screen that keeps `keepClear` px above the tab bar free (the Map's place card). */
function lowestY(width: number, height: number, keepClear: number) {
  const b = bounds(width, height);
  return Math.max(b.minY, b.maxY - keepClear);
}

/** Where a spot is. On a screen with room to keep clear he rests no lower than it, and comes back down elsewhere. */
function placeOf(spot: Spot, width: number, height: number, keepClear = 0) {
  const b = bounds(width, height);
  return { x: spot.side === 'left' ? b.minX : b.maxX, y: Math.min(Math.round(b.minY + spot.frac * (b.maxY - b.minY)), lowestY(width, height, keepClear)) };
}

function parseSpot(raw: string | null): Spot | undefined {
  try {
    const s = raw ? (JSON.parse(raw) as Partial<Spot>) : undefined;
    if (s && (s.side === 'left' || s.side === 'right') && typeof s.frac === 'number' && Number.isFinite(s.frac)) return { side: s.side, frac: clamp(s.frac, 0, 1) };
  } catch {}
  return undefined;
}

/** The facts behind the latest answer (useBuddy's `cited`, when it has one). */
type Cited = { placeId?: string; facts: Fact[] };
function citedOf(b: Buddy): Cited | undefined {
  const c = (b as unknown as { cited?: unknown }).cited;
  return c && typeof c === 'object' && Array.isArray((c as Cited).facts) ? (c as Cited) : undefined;
}

/** "Wikipedia · CC BY-SA 4.0" for a fact taken from an article; nothing for our own notes. */
function attribution(f: Fact): string | undefined {
  if (!f.source) return f.license;
  const host = /^[a-z]+:\/\/([^/]+)/i.exec(f.source)?.[1] ?? '';
  const name = /wikipedia\.org$/i.test(host) ? 'Wikipedia' : host.replace(/^www\./, '') || 'Source';
  return [name, f.license].filter(Boolean).join(' · ');
}

// macOS-only View props that react-native's types don't list: dragging the orb must never drag the window.
const noWindowDrag = { mouseDownCanMoveWindow: false } as object;

interface Props {
  b: Buddy;
  /** False on the screens that hold the whole conversation themselves (Chat, Translate). */
  visible: boolean;
  /** Translate needs the microphone: while hidden there, a listen in progress is ended (and its reply kept quiet). */
  yieldMicrophone?: boolean;
  /** Room above the tab bar he stays out of on this screen (the Map's place card and Locate row), px. */
  keepClear?: number;
}

/** The floating Wilson. Mount once over the screens; he hides himself where `visible` is false. */
export function FloatingBuddy({ b, visible, yieldMicrophone, keepClear = 0 }: Props) {
  const { width, height } = useScreenSize();
  const reduce = useReduceMotion();
  const [spot, setSpot] = useState<Spot>(HOME);
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState(false);
  /** The first chat line of this conversation: the panel shows only what was said since it opened. */
  const [from, setFrom] = useState(0);
  const [draft, setDraft] = useState('');
  const mood = useWilsonMood(b);
  const hasMic = b.runtime.audio.info.hasMicrophone;

  // --- Where the orb is. `left`/`top` are layout props: AppKit owns a view's layer transform and
  // can reset a translate, but it keeps the frame.
  const pos = useRef(new Animated.ValueXY(placeOf(HOME, width, height))).current;
  const lastTarget = useRef<{ x: number; y: number }>(undefined);
  const live = useRef({ width, height, reduce, keepClear });
  live.current = { width, height, reduce, keepClear };

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(STORE_KEY)
      .then(raw => {
        const s = parseSpot(raw);
        if (alive && s) setSpot(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Rest at the spot; follow the window when it is resized.
  useEffect(() => {
    if (dragging) return;
    const p = placeOf(spot, width, height, keepClear);
    if (lastTarget.current && lastTarget.current.x === p.x && lastTarget.current.y === p.y) return; // springing there already
    lastTarget.current = p;
    pos.stopAnimation();
    pos.setValue(p);
  }, [spot, width, height, keepClear, dragging, pos]);

  // --- The conversation.
  /** A listen ended early (close, or Translate) and has not finished yet. */
  const endedEarly = useRef(false);
  /** Until when a reply starting now answers that listen, and is kept quiet. */
  const silenceUntil = useRef(0);
  const { stopSpeaking, talk } = b;
  const startConversation = () => {
    if (!open) {
      setOpen(true);
      setFrom(b.chat.length);
    } else if (!b.runtime.audio.info.hasMicrophone) {
      setOpen(false); // no microphone: a second tap closes the typed panel
      return;
    }
    if (b.runtime.audio.info.hasMicrophone) {
      silenceUntil.current = 0; // a new question is answered aloud
      talk();
    }
  };
  /** Tap: start; while listening, finish (what was said is sent); while answering, stop the voice. */
  const tap = () => {
    if (b.listening) talk();
    else if (b.speaking || b.busy) stopSpeaking();
    else startConversation();
  };
  /** useBuddy's cancelVoice when it has one: ends the exchange and drops a sentence still being heard. */
  const cancelVoice = (b as unknown as { cancelVoice?: () => void }).cancelVoice;
  /**
   * Ends a listen early. With cancelVoice what was being said is dropped; without it, its words
   * still reach the companion (an older useBuddy can't cancel a listen), so the reply is kept quiet.
   */
  const endListen = () => {
    if (typeof cancelVoice === 'function') return cancelVoice();
    if (!b.listening) return;
    talk();
    endedEarly.current = true;
  };
  const close = () => {
    setOpen(false);
    if (typeof cancelVoice === 'function') {
      cancelVoice(); // it stops his voice too
      // cancelVoice leaves a reply still being written alone (nothing is playing yet): keep it quiet.
      if (b.busy) stopSpeaking();
      return;
    }
    endListen();
    if (b.speaking || b.busy) stopSpeaking();
  };
  // useBuddy sends what a listen heard as soon as the listen ends (busy turns on at once), or sends
  // nothing when it heard nothing. So only a reply that starts right then is silenced: a later
  // question (asked again from the orb, or on Chat) is answered aloud.
  useEffect(() => {
    if (b.listening || !endedEarly.current) return;
    endedEarly.current = false;
    silenceUntil.current = Date.now() + 1500;
  }, [b.listening]);
  useEffect(() => {
    if (b.busy && silenceUntil.current > Date.now()) {
      silenceUntil.current = 0;
      stopSpeaking();
    }
  }, [b.busy, stopSpeaking]);

  // Hidden on Chat (the whole conversation is there) and Translate (which needs the microphone).
  const handlers = useRef({ tap, endListen });
  handlers.current = { tap, endListen };
  useEffect(() => {
    if (visible) return;
    setOpen(false);
    // With cancelVoice this also ends the exchange, so no follow-up listen takes the microphone.
    if (yieldMicrophone) handlers.current.endListen();
  }, [visible, yieldMicrophone]);

  // --- Dragging. A press that moves less than a few points is a tap.
  const origin = useRef({ x: 0, y: 0 });
  const moved = useRef(false);
  const fx = useDragGlass();
  const pan = useMemo(() => {
    const settle = (x: number, y: number) => {
      const { width: w, height: h, reduce: still, keepClear: k } = live.current;
      const bd = bounds(w, h);
      // Let go over what this screen keeps clear: he lands just above it, and remembers that.
      const next: Spot = { side: x + SIZE / 2 < w / 2 ? 'left' : 'right', frac: bd.maxY > bd.minY ? (clamp(y, bd.minY, lowestY(w, h, k)) - bd.minY) / (bd.maxY - bd.minY) : 1 };
      const p = placeOf(next, w, h, k);
      lastTarget.current = p;
      fx.release(still);
      if (still) pos.setValue(p);
      else Animated.spring(pos, { toValue: p, useNativeDriver: false, stiffness: 240, damping: 21, mass: 1 }).start();
      setSpot(next);
      setDragging(false);
      AsyncStorage.setItem(STORE_KEY, JSON.stringify(next)).catch(() => {});
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        moved.current = false;
        pos.stopAnimation(v => {
          origin.current = v;
        });
      },
      onPanResponderMove: (_e, g) => {
        if (!moved.current) {
          if (Math.abs(g.dx) + Math.abs(g.dy) < 5) return;
          moved.current = true;
          setDragging(true);
          fx.pickUp(live.current.reduce);
        }
        const { width: w, height: h } = live.current;
        const bd = bounds(w, h);
        // Held, he goes anywhere above the tab bar (over the Map's card too); let go, he settles clear of it.
        const p = { x: clamp(origin.current.x + g.dx, 0, Math.max(0, w - SIZE)), y: clamp(origin.current.y + g.dy, bd.minY, bd.maxY) };
        pos.setValue(p);
        fx.track(p.x, p.y, live.current.reduce);
      },
      onPanResponderRelease: (_e, g) => {
        if (moved.current) return settle(origin.current.x + g.dx, origin.current.y + g.dy);
        // A tap: if the press caught the orb mid-spring, let it finish the trip.
        const t = lastTarget.current;
        if (t && (t.x !== origin.current.x || t.y !== origin.current.y)) Animated.spring(pos, { toValue: t, useNativeDriver: false, stiffness: 240, damping: 21, mass: 1 }).start();
        handlers.current.tap();
      },
      onPanResponderTerminate: (_e, g) => {
        if (moved.current) settle(origin.current.x + g.dx, origin.current.y + g.dy);
      },
    });
  }, [pos, fx]);

  // --- What moves him: the microphone while listening, the voice while speaking (useBuddy's
  // levels when it has them; else the helper's mic level through its onLevel slot). Without a
  // voice level his mouth moves by itself while he speaks.
  const { level, voice } = useWilsonLevel(b);
  const wilsonLevel = mood === 'speaking' && !voice ? undefined : level;

  if (!visible) return null;

  const at = placeOf(spot, width, height, keepClear);
  const panelW = Math.min(PANEL_MAX_W, width - EDGE * 2 - SIZE - GAP);
  const below = at.y + SIZE / 2 < height / 2;
  const panelStyle: StyleProp<ViewStyle> = [
    { position: 'absolute', width: panelW },
    spot.side === 'left' ? { left: at.x + SIZE + GAP } : { right: width - at.x + GAP },
    below ? { top: at.y, maxHeight: Math.max(160, height - BOTTOM - at.y) } : { bottom: height - at.y - SIZE, maxHeight: Math.max(160, at.y + SIZE - PANEL_TOP) },
  ];
  const label = b.listening ? 'Stop listening' : b.speaking || b.busy ? 'Stop speaking' : 'Ask your buddy';

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {open && !dragging && panelW >= 180 && (
        <Panel
          b={b}
          mood={mood}
          from={from}
          hasMic={hasMic}
          draft={draft}
          setDraft={setDraft}
          onClose={close}
          reduce={reduce}
          style={panelStyle}
        />
      )}
      <Animated.View
        {...pan.panHandlers}
        {...noWindowDrag}
        accessible
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: `Wilson: ${mood === 'idle' ? 'waiting' : moodLabel(mood, b).toLowerCase()}` }}
        accessibilityHint="Drag to move it"
        {...axPress(tap)}
        style={{ position: 'absolute', left: pos.x, top: pos.y, width: SIZE, height: SIZE, cursor: 'pointer' }}>
        {/* Reduce motion: no trail (the droplets would only sit inside him, seen through the glass). */}
        {!reduce && <Droplets size={SIZE} fx={fx} />}
        <Wilson size={SIZE} mood={mood} level={wilsonLevel} motion={fx} lifted={dragging} decorative />
      </Animated.View>
    </View>
  );
}

/** Wilson's liquid-glass drag: his motion values, the droplets' offset, and what moves them. */
interface DragGlass extends WilsonMotion {
  /** Where the droplets trail, relative to his centre (px). */
  trailX: Animated.Value;
  trailY: Animated.Value;
  /** Picked up: he grows a little and his rim lights up. */
  pickUp(reduce: boolean): void;
  /** Each move: his new top-left corner. */
  track(x: number, y: number, reduce: boolean): void;
  /** Let go: he wobbles back into a sphere, the droplets merge back in, the glare fades. */
  release(reduce: boolean): void;
}

/** How fast (px/ms) counts as moving at all; below it the direction is noise. */
const STILL = 0.04;
/** Stretch per px/ms of speed, and the most he stretches (liquid-glass-studio grows its shape with the spring's speed). */
const STRETCH_PER_SPEED = 0.15;
const STRETCH_MAX = 0.26;
/** How far behind him the last droplet trails: this many ms of travel, at most this share of his size. */
const TRAIL_MS = 34;
const TRAIL_MAX = 0.9;
/** A pause mid-drag: after this long without a move he settles round again (he is still held). */
const RELAX_MS = 70;

/**
 * The motion of the drag, after liquid-glass-studio (src/App.tsx: the shape follows the pointer on
 * a spring and grows with the spring's speed). Everything here runs on the native driver: each move
 * only sets a few values (smoothed velocity → stretch, direction, glare, trail); the springs on
 * release run natively. Reduce motion keeps only the glare.
 */
function useDragGlass(): DragGlass {
  const [fx] = useState<DragGlass>(() => {
    const m = createWilsonMotion();
    const trailX = new Animated.Value(0);
    const trailY = new Animated.Value(0);
    /** The last position and the smoothed velocity (px/ms). */
    const k = { x: 0, y: 0, t: 0, vx: 0, vy: 0 };
    let relax: ReturnType<typeof setTimeout> | undefined;
    const spring = (v: Animated.Value, toValue: number, stiffness: number, damping: number) =>
      Animated.spring(v, { toValue, stiffness, damping, mass: 1, useNativeDriver: true }).start();
    const rest = (held: boolean) => {
      // Round again and the droplets back in; still lit while held.
      spring(m.stretch, 0, 300, 14);
      spring(trailX, 0, 200, 18);
      spring(trailY, 0, 200, 18);
      Animated.timing(m.moving, { toValue: held ? 0.4 : 0, duration: held ? 180 : 320, useNativeDriver: true }).start();
    };
    return {
      ...m,
      trailX,
      trailY,
      pickUp(reduce) {
        k.t = 0;
        k.vx = 0;
        k.vy = 0;
        if (!reduce) spring(m.lift, 1, 320, 18);
        Animated.timing(m.moving, { toValue: 0.4, duration: 140, useNativeDriver: true }).start();
      },
      track(x, y, reduce) {
        const now = Date.now();
        if (k.t) {
          const dt = clamp(now - k.t, 4, 64);
          // An exponential average: the pointer's own steps are uneven.
          k.vx += ((x - k.x) / dt - k.vx) * 0.35;
          k.vy += ((y - k.y) / dt - k.vy) * 0.35;
        }
        k.x = x;
        k.y = y;
        k.t = now;
        const speed = Math.hypot(k.vx, k.vy);
        if (!reduce) {
          if (speed > STILL) m.angle.setValue(Math.atan2(k.vy, k.vx));
          m.stretch.setValue(Math.min(STRETCH_MAX, speed * STRETCH_PER_SPEED));
          const len = Math.min(SIZE * TRAIL_MAX, speed * TRAIL_MS);
          trailX.setValue(speed > STILL ? (-k.vx / speed) * len : 0);
          trailY.setValue(speed > STILL ? (-k.vy / speed) * len : 0);
        }
        m.moving.setValue(Math.min(1, 0.4 + speed * 0.5));
        if (relax) clearTimeout(relax);
        relax = setTimeout(() => {
          k.vx = 0;
          k.vy = 0;
          rest(true);
        }, RELAX_MS);
      },
      release(reduce) {
        if (relax) clearTimeout(relax);
        relax = undefined;
        k.t = 0;
        k.vx = 0;
        k.vy = 0;
        if (reduce) {
          m.stretch.setValue(0);
          m.lift.setValue(0);
          trailX.setValue(0);
          trailY.setValue(0);
          Animated.timing(m.moving, { toValue: 0, duration: 200, useNativeDriver: true }).start();
          return;
        }
        // A soft, under-damped spring: he overshoots into a squash and wobbles back to round.
        spring(m.stretch, 0, 300, 8);
        spring(m.lift, 0, 260, 14);
        spring(trailX, 0, 180, 14);
        spring(trailY, 0, 180, 14);
        Animated.timing(m.moving, { toValue: 0, duration: 340, useNativeDriver: true }).start();
      },
    };
  });
  return fx;
}

/**
 * The blob trail: three glass droplets behind Wilson along the way he moves, smaller the further
 * back, that merge into him as he slows (the blob merge of liquid-glass-studio's smooth-min shapes,
 * drawn as overlapping drops rather than a shader). They are light, plain views (no blur), never
 * take touches, and show only while he moves.
 */
const DROPS = [
  { at: 0.3, size: 0.62, opacity: 0.9 },
  { at: 0.62, size: 0.42, opacity: 0.75 },
  { at: 1, size: 0.26, opacity: 0.6 },
];

const Droplets = React.memo(function Droplets({ size, fx }: { size: number; fx: DragGlass }) {
  const drops = useMemo(
    () =>
      DROPS.map(d => ({
        d: Math.round(size * d.size),
        x: Animated.multiply(fx.trailX, d.at),
        y: Animated.multiply(fx.trailY, d.at),
        opacity: fx.moving.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 0, d.opacity], extrapolate: 'clamp' }),
      })),
    [size, fx],
  );
  return (
    <>
      {drops.map(({ d, x, y, opacity }, i) => (
        <Pivot key={i} x={size / 2} y={size / 2} style={{ opacity, transform: [{ translateX: x }, { translateY: y }] }}>
          <View style={[styles.drop, { left: -d / 2, top: -d / 2, width: d, height: d, borderRadius: d / 2 }]}>
            <View style={[styles.dropGlint, { left: d * 0.2, top: d * 0.16, width: d * 0.3, height: d * 0.22, borderRadius: d * 0.15 }]} />
          </View>
        </Pivot>
      ))}
    </>
  );
});

interface PanelProps {
  b: Buddy;
  mood: WilsonMood;
  from: number;
  hasMic: boolean;
  draft: string;
  setDraft: (s: string) => void;
  onClose: () => void;
  reduce: boolean;
  style: StyleProp<ViewStyle>;
}

/** Says "start with “Wilson, …”" only while the wake word is on (useBuddy's wake, when it has one). */
function wakeWordOn(b: Buddy): boolean {
  const wake = (b as unknown as { wake?: { enabled?: unknown; available?: unknown } }).wake;
  return !!wake && wake.enabled === true && wake.available !== false;
}

/** The compact conversation beside Wilson: his state, what he heard, his answer, and the facts used. */
function Panel({ b, mood, from, hasMic, draft, setDraft, onClose, reduce, style }: PanelProps) {
  const fade = useRef(new Animated.Value(reduce ? 1 : 0)).current;
  useEffect(() => {
    if (!reduce) Animated.timing(fade, { toValue: 1, duration: 180, useNativeDriver: true }).start();
  }, [fade, reduce]);

  const lines = b.chat.slice(from);
  const you = [...lines].reverse().find(l => l.who === 'you');
  // After his spoken answer he listens for a follow-up by himself (useBuddy's followUp): the answer
  // stays, with what he hears under it. A new question (a tap) moves the last answer aside.
  const followUp = (b as unknown as { followUp?: unknown }).followUp === true && b.listening;
  const answer = b.listening && !followUp ? undefined : [...lines].reverse().find(l => l.who === 'buddy');

  // Facts show only when `cited` changed after the question was asked, so an older answer's
  // sources never sit under a new answer.
  const cited = citedOf(b);
  const [asked, setAsked] = useState<{ id?: string; cited?: Cited }>({ id: you?.id, cited });
  if (asked.id !== you?.id) setAsked({ id: you?.id, cited });
  const baseline = asked.id === you?.id ? asked.cited : cited;
  const facts = answer && cited && cited !== baseline ? cited.facts.slice(0, 3) : [];
  const city = b.index.destination.name;

  const m = MOOD[mood];
  const heard = b.listening && !followUp ? b.partial : you?.text;
  // His greeting (the spec's, on a Mac): he lives here, so he works without signal.
  // A no-break space inside the quote, so the panel never leaves "…”." alone on a line.
  const greeting = `Hi, I'm Wilson. I live on this Mac, so I work without signal. Tap me${wakeWordOn(b) ? ', or start with “Wilson, …”' : ' and ask anything'}.`;
  const hint = followUp
    ? undefined
    : b.listening
    ? 'Ask about where you are, your plan, or what is nearby.'
    : mood === 'thinking'
      ? b.status
      : !answer
        ? b.status ?? (hasMic ? greeting : 'No microphone here: type your question.')
        : undefined;
  const send = () => {
    const t = draft.trim();
    if (!t || b.busy) return;
    setDraft('');
    b.send(t);
  };

  return (
    <Animated.View style={[style, { opacity: fade }]}>
      {/* The panel never grows past the room beside the orb (maxHeight on the wrapper): the body scrolls. */}
      <Glass kind="clear" radius={24} tint={ground(0.42)} style={styles.panel}>
        <View style={styles.head}>
          <View style={[styles.dot, { backgroundColor: m.dot, shadowColor: m.dot }]} />
          <Text style={styles.state} numberOfLines={1}>
            {moodLabel(mood, b)}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} {...axPress(onClose)} hitSlop={8} style={({ pressed }) => [styles.close, { opacity: pressed ? 0.7 : 1 }]}>
            <CloseIcon size={11} strokeWidth={2.6} />
          </Pressable>
        </View>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
          {!!heard && (
            <Text style={styles.heard} numberOfLines={2}>
              “{heard}”
            </Text>
          )}
          {!!hint && (
            <Text style={styles.hint} numberOfLines={3}>
              {hint}
            </Text>
          )}
          {answer && (
            <Text style={[styles.answer, answer.error && { color: dusk.color.text2 }]}>
              {answer.text || '…'}
            </Text>
          )}
          {facts.length > 0 && (
            <View style={styles.facts}>
              <Text style={styles.factsLabel} numberOfLines={1}>
                {`From your ${city} guide`}
              </Text>
              {facts.map(f => {
                const src = attribution(f);
                return (
                  <View key={f.id} style={styles.fact} accessible accessibilityLabel={`${f.title}. ${f.body}${src ? `. ${src}` : ''}`}>
                    <Text style={styles.factTitle} numberOfLines={1}>
                      {f.title}
                    </Text>
                    <Text style={styles.factBody} numberOfLines={1}>
                      {f.body}
                    </Text>
                    {!!src && (
                      <Text style={styles.factSource} numberOfLines={1}>
                        {src}
                      </Text>
                    )}
                  </View>
                );
              })}
            </View>
          )}
          {followUp && (
            <Text style={[styles.hint, !!b.partial && styles.heard]} numberOfLines={2}>
              {b.partial ? `“${b.partial}”` : 'Listening for a follow-up. Or say “thanks”.'}
            </Text>
          )}
        </ScrollView>
        {!hasMic && (
          <View style={styles.inputRow}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={send}
              placeholder="Ask Wilson…"
              placeholderTextColor={dusk.color.pending}
              accessibilityLabel="Ask your buddy"
              autoFocus
              returnKeyType="send"
              style={styles.input}
            />
          </View>
        )}
      </Glass>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  panel: { flexShrink: 1, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 14, gap: 8 },
  scroll: { flexGrow: 0, flexShrink: 1 },
  body: { gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 },
  dot: { width: 7, height: 7, borderRadius: 3.5, shadowOpacity: 0.9, shadowRadius: 5, shadowOffset: { width: 0, height: 0 } },
  state: { ...font('700'), flex: 1, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase', color: dusk.color.text },
  close: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: white(0.14) },
  heard: { ...font('500'), ...onGlass, fontSize: 14, lineHeight: 19, color: dusk.color.textSoft },
  hint: { ...font('500'), fontSize: 13, lineHeight: 18, color: dusk.color.pending },
  answer: { ...font('500'), ...onGlass, fontSize: 15, lineHeight: 21, color: dusk.color.text },
  facts: { gap: 6, marginTop: 2 },
  factsLabel: { ...font('700'), fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase', color: dusk.color.text2 },
  fact: { borderRadius: 14, paddingHorizontal: 11, paddingVertical: 8, backgroundColor: white(0.09), gap: 1 },
  factTitle: { ...font('700'), fontSize: 13, lineHeight: 17, color: dusk.color.text },
  factBody: { ...font('500'), fontSize: 12, lineHeight: 16, color: dusk.color.textSoft },
  factSource: { ...font('500'), fontSize: 11, lineHeight: 14, color: dusk.color.text2 },
  inputRow: { height: 38, borderRadius: 19, paddingHorizontal: 14, justifyContent: 'center', backgroundColor: white(0.1) },
  input: { ...font('500'), fontSize: 14, height: 20, paddingVertical: 0, color: dusk.color.text },
  drop: { position: 'absolute', backgroundColor: white(0.1), borderWidth: 1, borderColor: white(0.34), overflow: 'hidden' },
  dropGlint: { position: 'absolute', backgroundColor: white(0.32) },
});
