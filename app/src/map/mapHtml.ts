// Builds the self-contained HTML page for the map web view: MapLibre GL JS
// and the vector tiles are inlined, so nothing is fetched from anywhere.
// Pins are HTML elements rather than map symbols, so no font files are needed.
//
// Dusk has three layers: dark (the default), light (the same vector tiles in a white style) and
// aerial (IGN's orthophotos, baked in by scripts/build-aerial.mjs). The aerial photos stay on the
// React Native side (MapView.tsx) and reach the page one tile at a time, as MapLibre asks for
// them, so the page itself stays small and the photos cost nothing until Aerial is chosen.

const maplibre: { js: string; css: string } = require('buddy-maplibre');
const tileSet: { minzoom: number; maxzoom: number; tiles: Record<string, string> | null } = require('buddy-tiles');

/** The baked aerial photos: base64 JPEG tiles keyed "z/x/y", or no tiles when never built. */
export interface AerialSet {
  source?: string;
  /** The credit the licence asks for at the foot of the map. */
  attribution: string;
  fetchedAt?: string;
  minzoom: number;
  maxzoom: number;
  /** [west, south, east, north] the tiles cover. */
  bounds: [number, number, number, number] | null;
  tiles: Record<string, string> | null;
}
const NO_AERIAL: AerialSet = { attribution: '', minzoom: 0, maxzoom: 0, bounds: null, tiles: null };
function loadAerial(): AerialSet {
  // In a try block Metro treats it as optional: a Metro started before the buddy-aerial alias
  // existed bundles the app without the photos instead of failing (restart it to get them).
  try {
    return require('buddy-aerial');
  } catch {
    return NO_AERIAL;
  }
}
export const aerial: AerialSet = loadAerial();

export const hasTiles = !!tileSet.tiles;
export const hasAerial = !!aerial.tiles && !!aerial.bounds && aerial.maxzoom >= aerial.minzoom && Object.keys(aerial.tiles).length > 0;

const escapeScript = (s: string) => s.replace(/<\/script/gi, '<\\/script');

/** Degrees the map lets you pan past the destination's bounds (its maxBounds). */
export const PAN_MARGIN = 0.005;

export type MapTheme = 'classic' | 'dusk';
/** Dusk's base maps. */
export type MapLayer = 'dark' | 'light' | 'aerial';

/** Map colours per style. Dusk dark: low-contrast dark streets so glass pins glow. Light: the "white map". */
export const MAP_PALETTES = {
  classic: { bg: '#efe9df', earth: '#f3efe7', parks: '#d3e6c4', water: '#a8cbe0', buildings: '#e2dbcf', buildingLine: '#d4ccbe', casing: '#d8d0c2', highway: '#f6d38a', major: '#fbe7b5', street: '#ffffff', route: '#ffffff', you: '#1d7cf2', accFill: 0.12, accLine: 0.55 },
  dark: { bg: '#12141B', earth: '#12141B', parks: '#17221D', water: '#1A2632', buildings: '#1B1E27', buildingLine: '#1B1E27', casing: '#12141B', highway: '#3A3F4D', major: '#343947', street: '#2B2F3B', route: '#ffffff', you: '#8FB8FF', accFill: 0.12, accLine: 0.55 },
  light: { bg: '#ECE9E4', earth: '#F4F2EE', parks: '#D9E7D0', water: '#B7D0E4', buildings: '#E7E3DC', buildingLine: '#D8D2C8', casing: '#D9D3C9', highway: '#FFFFFF', major: '#FFFFFF', street: '#FFFFFF', route: '#262A35', you: '#2F74FF', accFill: 0.12, accLine: 0.6 },
  /** Under the photos: only the background shows (while a tile loads), and the route and dot colours. */
  aerial: { bg: '#2A2C27', earth: '#2A2C27', parks: '#2A2C27', water: '#2A2C27', buildings: '#2A2C27', buildingLine: '#2A2C27', casing: '#2A2C27', highway: '#2A2C27', major: '#2A2C27', street: '#2A2C27', route: '#ffffff', you: '#8FB8FF', accFill: 0.2, accLine: 0.95 },
};

// Dusk pins: plan = white ring, suggestion = clear glass, chosen = glass orb, you = a glowing blue
// dot with a pulse. On the light map the glass is smoked (dark) so it shows on white; on the
// photos it gets stronger shadows.
const DUSK_CSS = `
html, body, #map { background: #12141B; font-family: -apple-system, system-ui, sans-serif; }
.dot { width: 8px; height: 8px; background: rgba(255,255,255,.32); border: 0; box-shadow: none; }
.pin.stop .dot { width: 16px; height: 16px; background: transparent; border: 2.5px solid rgba(255,255,255,.85); box-sizing: border-box; font-size: 0; }
.pin.rec .dot { width: 30px; height: 30px; color: #fff; font-weight: 700; font-size: 12px; text-shadow: 0 1px 2px rgba(0,0,0,.4);
  background: linear-gradient(135deg, rgba(255,255,255,.22), rgba(255,255,255,.06)); -webkit-backdrop-filter: blur(6px) saturate(180%); backdrop-filter: blur(6px) saturate(180%);
  border: 1px solid rgba(255,255,255,.32); box-shadow: inset 0 1px 1px rgba(255,255,255,.7), 0 4px 12px rgba(0,0,0,.3); }
.pin.focus .dot { transform: none; width: 44px; height: 44px; font-size: 15px; color: #fff;
  background: radial-gradient(circle at 32% 24%, rgba(255,255,255,.85) 0%, rgba(255,255,255,.3) 24%, rgba(255,255,255,.1) 58%, rgba(255,255,255,.22) 100%);
  border: 1px solid rgba(255,255,255,.6); box-shadow: inset 0 1px 1px #fff, inset 1px 0 0 rgba(255,140,140,.3), inset -1px 0 0 rgba(140,190,255,.32), 0 0 30px 6px rgba(255,255,255,.14), 0 8px 20px rgba(0,0,0,.4); }
.label { background: linear-gradient(135deg, rgba(255,255,255,.16), rgba(255,255,255,.04)); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,.22); color: #F4EFE8; font-weight: 600; box-shadow: inset 0 1px 1px rgba(255,255,255,.4); border-radius: 999px; padding: 3px 8px; }
.you { width: 18px; height: 18px; }
.you .core { background: #8FB8FF; border: 3px solid rgba(255,255,255,.95); box-shadow: 0 0 14px 4px rgba(143,184,255,.65), 0 1px 3px rgba(0,0,0,.45); }
.you .halo { display: block; background: rgba(143,184,255,.42); animation: youpulse 2.4s ease-out infinite; }
@keyframes youpulse { 0% { transform: scale(1); opacity: .75; } 100% { transform: scale(3.6); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .you .halo { animation: none; transform: scale(2.2); opacity: .3; } }
.maplibregl-ctrl-group { background: rgba(255,255,255,.08); }
.notiles { background: rgba(255,255,255,.08); color: #D0C8BE; }

.layer-light .pin.place .dot { background: rgba(30,32,40,.4); }
.layer-light .pin.stop .dot { border-color: rgba(30,32,40,.85); }
.layer-light .pin.rec .dot { background: linear-gradient(135deg, rgba(24,26,34,.74), rgba(24,26,34,.52)); border-color: rgba(255,255,255,.55);
  box-shadow: inset 0 1px 1px rgba(255,255,255,.45), 0 4px 12px rgba(0,0,0,.22); }
.layer-light .pin.focus .dot { background: radial-gradient(circle at 32% 24%, rgba(150,158,180,.95) 0%, rgba(52,56,70,.88) 30%, rgba(24,26,34,.82) 70%, rgba(40,44,56,.86) 100%);
  border-color: rgba(255,255,255,.75); box-shadow: inset 0 1px 1px rgba(255,255,255,.85), inset 1px 0 0 rgba(255,140,140,.3), inset -1px 0 0 rgba(140,190,255,.32), 0 0 26px 4px rgba(24,26,34,.16), 0 8px 18px rgba(0,0,0,.28); }
.layer-light .label, .layer-aerial .label { background: linear-gradient(135deg, rgba(20,22,30,.7), rgba(20,22,30,.5)); border-color: rgba(255,255,255,.32); color: #fff; }
.layer-light .you .core { background: #2F74FF; border-color: #fff; box-shadow: 0 0 12px 3px rgba(47,116,255,.45), 0 1px 3px rgba(0,0,0,.3); }
.layer-light .you .halo { background: rgba(47,116,255,.3); }
.layer-aerial .pin.place .dot { background: rgba(255,255,255,.78); box-shadow: 0 0 0 1.5px rgba(0,0,0,.35), 0 1px 3px rgba(0,0,0,.5); }
.layer-aerial .pin.stop .dot { box-shadow: 0 0 0 1px rgba(0,0,0,.35), 0 1px 4px rgba(0,0,0,.5); }
.layer-aerial .pin.rec .dot { background: linear-gradient(135deg, rgba(20,22,30,.5), rgba(20,22,30,.28)); box-shadow: inset 0 1px 1px rgba(255,255,255,.7), 0 4px 14px rgba(0,0,0,.5); }
.layer-aerial .pin.focus .dot { box-shadow: inset 0 1px 1px #fff, inset 1px 0 0 rgba(255,140,140,.3), inset -1px 0 0 rgba(140,190,255,.32), 0 0 30px 6px rgba(255,255,255,.2), 0 8px 22px rgba(0,0,0,.6); }
.layer-aerial .notiles, .layer-light .notiles { display: none; }
`;

export interface MapHtmlOptions {
  /** Dusk only: the layer the page starts with (later changes go through window.buddyLayer). */
  layer?: MapLayer;
}

export function buildMapHtml(bounds: [number, number, number, number], theme: MapTheme = 'classic', options: MapHtmlOptions = {}): string {
  const dusk = theme === 'dusk';
  const palettes = dusk ? { dark: MAP_PALETTES.dark, light: MAP_PALETTES.light, aerial: MAP_PALETTES.aerial } : { classic: MAP_PALETTES.classic };
  const startLayer = dusk ? (options.layer === 'aerial' && !hasAerial ? 'dark' : options.layer ?? 'dark') : 'classic';
  const aerialConfig = dusk && hasAerial ? { minzoom: aerial.minzoom, maxzoom: aerial.maxzoom, bounds: aerial.bounds, attribution: aerial.attribution } : null;
  const config = { bounds, pan: PAN_MARGIN, minzoom: tileSet.minzoom, maxzoom: tileSet.maxzoom, hasTiles, palettes, layer: startLayer, theme, aerial: aerialConfig };
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${maplibre.css}
html, body, #map { margin: 0; height: 100%; background: #efe9df; font-family: -apple-system, system-ui, sans-serif; }
.pin { cursor: pointer; display: flex; flex-direction: column; align-items: center; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: #b9a58a; border: 2px solid #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3); }
.pin.rec .dot { width: 26px; height: 26px; background: #e4572e; color: #fff; font-weight: 700; font-size: 13px; display: flex; align-items: center; justify-content: center; }
.pin.stop .dot { width: 20px; height: 20px; background: #2d6a4f; color: #fff; font-size: 12px; display: flex; align-items: center; justify-content: center; }
.pin.focus .dot { transform: scale(1.35); box-shadow: 0 0 0 6px rgba(228,87,46,.25); }
.label { margin-top: 3px; padding: 2px 6px; border-radius: 6px; background: rgba(255,255,255,.92); font-size: 11px; font-weight: 600; color: #222; white-space: nowrap; box-shadow: 0 1px 2px rgba(0,0,0,.2); }
.pin:not(.rec):not(.stop):not(.focus) .label { display: none; }
.pin:hover .label { display: block !important; }
.label { transition: opacity .16s ease; }
.label.crowded { opacity: 0; pointer-events: none; }
.pin:hover { z-index: 5; }
.pin:hover .label.crowded { opacity: 1; }
.you { width: 22px; height: 22px; pointer-events: none; } /* MapLibre's .maplibregl-marker makes it absolute: never override that */
.you .core, .you .halo { position: absolute; left: 0; top: 0; right: 0; bottom: 0; border-radius: 50%; box-sizing: border-box; }
.you .core { background: #1d7cf2; border: 3px solid #fff; box-shadow: 0 0 0 8px rgba(29,124,242,.2); }
.you .halo { display: none; }
.notiles { position: absolute; left: 8px; bottom: 8px; font-size: 11px; color: #776; background: rgba(255,255,255,.8); padding: 3px 6px; border-radius: 4px; }
${dusk ? DUSK_CSS : ''}
</style>
</head><body class="layer-${startLayer}">
<div id="map"></div>
<script>${escapeScript(maplibre.js)}</script>
<script>const TILES = ${tileSet.tiles ? JSON.stringify(tileSet.tiles) : 'null'};</script>
<script>
(function () {
  const CONFIG = ${JSON.stringify(config)};
  const post = m => window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(m));
  window.onerror = (msg) => post({ type: 'log', message: String(msg) });

  function b64ToBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  if (TILES) {
    maplibregl.addProtocol('buddy', async params => {
      const b64 = TILES[params.url.replace('buddy://', '')];
      return { data: b64 ? b64ToBuffer(b64) : new ArrayBuffer(0) };
    });
  }
  // Aerial photos: ask React Native for each tile (window.buddyAerialTile answers).
  const aerialWaiting = new Map();
  let aerialSeq = 0;
  if (CONFIG.aerial) {
    maplibregl.addProtocol('aerial', (params, abort) => new Promise((resolve, reject) => {
      const id = ++aerialSeq;
      aerialWaiting.set(id, { resolve, reject });
      if (abort && abort.signal) abort.signal.addEventListener('abort', () => { if (aerialWaiting.delete(id)) reject(new Error('aborted')); });
      post({ type: 'aerial', id, key: params.url.replace('aerial://', '') });
    }));
  }
  window.buddyAerialTile = function (id, b64) {
    const waiting = aerialWaiting.get(id);
    if (!waiting) return;
    aerialWaiting.delete(id);
    if (b64) waiting.resolve({ data: b64ToBuffer(b64) });
    else waiting.reject(new Error('no aerial tile'));
  };

  // Layer names follow the Protomaps basemap schema (earth, landuse, water, roads, buildings).
  const src = 'osm';
  const LAYER = CONFIG.palettes[CONFIG.layer] ? CONFIG.layer : Object.keys(CONFIG.palettes)[0];
  const P = CONFIG.palettes[LAYER];
  const VECTOR = ['earth', 'parks', 'water', 'waterways', 'buildings', 'roads-casing', 'roads'];
  const vis = on => ({ visibility: on ? 'visible' : 'none' });
  const roadColor = p => ['match', ['get', 'kind'], 'highway', p.highway, 'major_road', p.major, p.street];
  const layers = [{ id: 'bg', type: 'background', paint: { 'background-color': P.bg } }];
  if (TILES) {
    const v = vis(LAYER !== 'aerial');
    layers.push(
      { id: 'earth', type: 'fill', source: src, 'source-layer': 'earth', layout: v, paint: { 'fill-color': P.earth } },
      { id: 'parks', type: 'fill', source: src, 'source-layer': 'landuse', layout: v, filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['in', ['get', 'kind'], ['literal', ['park', 'garden', 'grass', 'forest', 'wood', 'cemetery', 'pitch', 'playground']]]], paint: { 'fill-color': P.parks } },
      { id: 'water', type: 'fill', source: src, 'source-layer': 'water', layout: v, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': P.water } },
      { id: 'waterways', type: 'line', source: src, 'source-layer': 'water', layout: v, filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': P.water, 'line-width': 2 } },
      { id: 'buildings', type: 'fill', source: src, 'source-layer': 'buildings', layout: v, minzoom: 14, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': P.buildings, 'fill-outline-color': P.buildingLine } },
      { id: 'roads-casing', type: 'line', source: src, 'source-layer': 'roads', layout: v, paint: { 'line-color': P.casing, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 16, 9] } },
      { id: 'roads', type: 'line', source: src, 'source-layer': 'roads', layout: v, paint: { 'line-color': roadColor(P), 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 16, 7] } }
    );
  }
  if (CONFIG.aerial) {
    layers.push({ id: 'aerial', type: 'raster', source: 'aerial', layout: vis(LAYER === 'aerial'), paint: { 'raster-fade-duration': 150 } });
  }
  // How sure the position is: a soft disc and ring (only when macOS gave an accuracy).
  layers.push(
    { id: 'you-acc-fill', type: 'fill', source: 'you-acc', paint: { 'fill-color': P.you, 'fill-opacity': P.accFill } },
    { id: 'you-acc-line', type: 'line', source: 'you-acc', paint: { 'line-color': P.you, 'line-opacity': P.accLine, 'line-width': 1.5 } }
  );
  // A straight dashed line from you to the chosen place: direction, not turn-by-turn routing.
  layers.push({ id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round' }, paint: { 'line-color': P.route, 'line-opacity': 0.9, 'line-width': 3, 'line-dasharray': [0.7, 2.4] } });
  const empty = { type: 'FeatureCollection', features: [] };
  const style = { version: 8, sources: { route: { type: 'geojson', data: empty }, 'you-acc': { type: 'geojson', data: empty } }, layers };
  if (TILES) style.sources[src] = { type: 'vector', tiles: ['buddy://{z}/{x}/{y}'], minzoom: CONFIG.minzoom, maxzoom: CONFIG.maxzoom, attribution: '© OpenStreetMap contributors' };
  if (CONFIG.aerial) {
    style.sources.aerial = { type: 'raster', tiles: ['aerial://{z}/{x}/{y}'], tileSize: 256, minzoom: CONFIG.aerial.minzoom, maxzoom: CONFIG.aerial.maxzoom, bounds: CONFIG.aerial.bounds, attribution: CONFIG.aerial.attribution };
  }

  const b = CONFIG.bounds;
  const map = new maplibregl.Map({ container: 'map', style, bounds: [[b[0], b[1]], [b[2], b[3]]], maxBounds: [[b[0] - CONFIG.pan, b[1] - CONFIG.pan], [b[2] + CONFIG.pan, b[3] + CONFIG.pan]], attributionControl: { compact: true } });
  // Dusk has its own glass search bar in that corner; zoom with the trackpad there.
  if (CONFIG.theme !== 'dusk') map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  if (!CONFIG.hasTiles) {
    const note = document.createElement('div');
    note.className = 'notiles';
    note.textContent = 'No map tiles bundled: run scripts/build-tiles.mjs';
    document.body.appendChild(note);
  }

  map.on('click', e => post({ type: 'press', lat: e.lngLat.lat, lon: e.lngLat.lng }));
  // A missing aerial tile or an aborted request is expected; pass anything else on to the app's log.
  map.on('error', e => {
    const message = e && e.error && e.error.message ? String(e.error.message) : '';
    if (message && !/aerial|abort/i.test(message)) post({ type: 'log', message: 'map: ' + message });
  });

  // Paint, route and accuracy changes need the style; until it has loaded, keep the latest.
  let styleReady = false;
  let layerNow = LAYER;
  let routeNow = null;
  let accNow = null;
  function applyLayer() {
    const p = CONFIG.palettes[layerNow];
    map.setPaintProperty('bg', 'background-color', p.bg);
    if (TILES) {
      for (const id of VECTOR) map.setLayoutProperty(id, 'visibility', layerNow === 'aerial' ? 'none' : 'visible');
      map.setPaintProperty('earth', 'fill-color', p.earth);
      map.setPaintProperty('parks', 'fill-color', p.parks);
      map.setPaintProperty('water', 'fill-color', p.water);
      map.setPaintProperty('waterways', 'line-color', p.water);
      map.setPaintProperty('buildings', 'fill-color', p.buildings);
      map.setPaintProperty('buildings', 'fill-outline-color', p.buildingLine);
      map.setPaintProperty('roads-casing', 'line-color', p.casing);
      map.setPaintProperty('roads', 'line-color', roadColor(p));
    }
    if (CONFIG.aerial) map.setLayoutProperty('aerial', 'visibility', layerNow === 'aerial' ? 'visible' : 'none');
    map.setPaintProperty('route', 'line-color', p.route);
    map.setPaintProperty('you-acc-fill', 'fill-color', p.you);
    map.setPaintProperty('you-acc-fill', 'fill-opacity', p.accFill);
    map.setPaintProperty('you-acc-line', 'line-color', p.you);
    map.setPaintProperty('you-acc-line', 'line-opacity', p.accLine);
  }
  function applyData() {
    map.getSource('route').setData(routeNow ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: routeNow } } : empty);
    map.getSource('you-acc').setData(accNow ? circle(accNow.lon, accNow.lat, accNow.meters) : empty);
  }
  map.on('style.load', () => {
    styleReady = true;
    try { applyLayer(); applyData(); } catch (e) { post({ type: 'log', message: 'style.load: ' + e.message }); }
  });

  /** Switches the base map: 'dark', 'light' or 'aerial' (Dusk only). */
  window.buddyLayer = function (name) {
    if (!CONFIG.palettes[name] || (name === 'aerial' && !CONFIG.aerial)) name = Object.keys(CONFIG.palettes)[0];
    layerNow = name;
    document.body.className = 'layer-' + name;
    if (styleReady) applyLayer();
  };

  /** A circle of radius m metres around a point, as a GeoJSON polygon. */
  function circle(lon, lat, m) {
    const ring = [];
    const dLat = m / 111320, dLon = m / (111320 * Math.cos(lat * Math.PI / 180));
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * 2 * Math.PI;
      ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
    }
    return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
  }
  /** Room for the glass above and below the open map, in pixels. */
  function pad(state) {
    return state.padding || { top: 150, bottom: 380, left: 50, right: 50 };
  }

  const markers = new Map();
  let you;
  // Labels never pile up: one that would sit on a more important pin's dot or label is hidden
  // (hover shows it). Most important first: the chosen place (always shown), then the suggestions
  // in rank order, then the plan's stops. Checked after every move.
  let labelled = [];
  let declutterQueued = false;
  function overlaps(a, b) {
    return a.left < b.right + 2 && a.right > b.left - 2 && a.top < b.bottom + 2 && a.bottom > b.top - 2;
  }
  function declutter() {
    declutterQueued = false;
    const taken = [];
    for (const m of labelled) {
      const r = m.label.getBoundingClientRect();
      const crowded = !m.focus && r.width > 0 && taken.some(t => overlaps(r, t));
      m.label.classList.toggle('crowded', crowded);
      taken.push(m.dot.getBoundingClientRect());
      if (!crowded && r.width > 0) taken.push(r);
    }
  }
  function queueDeclutter() {
    if (declutterQueued) return;
    declutterQueued = true;
    requestAnimationFrame(declutter);
  }
  map.on('move', queueDeclutter);
  map.on('resize', queueDeclutter);
  function pinElement(p) {
    const el = document.createElement('div');
    el.className = 'pin ' + p.kind + (p.focus ? ' focus' : '');
    const dot = document.createElement('div');
    dot.className = 'dot';
    if (p.badge) dot.textContent = p.badge;
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = p.name;
    el.appendChild(dot);
    el.appendChild(label);
    el.addEventListener('click', ev => { ev.stopPropagation(); post({ type: 'select', id: p.id }); });
    return el;
  }

  window.buddyUpdate = function (state) {
    for (const m of markers.values()) m.remove();
    markers.clear();
    // Draw plain places first so recommendations and stops sit on top.
    const order = { place: 0, stop: 1, rec: 2 };
    state.pins.slice().sort((a, b) => order[a.kind] - order[b.kind] || (a.focus ? 1 : 0) - (b.focus ? 1 : 0)).forEach(p => {
      markers.set(p.id, new maplibregl.Marker({ element: pinElement(p), anchor: 'top', offset: [0, -8] }).setLngLat([p.lon, p.lat]).addTo(map));
    });
    // The pins whose labels show, most important first (see declutter).
    const rank = p => (p.focus ? 0 : p.kind === 'rec' ? 1 + (Number(p.badge) || 50) : p.kind === 'stop' ? 100 : -1);
    labelled = state.pins.filter(p => rank(p) >= 0).sort((a, b) => rank(a) - rank(b)).map(p => {
      const el = markers.get(p.id).getElement();
      return { focus: !!p.focus, dot: el.querySelector('.dot'), label: el.querySelector('.label') };
    });
    if (state.you) {
      if (!you) {
        const el = document.createElement('div');
        el.className = 'you';
        const halo = document.createElement('div');
        halo.className = 'halo';
        const core = document.createElement('div');
        core.className = 'core';
        el.appendChild(halo);
        el.appendChild(core);
        you = new maplibregl.Marker({ element: el });
      }
      you.setLngLat([state.you.lon, state.you.lat]).addTo(map);
    } else if (you) you.remove();
    routeNow = state.route || null;
    accNow = state.you && state.accuracy > 0 ? { lon: state.you.lon, lat: state.you.lat, meters: state.accuracy } : null;
    if (styleReady) applyData();
    queueDeclutter();
    if (state.recenter && state.you) {
      // Show where you are (and how sure macOS is) in the open area between the glass.
      const m = Math.max(state.accuracy || 0, 40);
      const dLat = m / 111320, dLon = m / (111320 * Math.cos(state.you.lat * Math.PI / 180));
      map.fitBounds([[state.you.lon - dLon, state.you.lat - dLat], [state.you.lon + dLon, state.you.lat + dLat]], { padding: pad(state), maxZoom: 16.5, speed: 1.4 });
    } else if (state.flyTo && CONFIG.theme === 'dusk' && state.route) {
      // Show you and the chosen place together, in the open area between the search bar and the bottom card.
      const lons = state.route.map(p => p[0]), lats = state.route.map(p => p[1]);
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: pad(state), maxZoom: 16.5, speed: 1.4 });
    } else if (state.flyTo) map.flyTo({ center: [state.flyTo.lon, state.flyTo.lat], zoom: Math.max(map.getZoom(), 15.5), speed: 1.4 });
  };
  // The web view can start at zero size while React Native lays out; MapLibre
  // then keeps its 400x300 fallback canvas (seen in a browser test). Resize
  // whenever the container changes.
  if (window.ResizeObserver) new ResizeObserver(() => map.resize()).observe(document.getElementById('map'));
  // Pins, "you" and flyTo all work before the first frame is drawn, so say
  // ready now rather than on 'load', which never fires while the view is
  // hidden or has no size.
  post({ type: 'ready' });
})();
</script>
</body></html>`;
}
