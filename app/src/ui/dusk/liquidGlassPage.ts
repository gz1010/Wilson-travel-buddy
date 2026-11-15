// The page inside LiquidGlass's web view: a photo with words in 3D liquid glass over it, drawn
// with WebGL in one pass after two blur passes, so it needs no library and no network.
// After ektogamat/apple-liquid-glass (three.js Text3D in a MeshPhysicalMaterial: transmission,
// ior 1.8, roughness 0.23, iridescence, dispersion 12), done the way its README suggests for
// speed: a shader that bends the photo through the letters instead of real 3D meshes.
//
// 1. The photo is drawn cover-fit with the card's dark fade into a canvas (the background).
// 2. The words are drawn white on black into a second canvas (the mask), in the system font
//    (SF Pro Heavy, so no font is loaded), each line made smaller if it would not fit the width.
// 3. The mask is blurred (two passes) into a height map: flat inside the letters, falling off at
//    the edges like a bevel, so thin strokes come out rounded like poured glass.
// 4. One fragment shader: normals from the height map bend the photo (refraction), the red, green
//    and blue channels bend by different amounts (dispersion), a few taps soften it (frost), and
//    a Fresnel rim, two specular lobes, a thin-film tint (iridescence), an extruded side wall below
//    the letters and a drop shadow make it read as a solid piece of glass.
// The light follows the pointer when the page receives it.

export interface LiquidGlassLine {
  text: string;
  /** Font size in px. */
  size: number;
  /** Baseline in px above the bottom edge; negative sinks the word below it. */
  baseline: number;
}

export interface LiquidGlassConfig {
  width: number;
  height: number;
  photo: string;
  lines: LiquidGlassLine[];
  align: 'center' | 'left';
  /** Left padding when align is 'left'; the room kept on both sides when a line must shrink. */
  inset: number;
  /** Letter spacing in em. */
  tracking: number;
  /** The dark fade over the photo, as [position 0-1 from the top, alpha] stops. */
  fade: [number, number][];
}

export function liquidGlassPage(cfg: LiquidGlassConfig): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>html,body{margin:0;padding:0;overflow:hidden;background:#0E0F14}canvas{display:block;width:100vw;height:100vh}</style>' +
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

  var dpr = Math.min(2, window.devicePixelRatio || 1);
  var W = Math.max(1, Math.round(cfg.width * dpr));
  var H = Math.max(1, Math.round(cfg.height * dpr));
  var canvas = document.getElementById('c');
  canvas.width = W; canvas.height = H;

  var VERT = 'attribute vec2 p; varying vec2 v; void main(){ v = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }';
  var BLUR = [
    'precision highp float;',
    'uniform sampler2D t; uniform vec2 dir; uniform float sigma; varying vec2 v;',
    'void main(){',
    '  float s = 0.0; float w = 0.0;',
    '  for (int i = -48; i <= 48; i++) {',
    '    float x = float(i);',
    '    if (abs(x) > sigma * 3.0) continue;',
    '    float k = exp(-x * x / (2.0 * sigma * sigma));',
    '    s += texture2D(t, v + dir * x).r * k; w += k;',
    '  }',
    '  gl_FragColor = vec4(s / w, 0.0, 0.0, 1.0);',
    '}'].join('\n');
  var GLASS = [
    'precision highp float;',
    'uniform sampler2D uBg; uniform sampler2D uMask; uniform sampler2D uH;',
    'uniform vec2 uE; uniform vec3 uLight;',
    'uniform float uRefract; uniform float uDisp; uniform float uFrost; uniform float uDepth;',
    'uniform float uShadow; uniform float uBevel; uniform float uIrid; uniform float uSpec;',
    'varying vec2 v;',
    'float M(vec2 q){ return texture2D(uMask, q).r; }',
    'float Hh(vec2 q){ return texture2D(uH, q).r; }',
    'vec3 P(vec2 q){ return texture2D(uBg, clamp(q, vec2(0.001), vec2(0.999))).rgb; }',
    'vec3 F(vec2 q){',
    '  vec2 d = uFrost * uE;',
    '  return P(q) * 0.36 + (P(q + vec2(d.x, 0.0)) + P(q - vec2(d.x, 0.0)) + P(q + vec2(0.0, d.y)) + P(q - vec2(0.0, d.y))) * 0.11',
    '       + (P(q + d) + P(q - d) + P(q + vec2(d.x, -d.y)) + P(q + vec2(-d.x, d.y))) * 0.05;',
    '}',
    'void main(){',
    '  vec2 q = v;',
    '  float m = M(q);',
    '  float k = 1.5;',
    '  float gx = (Hh(q + vec2(k * uE.x, 0.0)) - Hh(q - vec2(k * uE.x, 0.0))) / (2.0 * k);',
    '  float gy = (Hh(q + vec2(0.0, k * uE.y)) - Hh(q - vec2(0.0, k * uE.y))) / (2.0 * k);',
    '  vec3 n = normalize(vec3(-gx * uBevel, -gy * uBevel, 1.0));',
    '  vec3 L = normalize(uLight);',
    // Background: the photo, darkened under the letters by a soft drop shadow.
    '  vec3 col = P(q);',
    '  float sh = Hh(q + vec2(-uShadow * 0.35 * uE.x, uShadow * uE.y));',
    '  col *= 1.0 - 0.5 * smoothstep(0.02, 0.7, sh);',
    // The extruded side wall: where the face sits just above this pixel.
    '  float side = 0.0; float far = 0.0;',
    '  for (int i = 1; i <= 10; i++) {',
    '    float t = float(i) / 10.0 * uDepth;',
    '    float s = M(q + vec2(-t * 0.25 * uE.x, t * uE.y));',
    '    if (s > side) { side = s; far = float(i) / 10.0; }',
    '  }',
    '  vec3 wall = F(q + vec2(0.0, uDepth * 1.5 * uE.y)) * 0.72 + vec3(0.05);',
    '  wall += vec3(0.38) * smoothstep(0.8, 1.0, far);',
    '  col = mix(col, wall, side * (1.0 - m));',
    // The face: the photo bent through the bevel, channel by channel, softened, lit.
    '  vec2 off = n.xy * uRefract * uE;',
    '  vec3 g;',
    '  g.r = F(q + off * (1.0 - uDisp)).r;',
    '  g.g = F(q + off).g;',
    '  g.b = F(q + off * (1.0 + uDisp)).b;',
    '  g = g * 0.95 + vec3(0.04);',
    '  g *= 0.9 + 0.22 * max(dot(n, L), 0.0);',
    '  float fr = pow(1.0 - n.z, 1.6);',
    '  vec3 Hv = normalize(L + vec3(0.0, 0.0, 1.0));',
    '  float nh = max(dot(n, Hv), 0.0);',
    '  float spec = pow(nh, 90.0) * 1.3 + pow(nh, 16.0) * 0.16;',
    '  vec3 film = 0.5 + 0.5 * cos(6.2831 * (fr * 1.6 + vec3(0.0, 0.33, 0.67)));',
    '  g += fr * 0.38 + spec * uSpec + film * fr * uIrid;',
    '  float top = smoothstep(0.0, 0.06, Hh(q - vec2(0.0, 3.0 * uE.y)) - Hh(q));',
    '  g += vec3(0.25) * max(top, 0.0);',
    '  col = mix(col, clamp(g, 0.0, 1.0), m);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'].join('\n');

  function compile(gl, type, src) {
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(gl, fs) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'p');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  function texture(gl, source) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  // A render target; half float where the GPU can render to it, so the bevel has no banding.
  function target(gl, gl2, half) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (gl2 && half) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, W, H, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return ok ? { tex: t, fb: f } : null;
  }

  function drawBackground(img) {
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var x = c.getContext('2d');
    x.fillStyle = '#0E0F14'; x.fillRect(0, 0, W, H);
    var s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
    var w = img.naturalWidth * s, h = img.naturalHeight * s;
    x.imageSmoothingQuality = 'high';
    x.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    var gr = x.createLinearGradient(0, 0, 0, H);
    cfg.fade.forEach(function (st) { gr.addColorStop(st[0], 'rgba(14,15,20,' + st[1] + ')'); });
    x.fillStyle = gr; x.fillRect(0, 0, W, H);
    return c;
  }

  // A line too wide for the box (inside the inset, at least 6 px, on both sides: GlassWord's
  // glassLinePad) is drawn smaller; a sunk baseline shrinks with it, so the same share of the
  // letters stays below the edge.
  var FONT = '-apple-system, system-ui, "Helvetica Neue", sans-serif';
  var pad = Math.max(6, cfg.inset) * dpr;
  function fitLines() {
    var m = document.createElement('canvas').getContext('2d');
    return cfg.lines.map(function (line) {
      var size = line.size * dpr;
      var chars = Array.from(line.text);
      function width(sz) {
        m.font = '800 ' + sz + 'px ' + FONT;
        var w = 0;
        chars.forEach(function (ch) { w += m.measureText(ch).width; });
        return w + cfg.tracking * sz * Math.max(0, chars.length - 1);
      }
      var room = W - 2 * pad;
      var total = width(size);
      var baseline = line.baseline * dpr;
      if (room > 0 && total > room) {
        var f = room / total;
        // Measured again at the new size: optical sizes make small letters a little wider.
        for (var i = 0; i < 3 && total > room; i++) {
          size = Math.max(8 * dpr, size * f);
          total = width(size);
          f = room / total;
        }
        if (baseline < 0) baseline *= size / (line.size * dpr);
      }
      return { text: line.text, chars: chars, size: size, baseline: baseline };
    });
  }
  var fitted = fitLines();

  function drawMask() {
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#fff';
    x.textBaseline = 'alphabetic';
    fitted.forEach(function (line) {
      var size = line.size;
      var track = cfg.tracking * size;
      x.font = '800 ' + size + 'px ' + FONT;
      var widths = line.chars.map(function (ch) { return x.measureText(ch).width; });
      var total = widths.reduce(function (a, b) { return a + b; }, 0) + track * Math.max(0, line.chars.length - 1);
      var px = cfg.align === 'center' ? (W - total) / 2 : cfg.inset * dpr;
      var py = H - line.baseline;
      line.chars.forEach(function (ch, i) { x.fillText(ch, px, py); px += widths[i] + track; });
    });
    return c;
  }

  function sizeOf(lines) { return lines.reduce(function (a, l) { return Math.max(a, l.size); }, 0); }

  function start(img) {
    var gl2 = true;
    var gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, premultipliedAlpha: false });
    if (!gl) { gl2 = false; gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: false, premultipliedAlpha: false }); }
    if (!gl) throw new Error('no webgl');
    var half = gl2 && !!gl.getExtension('EXT_color_buffer_float');

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    var blur = program(gl, BLUR);
    var glass = program(gl, GLASS);
    var bgTex = texture(gl, drawBackground(img));
    var maskTex = texture(gl, drawMask());
    var a = target(gl, gl2, half) || target(gl, gl2, false);
    var b = target(gl, gl2, half) || target(gl, gl2, false);

    var px = sizeOf(fitted);
    var sigma = Math.max(2, Math.min(16, px * 0.04));
    gl.viewport(0, 0, W, H);

    // Height map: the mask blurred across, then down.
    gl.useProgram(blur);
    gl.uniform1i(gl.getUniformLocation(blur, 't'), 0);
    gl.uniform1f(gl.getUniformLocation(blur, 'sigma'), sigma);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb);
    gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.uniform2f(gl.getUniformLocation(blur, 'dir'), 1 / W, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, b.fb);
    gl.bindTexture(gl.TEXTURE_2D, a.tex);
    gl.uniform2f(gl.getUniformLocation(blur, 'dir'), 0, 1 / H);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    gl.useProgram(glass);
    function u(n) { return gl.getUniformLocation(glass, n); }
    gl.uniform1i(u('uBg'), 0); gl.uniform1i(u('uMask'), 1); gl.uniform1i(u('uH'), 2);
    gl.uniform2f(u('uE'), 1 / W, 1 / H);
    gl.uniform1f(u('uRefract'), px * 0.24);
    gl.uniform1f(u('uDisp'), 0.22);
    gl.uniform1f(u('uFrost'), Math.max(1, px * 0.012));
    gl.uniform1f(u('uDepth'), Math.max(2, px * 0.05));
    gl.uniform1f(u('uShadow'), Math.max(3, px * 0.07));
    gl.uniform1f(u('uBevel'), sigma * 2.6);
    gl.uniform1f(u('uIrid'), 0.5);
    gl.uniform1f(u('uSpec'), 1.0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, bgTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, b.tex);

    var light = [-0.45, 0.85, 0.7];
    function render() {
      gl.uniform3f(u('uLight'), light[0], light[1], light[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    render();
    post('ready');

    var pending = false;
    window.addEventListener('mousemove', function (e) {
      light = [(e.clientX / cfg.width - 0.5) * 1.6, (0.5 - e.clientY / cfg.height) * 1.6 + 0.35, 0.7];
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; render(); });
    });
  }

  try {
    var img = new Image();
    img.onload = function () {
      try { start(img); } catch (e) { post('error:' + (e && e.message)); }
    };
    img.onerror = function () { post('error:photo'); };
    img.src = cfg.photo;
  } catch (e) {
    post('error:' + (e && e.message));
  }
})();
`;
