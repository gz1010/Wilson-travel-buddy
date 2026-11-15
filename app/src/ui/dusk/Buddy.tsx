import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Animated, Easing, PanResponder, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';
import type { Fact } from '../../core/types';
import type { Buddy } from '../useBuddy';
import { axPress, Glass, onGlass } from './Glass';
import { CloseIcon } from './Icons';
import { useReduceMotion } from './motion';
import { TAB_BAR_BOTTOM, TAB_BAR_HEIGHT } from './Nav';
import { useScreenSize } from './Screen';
import { dusk, font, ground, sceneColors, white } from './tokens';

// The floating buddy: a small liquid-glass orb with a living light inside, laid over every main
// screen. Drag it anywhere (it springs to the nearest side and remembers where); tap it to talk
// without leaving the page: a compact glass panel beside it shows what it hears, its answer as it
// streams, when it speaks, and the guide facts the answer came from.

const SIZE = 60;
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

type Mood = 'idle' | 'listening' | 'thinking' | 'speaking';

const hexRGB = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
/** A token colour made lighter (k > 1), as a hex colour. */
const lift = (c: string, k: number) => `#${hexRGB(c).map(v => Math.min(255, Math.round(v * k)).toString(16).padStart(2, '0')).join('')}`;
const alpha = (c: string, a: number) => `rgba(${hexRGB(c).join(',')},${a})`;
// The same mood colours as the Chat tab's liquid background (LiquidBackground's MOOD_RGB), from
// the Dusk tokens: the "you" blue while listening, the dusk violet while thinking, the warm
// awning amber while speaking.
const VIOLET = lift(sceneColors.tower.front, 1.6);
const AMBER = lift(sceneColors.awnings.front, 1.9);

/** Colours per mood: the glass tint (a CSS colour with alpha), the core's light and its glow. */
const MOOD: Record<Mood, { tint?: string; core: string; glow: string; label: string }> = {
  idle: { core: dusk.color.text, glow: dusk.color.direction, label: 'Your buddy' },
  listening: { tint: alpha(dusk.color.you, 0.34), core: dusk.color.you, glow: dusk.color.direction, label: 'Listening' },
  thinking: { tint: alpha(VIOLET, 0.24), core: VIOLET, glow: dusk.color.direction, label: 'Thinking' },
  speaking: { tint: alpha(AMBER, 0.36), core: AMBER, glow: lift(AMBER, 1.25), label: 'Speaking' },
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function bounds(width: number, height: number) {
  const minY = TOP;
  return { minX: EDGE, maxX: Math.max(EDGE, width - SIZE - EDGE), minY, maxY: Math.max(minY, height - BOTTOM - SIZE) };
}

function placeOf(spot: Spot, width: number, height: number) {
  const b = bounds(width, height);
  return { x: spot.side === 'left' ? b.minX : b.maxX, y: Math.round(b.minY + spot.frac * (b.maxY - b.minY)) };
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
}

/** The floating buddy. Mount once over the screens; it hides itself where `visible` is false. */
export function FloatingBuddy({ b, visible, yieldMicrophone }: Props) {
  const { width, height } = useScreenSize();
  const reduce = useReduceMotion();
  const [spot, setSpot] = useState<Spot>(HOME);
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState(false);
  /** The first chat line of this conversation: the panel shows only what was said since it opened. */
  const [from, setFrom] = useState(0);
  const [draft, setDraft] = useState('');
  const mood: Mood = b.listening ? 'listening' : b.speaking ? 'speaking' : b.busy ? 'thinking' : 'idle';
  const hasMic = b.runtime.audio.info.hasMicrophone;

  // --- Where the orb is. `left`/`top` are layout props: AppKit owns a view's layer transform and
  // can reset a translate, but it keeps the frame.
  const pos = useRef(new Animated.ValueXY(placeOf(HOME, width, height))).current;
  const lastTarget = useRef<{ x: number; y: number }>(undefined);
  const live = useRef({ width, height, reduce });
  live.current = { width, height, reduce };

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
    const p = placeOf(spot, width, height);
    if (lastTarget.current && lastTarget.current.x === p.x && lastTarget.current.y === p.y) return; // springing there already
    lastTarget.current = p;
    pos.stopAnimation();
    pos.setValue(p);
  }, [spot, width, height, dragging, pos]);

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
  /** Ends a listen early. Its words still reach the companion (useBuddy has no cancel), so the reply is kept quiet. */
  const endListen = () => {
    if (!b.listening) return;
    talk();
    endedEarly.current = true;
  };
  const close = () => {
    setOpen(false);
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
    if (yieldMicrophone) handlers.current.endListen();
  }, [visible, yieldMicrophone]);

  // --- Dragging. A press that moves less than a few points is a tap.
  const origin = useRef({ x: 0, y: 0 });
  const moved = useRef(false);
  const pan = useMemo(() => {
    const settle = (x: number, y: number) => {
      const { width: w, height: h, reduce: still } = live.current;
      const bd = bounds(w, h);
      const next: Spot = { side: x + SIZE / 2 < w / 2 ? 'left' : 'right', frac: bd.maxY > bd.minY ? (clamp(y, bd.minY, bd.maxY) - bd.minY) / (bd.maxY - bd.minY) : 1 };
      const p = placeOf(next, w, h);
      lastTarget.current = p;
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
        }
        const { width: w, height: h } = live.current;
        const bd = bounds(w, h);
        pos.setValue({ x: clamp(origin.current.x + g.dx, 0, Math.max(0, w - SIZE)), y: clamp(origin.current.y + g.dy, bd.minY, bd.maxY) });
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
  }, [pos]);

  // --- The mic level (the helper sends it about ten times a second while it listens).
  const level = useRef(new Animated.Value(0)).current;
  const listeningRef = useRef(b.listening);
  listeningRef.current = b.listening;
  useEffect(() => {
    // useBuddy doesn't pass the level on; the helper client has one onLevel slot, so chain onto it.
    const audio = b.runtime.audio as { onLevel?: (v: number) => void };
    const before = audio.onLevel;
    const mine = (v: number) => {
      before?.(v);
      if (listeningRef.current) Animated.timing(level, { toValue: clamp(v, 0, 1), duration: 110, useNativeDriver: true }).start();
    };
    audio.onLevel = mine;
    return () => {
      if (audio.onLevel === mine) audio.onLevel = before;
    };
  }, [b.runtime.audio, level]);
  useEffect(() => {
    if (!b.listening) Animated.timing(level, { toValue: 0, duration: 240, useNativeDriver: true }).start();
  }, [b.listening, level]);

  if (!visible) return null;

  const at = placeOf(spot, width, height);
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
        accessibilityHint="Drag to move it"
        {...axPress(tap)}
        style={{ position: 'absolute', left: pos.x, top: pos.y, width: SIZE, height: SIZE, cursor: 'pointer' }}>
        <Orb mood={mood} level={level} reduce={reduce} lifted={dragging} />
      </Animated.View>
    </View>
  );
}

/**
 * A zero-size view at (x, y) that carries a transform for its children, so they scale about that
 * point (see TalkScreen's Flipped: on macOS a layer turns about its top-left corner, and RCTView
 * re-centres transforms only when it redraws; a zero-size layer has one point to turn about).
 */
function Pivot({ x, y, style, children }: { x: number; y: number; style?: Animated.WithAnimatedValue<StyleProp<ViewStyle>>; children: React.ReactNode }) {
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: x, top: y, width: 0, height: 0, transformOrigin: 'center' }, style]}>
      {children}
    </Animated.View>
  );
}

/** A soft round light: a radial gradient drawn once at its size (SVG on macOS keeps its first drawing). */
function Light({ size, color, strength = 1, dx = 0, dy = 0 }: { size: number; color: string; strength?: number; dx?: number; dy?: number }) {
  const id = `l${useId().replace(/:/g, '')}`;
  // Keyed by colour: a new mood draws a new light rather than repainting the old one.
  return (
    <Svg key={color} width={size} height={size} style={{ position: 'absolute', left: -size / 2 + dx, top: -size / 2 + dy }}>
      <Defs>
        <RadialGradient id={id} cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={color} stopOpacity={0.95 * strength} />
          <Stop offset="0.38" stopColor={color} stopOpacity={0.6 * strength} />
          <Stop offset="0.72" stopColor={color} stopOpacity={0.16 * strength} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${id})`} />
    </Svg>
  );
}

/**
 * The orb: Liquid Glass (Apple's own on macOS 26) tinted by mood, with a living light inside. Idle
 * it breathes slowly; listening it swells with the voice it hears; thinking it quickens; speaking
 * it sends out rings. With reduce motion it holds still and only follows the voice.
 */
const Orb = React.memo(function Orb({ mood, level, reduce, lifted }: { mood: Mood; level: Animated.Value; reduce: boolean; lifted: boolean }) {
  const m = MOOD[mood];
  const breath = useRef(new Animated.Value(0.5)).current;
  const ripple = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    breath.stopAnimation();
    if (reduce) {
      breath.setValue(0.5);
      return;
    }
    const half = mood === 'thinking' ? 520 : mood === 'listening' ? 1100 : mood === 'speaking' ? 800 : 2100;
    const ease = Easing.inOut(Easing.sin);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, { toValue: 1, duration: half, easing: ease, useNativeDriver: true }),
        Animated.timing(breath, { toValue: 0, duration: half, easing: ease, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [mood, reduce, breath]);

  useEffect(() => {
    ripple.stopAnimation();
    ripple.setValue(0);
    if (mood !== 'speaking' || reduce) return;
    const loop = Animated.loop(Animated.timing(ripple, { toValue: 1, duration: 1600, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [mood, reduce, ripple]);

  const c = SIZE / 2;
  // Built once: the native driver keeps running these while the orb re-renders (every streamed token).
  const motion = useMemo(() => {
    // Two rings half a cycle apart: each grows from the orb's edge and fades.
    const phases = [
      ripple.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
      ripple.interpolate({ inputRange: [0, 0.5, 0.5001, 1], outputRange: [0.5, 1, 0, 0.5] }),
    ];
    return {
      // The core breathes (0.8–1) and swells with the voice (up to 1.5×); the glow moves against it.
      core: Animated.multiply(
        breath.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }),
        level.interpolate({ inputRange: [0, 1], outputRange: [1, 1.5], extrapolate: 'clamp' }),
      ),
      glowScale: breath.interpolate({ inputRange: [0, 1], outputRange: [1.08, 0.84] }),
      glowOpacity: breath.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0.55] }),
      rings: phases.map(p => ({
        opacity: p.interpolate({ inputRange: [0, 0.12, 1], outputRange: [0, 0.6, 0] }),
        scale: p.interpolate({ inputRange: [0, 1], outputRange: [1, 1.8] }),
      })),
    };
  }, [breath, level, ripple]);

  return (
    <>
      {mood === 'speaking' &&
        !reduce &&
        motion.rings.map((r, i) => (
          <Pivot key={i} x={c} y={c} style={{ opacity: r.opacity, transform: [{ scale: r.scale }] }}>
            <View style={{ position: 'absolute', left: -c, top: -c, width: SIZE, height: SIZE, borderRadius: c, borderWidth: 1.5, borderColor: m.core }} />
          </Pivot>
        ))}
      <Glass
        kind="orb"
        radius={c}
        tint={m.tint}
        style={[
          { width: SIZE, height: SIZE },
          mood !== 'idle' && { shadowColor: m.core, shadowOpacity: 0.45, shadowRadius: 18, shadowOffset: { width: 0, height: 0 } },
          lifted && { shadowOpacity: 0.5, shadowRadius: 26, shadowOffset: { width: 0, height: 16 } },
        ]}>
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: c, overflow: 'hidden' }]}>
          <Pivot x={c} y={c} style={{ opacity: motion.glowOpacity, transform: [{ scale: motion.glowScale }] }}>
            <Light size={34} color={m.glow} strength={0.85} dx={-6} dy={-7} />
          </Pivot>
          <Pivot x={c} y={c} style={{ transform: [{ scale: motion.core }] }}>
            <Light size={42} color={m.core} strength={mood === 'idle' ? 0.75 : 1} />
          </Pivot>
        </View>
      </Glass>
    </>
  );
});

interface PanelProps {
  b: Buddy;
  mood: Mood;
  from: number;
  hasMic: boolean;
  draft: string;
  setDraft: (s: string) => void;
  onClose: () => void;
  reduce: boolean;
  style: StyleProp<ViewStyle>;
}

/** The compact conversation beside the orb: state, what it heard, its answer, and the facts used. */
function Panel({ b, mood, from, hasMic, draft, setDraft, onClose, reduce, style }: PanelProps) {
  const fade = useRef(new Animated.Value(reduce ? 1 : 0)).current;
  useEffect(() => {
    if (!reduce) Animated.timing(fade, { toValue: 1, duration: 180, useNativeDriver: true }).start();
  }, [fade, reduce]);

  const lines = b.chat.slice(from);
  const you = [...lines].reverse().find(l => l.who === 'you');
  // While it listens to a new question, the last answer (and its facts) step aside.
  const answer = b.listening ? undefined : [...lines].reverse().find(l => l.who === 'buddy');

  // Facts show only when `cited` changed after the question was asked, so an older answer's
  // sources never sit under a new answer.
  const cited = citedOf(b);
  const [asked, setAsked] = useState<{ id?: string; cited?: Cited }>({ id: you?.id, cited });
  if (asked.id !== you?.id) setAsked({ id: you?.id, cited });
  const baseline = asked.id === you?.id ? asked.cited : cited;
  const facts = answer && cited && cited !== baseline ? cited.facts.slice(0, 3) : [];
  const city = b.index.destination.name;

  const m = MOOD[mood];
  const heard = b.listening ? b.partial : you?.text;
  const hint = b.listening
    ? 'Ask about where you are, your plan, or what is nearby.'
    : mood === 'thinking'
      ? b.status
      : !answer
        ? b.status ?? (hasMic ? 'Tap me and ask anything.' : 'No microphone here: type your question.')
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
          <View style={[styles.dot, { backgroundColor: mood === 'idle' ? white(0.7) : m.core, shadowColor: m.core }]} />
          <Text style={styles.state} numberOfLines={1}>
            {m.label}
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
            <Text style={styles.hint} numberOfLines={2}>
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
        </ScrollView>
        {!hasMic && (
          <View style={styles.inputRow}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={send}
              placeholder="Ask your buddy…"
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
});
