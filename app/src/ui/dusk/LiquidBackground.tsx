import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useBox } from './Gradient';
import { useReduceMotion } from './motion';
import { dusk, sceneColors } from './tokens';

// An abstract liquid background for the voice screens (Chat and Translate): a dusk sky, deep blue
// above, plum in the middle and a warm afterglow low down, with soft lights drifting through it,
// and a few drops of liquid glass floating over it. Drawn by a small WebGL page in an offline web
// view (no network, no images). The drops are gaussian metaballs shaded as glass: they bend the
// sky behind them (with a little colour dispersion), light up along their rims in the tab lens's
// cool and warm fringes, catch a glint, and sit on a soft contact shadow. While the buddy listens,
// thinks or speaks, that mood's light rises from where the voice is (`glowAt`), the drops take
// its tint and move a little faster; the microphone level swells the light and the drops. Reduce
// motion draws a still frame (redrawn only when the mood changes). Until the page has drawn (and
// in tests, or without WebGL) a native stand-in shows the same sky as soft gradients.

export type Mood = 'idle' | 'listening' | 'thinking' | 'speaking';

type RGB = [number, number, number];

const rgb = (hex: string): RGB => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as RGB;
/** A token colour made lighter (k > 1) or darker, for the brighter tints the moods need. */
const lift = (c: RGB, k: number): RGB => c.map(v => Math.max(0, Math.min(255, Math.round(v * k)))) as RGB;
const unit = (c: RGB) => c.map(v => Math.round((v / 255) * 1000) / 1000);

/**
 * Each mood's colour, from the Dusk tokens: the cool white of direction lines at rest, the "you"
 * blue while listening, the dusk violet while thinking and the warm awning amber while speaking.
 */
export const MOOD_RGB: Record<Mood, RGB> = {
  idle: rgb(dusk.color.direction),
  listening: rgb(dusk.color.you),
  thinking: lift(rgb(sceneColors.tower.front), 1.6),
  speaking: lift(rgb(sceneColors.awnings.front), 1.9),
};

/** A mood's colour as a CSS colour with alpha, e.g. for Glass's tint. */
export function moodColor(mood: Mood, alpha: number): string {
  const [r, g, b] = MOOD_RGB[mood];
  return `rgba(${r},${g},${b},${alpha})`;
}

/** A mood's colour as '#RRGGBB' (e.g. Translate's warm and cool halves). */
export function moodHex(mood: Mood): string {
  return `#${MOOD_RGB[mood].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** How bright and how tinted the liquid gets in each mood (0-1). */
const MOOD_LIGHT: Record<Mood, { energy: number; amt: number }> = {
  idle: { energy: 0, amt: 0 },
  listening: { energy: 0.8, amt: 0.55 },
  thinking: { energy: 0.45, amt: 0.45 },
  speaking: { energy: 0.65, amt: 0.55 },
};

/** The sky, top to bottom: night blue, dusk plum, the warm afterglow (the scene tiles' grounds, darkened). */
const SKY = {
  top: lift(rgb(sceneColors.arches.ground), 0.3),
  mid: lift(rgb(sceneColors.tower.ground), 0.42),
  low: lift(rgb(sceneColors.awnings.ground), 0.38),
};

/**
 * The soft lights drifting in the sky: the "you" blue high up, the lens's pink fringe across the
 * middle and its warm fringe low down, like the last light of the day.
 */
export const LIGHTS: RGB[] = [rgb(dusk.color.you), rgb(dusk.color.fringePink), rgb(dusk.color.fringeWarm)];

/** The drops' own faint tints: the scene tiles' dusk blue, violet, teal and amber. */
const BLOBS: RGB[] = [
  rgb(sceneColors.arches.front),
  lift(rgb(sceneColors.tower.front), 1.3),
  rgb(sceneColors.river.front),
  lift(rgb(sceneColors.awnings.front), 1.5),
  rgb(sceneColors.arches.back),
];

/** Jest has no web view: keep the native stand-in there. */
function inTests(): boolean {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NODE_ENV === 'test';
}

/** Canvas pixels per CSS pixel: the field is smooth, so a low resolution upscaled looks the same. */
const SCALE = 0.6;
/** Frames a second while moving. */
const FPS = 30;

/**
 * The background, filling its parent. `mood` sets the light and tint, rising from `glowAt` (0 the
 * top, 1 the bottom, where Chat's microphone is); `level` (0-1, from useMicLevel's subscribe)
 * swells the light and the drops while the microphone hears something.
 */
export const LiquidBackground = React.memo(function LiquidBackground({
  mood = 'idle',
  glowAt = 1,
  subscribeLevel,
  style,
}: {
  mood?: Mood;
  /** Where the mood's light rises from: 0 the top of the screen, 1 the bottom. */
  glowAt?: number;
  /** Raw microphone levels as they arrive; returns an unsubscribe. */
  subscribeLevel?: (fn: (v: number) => void) => () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const reduce = useReduceMotion();
  const web = useRef<WebView<{}>>(null);
  const [ready, setReady] = useState(false);
  // The stand-in stays until the page has faded in over it (no dip to the bare ground between).
  const [covered, setCovered] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;

  // Built once per reduce-motion setting; the page follows its own size, so a window resize
  // doesn't reload it.
  const html = useMemo(() => (inTests() ? null : backgroundPage(reduce)), [reduce]);

  useEffect(() => {
    setReady(false);
    setCovered(false);
    opacity.setValue(0);
  }, [html, opacity]);

  // The mood, sent again once the page is (re)loaded.
  useEffect(() => {
    if (!ready) return;
    const m = MOOD_LIGHT[mood];
    // The page's y runs upwards.
    const msg = { energy: m.energy, amt: m.amt, tint: unit(MOOD_RGB[mood]), glowY: 1 - Math.max(0, Math.min(1, glowAt)) };
    web.current?.injectJavaScript?.(`window.__mood&&window.__mood(${JSON.stringify(msg)});true;`);
  }, [mood, glowAt, ready]);

  // The microphone level, at most about ten times a second (as the helper sends it).
  useEffect(() => {
    if (!ready || !subscribeLevel || reduce) return;
    let last = 0;
    return subscribeLevel(v => {
      const now = Date.now();
      if (now - last < 80 && v > 0) return;
      last = now;
      web.current?.injectJavaScript?.(`window.__level&&window.__level(${Math.round(v * 100) / 100});true;`);
    });
  }, [ready, subscribeLevel, reduce]);

  const onMessage = (e: WebViewMessageEvent) => {
    const m = e.nativeEvent.data;
    if (m === 'ready') {
      setReady(true);
      if (reduce) {
        opacity.setValue(1);
        setCovered(true);
      } else {
        Animated.timing(opacity, { toValue: 1, duration: 600, useNativeDriver: true }).start(({ finished }) => finished && setCovered(true));
      }
    } else if (m === 'lost') {
      // WebKit dropped the GL context (too many live ones): back to the stand-in.
      setReady(false);
      setCovered(false);
      opacity.setValue(0);
    } else if (m.startsWith('error:')) {
      console.warn('[liquid background]', m.slice(6));
    }
  };

  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: dusk.color.ground }, style]}>
      {!covered ? <StandIn mood={mood} glowAt={glowAt} /> : null}
      {html ? (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity }]}>
          <WebView<{}>
            ref={web}
            originWhitelist={['*']}
            source={{ html, baseUrl: 'about:blank' }}
            onMessage={onMessage}
            javaScriptEnabled
            scrollEnabled={false}
            style={styles.web}
          />
        </Animated.View>
      ) : null}
    </View>
  );
});

/** The native stand-in: the same sky (gradient and lights), plus the mood's light where it rises. */
function StandIn({ mood, glowAt }: { mood: Mood; glowAt: number }) {
  const box = useBox();
  const css = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;
  const spots: { id: string; cx: string; cy: string; r: string; c: RGB; a: number }[] = [
    { id: 'a', cx: '20%', cy: '14%', r: '60%', c: LIGHTS[0], a: 0.2 },
    { id: 'b', cx: '86%', cy: '48%', r: '55%', c: LIGHTS[1], a: 0.2 },
    { id: 'c', cx: '45%', cy: '98%', r: '60%', c: LIGHTS[2], a: 0.24 },
    ...(mood === 'idle' ? [] : [{ id: 'm', cx: '50%', cy: `${Math.round(glowAt * 100)}%`, r: '60%', c: MOOD_RGB[mood], a: 0.3 }]),
  ];
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} onLayout={box.onLayout}>
      {box.size ? (
        <Svg key={`${box.key}-${mood}-${glowAt}`} width={box.size.width} height={box.size.height} style={StyleSheet.absoluteFill}>
          <Defs>
            <LinearGradient id="lb-sky" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={css(SKY.top)} />
              <Stop offset="0.5" stopColor={css(SKY.mid)} />
              <Stop offset="1" stopColor={css(SKY.low)} />
            </LinearGradient>
            {spots.map(s => (
              <RadialGradient key={s.id} id={`lb-${s.id}`} cx={s.cx} cy={s.cy} r={s.r} gradientUnits="objectBoundingBox">
                <Stop offset="0" stopColor={css(s.c)} stopOpacity={s.a} />
                <Stop offset="0.5" stopColor={css(s.c)} stopOpacity={s.a * 0.4} />
                <Stop offset="1" stopColor={css(s.c)} stopOpacity={0} />
              </RadialGradient>
            ))}
          </Defs>
          <Rect x={0} y={0} width={box.size.width} height={box.size.height} fill="url(#lb-sky)" />
          {spots.map(s => (
            <Rect key={s.id} x={0} y={0} width={box.size!.width} height={box.size!.height} fill={`url(#lb-${s.id})`} />
          ))}
        </Svg>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: dusk.color.ground },
});

// --- The page.

function backgroundPage(still: boolean): string {
  const cfg = {
    still,
    scale: SCALE,
    fps: FPS,
    seed: 40 + Math.round(Math.random() * 400),
    sky: [SKY.top, SKY.mid, SKY.low].map(unit),
    lights: LIGHTS.map(unit),
    blobs: BLOBS.map(unit),
    fringe: [unit(rgb(dusk.color.fringeCool)), unit(rgb(dusk.color.fringeWarm))],
  };
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<style>html,body{margin:0;padding:0;overflow:hidden;background:${dusk.color.ground}}canvas{display:block;position:fixed;left:0;top:0;width:100vw;height:100vh}</style>` +
    '</head><body><canvas id="c"></canvas><script>window.__CFG__=' +
    JSON.stringify(cfg) +
    ';</script><script>' +
    RENDERER +
    '</script></body></html>'
  );
}

const RENDERER = String.raw`
(function () {
  var cfg = window.__CFG__;
  function post(m) { try { window.ReactNativeWebView.postMessage(m); } catch (e) {} }
  window.onerror = function (m) { post('error:' + m); };

  var canvas = document.getElementById('c');
  var opts = { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power' };
  var gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
  if (!gl) { post('error:no WebGL'); return; }

  var VERT = 'attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }';
  var FRAG = [
    'precision highp float;',
    'uniform vec2 uRes; uniform float uTime; uniform float uEnergy; uniform float uLevel;',
    'uniform vec3 uTint; uniform float uTintAmt; uniform float uGlowY;',
    'uniform vec3 uSky[3]; uniform vec3 uL[3]; uniform vec3 uC[5]; uniform vec3 uFringe[2];',
    'float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
    // A soft round light; d in units of the window height.
    'float lightAt(vec2 d, float r){ return exp(-dot(d, d) / (r * r)); }',
    // The sky at a point p (units of the window's shorter side, centred, y up), drops left out.
    'vec3 sky(vec2 p, vec2 ext, float t){',
    '  vec2 uv = p / (2.0 * ext) + 0.5;',
    '  vec2 k = vec2(ext.x / ext.y, 1.0);',
    '  vec3 col = mix(uSky[2], uSky[1], smoothstep(0.0, 0.55, uv.y));',
    '  col = mix(col, uSky[0], smoothstep(0.42, 1.0, uv.y));',
    '  col += uL[0] * 0.17 * lightAt((uv - vec2(0.2 + 0.14 * sin(t * 0.041), 0.84 + 0.06 * cos(t * 0.033))) * k, 0.4);',
    '  col += uL[1] * 0.12 * lightAt((uv - vec2(0.82 + 0.1 * cos(t * 0.029), 0.36 + 0.14 * sin(t * 0.023))) * k, 0.36);',
    '  col += uL[2] * 0.17 * lightAt((uv - vec2(0.4 + 0.28 * sin(t * 0.019), 0.0)) * k, 0.4);',
    // The mood's light, rising from where the voice is and swelling with it.
    '  float r = 0.42 + 0.1 * uEnergy + 0.22 * uLevel;',
    '  col += uTint * uTintAmt * (0.42 + 0.5 * uLevel) * lightAt((uv - vec2(0.5, uGlowY)) * k, r);',
    '  return col;',
    '}',
    'void main(){',
    '  float m = min(uRes.x, uRes.y);',
    '  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / m;',
    '  vec2 ext = 0.5 * uRes / m;',
    '  float t = uTime;',
    '  vec3 col = sky(p, ext, t);',
    // Five drops on slow Lissajous paths that cover the whole screen.
    '  float grow = 1.0 + 0.08 * uEnergy + 0.2 * uLevel;',
    '  float F = 0.0; vec3 C = vec3(0.0); vec2 G = vec2(0.0);',
    '  for (int i = 0; i < 5; i++) {',
    '    float f = float(i);',
    '    vec2 c = vec2(ext.x * 0.78 * sin(t * (0.067 + 0.017 * f) + f * 1.9), ext.y * 0.72 * cos(t * (0.051 + 0.013 * f) + f * 2.7));',
    '    float r = (0.17 + 0.04 * sin(t * 0.11 + f * 4.1)) * grow;',
    '    vec2 d = p - c;',
    '    float w = exp(-dot(d, d) / (r * r));',
    '    F += w; C += uC[i] * w; G += -2.0 * d / (r * r) * w;',
    '  }',
    // A soft contact shadow just outside each drop, so it floats over the sky.
    '  float body = smoothstep(0.5 - 0.02, 0.5 + 0.02, F);',
    '  col *= 1.0 - 0.22 * smoothstep(0.12, 0.5, F) * (1.0 - body);',
    '  if (body > 0.0) {',
    // A droplet: its surface rises steeply at the rim and is nearly flat inside.
    '    vec2 slope = G * (0.5 / sqrt(max(F - 0.5, 0.0) + 0.004)) * 0.05;',
    '    vec3 n = normalize(vec3(-slope, 1.0));',
    '    vec3 L = normalize(vec3(-0.5, 0.7, 0.55));',
    // The sky seen through the drop: bent by its surface, red, green and blue a little apart.
    '    vec2 o = -n.xy * 0.11;',
    '    vec3 seen = vec3(sky(p + o * 0.85, ext, t).r, sky(p + o, ext, t).g, sky(p + o * 1.15, ext, t).b);',
    '    vec3 tint = mix(C / max(F, 0.001), uTint, uTintAmt);',
    '    float lambert = max(dot(n, L), 0.0);',
    '    vec3 glass = seen * (1.04 + 0.05 * uEnergy) * (0.94 + 0.12 * lambert) + tint * (0.035 + 0.05 * uEnergy);',
    // Light gathered inside the drop on the side away from the light (a caustic).
    '    vec2 nd = normalize(n.xy + vec2(1e-4));',
    '    float away = max(dot(nd, -normalize(L.xy)), 0.0);',
    '    glass += mix(uFringe[1], tint, 0.4 + 0.4 * uTintAmt) * away * away * smoothstep(0.02, 0.5, length(n.xy)) * (0.16 + 0.16 * uEnergy);',
    // Rim light: cool on the lit side, warm on the far side (the tab lens's fringes).
    '    float fres = pow(1.0 - n.z, 1.3);',
    '    float side = dot(nd, normalize(L.xy)) * 0.5 + 0.5;',
    '    glass += mix(uFringe[1], uFringe[0], side) * fres * (0.3 + 0.2 * uEnergy);',
    '    glass += mix(vec3(1.0), tint, 0.3) * pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 28.0) * (0.5 + 0.2 * uEnergy);',
    '    col = mix(col, glass, body);',
    '  }',
    // Darker corners, and a little noise so the dark gradients never band.
    '  vec2 q = (gl_FragCoord.xy / uRes - 0.5) * 2.0 * ext / max(ext.x, ext.y);',
    '  col *= 1.0 - 0.3 * smoothstep(0.45, 1.35, length(q));',
    '  col += (hash(gl_FragCoord.xy + fract(t * 7.0)) - 0.5) * (2.0 / 255.0);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'].join('\n');

  function shader(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  var prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var aLoc = gl.getAttribLocation(prog, 'a');
  gl.enableVertexAttribArray(aLoc);
  gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);
  var U = {};
  ['uRes', 'uTime', 'uEnergy', 'uLevel', 'uTint', 'uTintAmt', 'uGlowY', 'uSky', 'uL', 'uC', 'uFringe'].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });
  function flat(list) { var out = []; list.forEach(function (c) { out.push(c[0], c[1], c[2]); }); return new Float32Array(out); }
  gl.uniform3fv(U.uSky, flat(cfg.sky));
  gl.uniform3fv(U.uL, flat(cfg.lights));
  gl.uniform3fv(U.uC, flat(cfg.blobs));
  gl.uniform3fv(U.uFringe, flat(cfg.fringe));

  function resize() {
    var w = Math.max(1, Math.round(window.innerWidth * cfg.scale));
    var h = Math.max(1, Math.round(window.innerHeight * cfg.scale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
  }

  var target = { energy: 0, amt: 0, level: 0, tint: [1, 1, 1], glowY: 0 };
  var cur = { energy: 0, amt: 0, level: 0, tint: [1, 1, 1], glowY: 0 };
  var time = cfg.seed;
  var lost = false;
  var announced = false;

  function draw() {
    if (lost) return;
    resize();
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, time);
    gl.uniform1f(U.uEnergy, cur.energy);
    gl.uniform1f(U.uLevel, cur.level);
    gl.uniform3f(U.uTint, cur.tint[0], cur.tint[1], cur.tint[2]);
    gl.uniform1f(U.uTintAmt, cur.amt);
    gl.uniform1f(U.uGlowY, cur.glowY);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!announced) { announced = true; post('ready'); }
  }

  function snap() {
    cur.energy = target.energy; cur.amt = target.amt; cur.level = 0; cur.glowY = target.glowY;
    cur.tint = target.tint.slice();
  }

  var last = 0;
  var raf = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (last && now - last < 1000 / (cfg.fps + 1)) return;
    var dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / cfg.fps;
    last = now;
    var k = 1 - Math.exp(-dt * 2.2);
    var kl = 1 - Math.exp(-dt * 9);
    cur.energy += (target.energy - cur.energy) * k;
    cur.amt += (target.amt - cur.amt) * k;
    cur.glowY += (target.glowY - cur.glowY) * k;
    for (var i = 0; i < 3; i++) cur.tint[i] += (target.tint[i] - cur.tint[i]) * k;
    cur.level += (target.level - cur.level) * kl;
    time += dt * (1 + 1.2 * cur.energy);
    draw();
  }

  window.__mood = function (m) {
    target.energy = m.energy; target.amt = m.amt;
    if (m.tint && m.amt > 0) {
      // A light that was off rises from the new place instead of sliding there.
      if (cur.amt < 0.02 && typeof m.glowY === 'number') cur.glowY = m.glowY;
      target.tint = m.tint;
      if (typeof m.glowY === 'number') target.glowY = m.glowY;
    }
    if (m.energy === 0) target.level = 0;
    if (cfg.still) { snap(); draw(); }
  };
  window.__level = function (v) { target.level = Math.max(0, Math.min(1, v)); };

  canvas.addEventListener('webglcontextlost', function (e) {
    e.preventDefault();
    lost = true;
    cancelAnimationFrame(raf);
    post('lost');
  });
  window.addEventListener('resize', function () { if (cfg.still) draw(); });

  if (cfg.still) draw();
  else raf = requestAnimationFrame(frame);
})();
`;
