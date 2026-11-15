// Builds the self-contained HTML page for the map web view: MapLibre GL JS
// and the vector tiles are inlined, so nothing is fetched from anywhere.
// Pins are HTML elements rather than map symbols, so no font files are needed.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const maplibre: { js: string; css: string } = require('buddy-maplibre');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tileSet: { minzoom: number; maxzoom: number; tiles: Record<string, string> | null } = require('buddy-tiles');

export const hasTiles = !!tileSet.tiles;

const escapeScript = (s: string) => s.replace(/<\/script/gi, '<\\/script');

export type MapTheme = 'classic' | 'dusk';

/** Map colours per theme. Dusk: low-contrast dark streets so glass pins glow. */
const PALETTES = {
  classic: { bg: '#efe9df', earth: '#f3efe7', parks: '#d3e6c4', water: '#a8cbe0', buildings: '#e2dbcf', buildingLine: '#d4ccbe', casing: '#d8d0c2', highway: '#f6d38a', major: '#fbe7b5', street: '#ffffff', route: '#ffffff' },
  dusk: { bg: '#12141B', earth: '#12141B', parks: '#17221D', water: '#1A2632', buildings: '#1B1E27', buildingLine: '#1B1E27', casing: '#12141B', highway: '#3A3F4D', major: '#343947', street: '#2B2F3B', route: '#ffffff' },
};

// Dusk pins: plan = white ring, suggestion = clear glass, chosen = glass orb, you = blue dot.
const DUSK_CSS = `
html, body, #map { background: #12141B; font-family: Manrope, -apple-system, system-ui, sans-serif; }
.dot { width: 8px; height: 8px; background: rgba(255,255,255,.32); border: 0; box-shadow: none; }
.pin.stop .dot { width: 16px; height: 16px; background: transparent; border: 2.5px solid rgba(255,255,255,.85); box-sizing: border-box; font-size: 0; }
.pin.rec .dot { width: 30px; height: 30px; color: #fff; font-weight: 800; font-size: 12px; text-shadow: 0 1px 2px rgba(0,0,0,.4);
  background: linear-gradient(135deg, rgba(255,255,255,.22), rgba(255,255,255,.06)); -webkit-backdrop-filter: blur(6px) saturate(180%); backdrop-filter: blur(6px) saturate(180%);
  border: 1px solid rgba(255,255,255,.32); box-shadow: inset 0 1px 1px rgba(255,255,255,.7), 0 4px 12px rgba(0,0,0,.3); }
.pin.focus .dot { transform: none; width: 44px; height: 44px; font-size: 15px; color: #fff;
  background: radial-gradient(circle at 32% 24%, rgba(255,255,255,.85) 0%, rgba(255,255,255,.3) 24%, rgba(255,255,255,.1) 58%, rgba(255,255,255,.22) 100%);
  border: 1px solid rgba(255,255,255,.6); box-shadow: inset 0 1px 1px #fff, inset 1px 0 0 rgba(255,140,140,.3), inset -1px 0 0 rgba(140,190,255,.32), 0 0 30px 6px rgba(255,255,255,.14), 0 8px 20px rgba(0,0,0,.4); }
.label { background: linear-gradient(135deg, rgba(255,255,255,.16), rgba(255,255,255,.04)); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,.22); color: #F4EFE8; font-weight: 700; box-shadow: inset 0 1px 1px rgba(255,255,255,.4); border-radius: 999px; padding: 3px 8px; }
.you { width: 18px; height: 18px; background: #8FB8FF; border: 3px solid #12141B; box-sizing: border-box; box-shadow: 0 0 0 10px rgba(143,184,255,.18); }
.maplibregl-ctrl-group { background: rgba(255,255,255,.08); }
.notiles { background: rgba(255,255,255,.08); color: #B9B0A6; }
`;

export function buildMapHtml(bounds: [number, number, number, number], theme: MapTheme = 'classic'): string {
  const config = { bounds, minzoom: tileSet.minzoom, maxzoom: tileSet.maxzoom, hasTiles, palette: PALETTES[theme], theme };
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
.you { width: 16px; height: 16px; border-radius: 50%; background: #1d7cf2; border: 3px solid #fff; box-shadow: 0 0 0 8px rgba(29,124,242,.2); }
.notiles { position: absolute; left: 8px; bottom: 8px; font-size: 11px; color: #776; background: rgba(255,255,255,.8); padding: 3px 6px; border-radius: 4px; }
${theme === 'dusk' ? DUSK_CSS : ''}
</style>
</head><body>
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

  // Layer names follow the Protomaps basemap schema (earth, landuse, water, roads, buildings).
  const src = 'osm';
  const P = CONFIG.palette;
  const layers = [{ id: 'bg', type: 'background', paint: { 'background-color': P.bg } }];
  if (TILES) {
    layers.push(
      { id: 'earth', type: 'fill', source: src, 'source-layer': 'earth', paint: { 'fill-color': P.earth } },
      { id: 'parks', type: 'fill', source: src, 'source-layer': 'landuse', filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['in', ['get', 'kind'], ['literal', ['park', 'garden', 'grass', 'forest', 'wood', 'cemetery', 'pitch', 'playground']]]], paint: { 'fill-color': P.parks } },
      { id: 'water', type: 'fill', source: src, 'source-layer': 'water', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': P.water } },
      { id: 'waterways', type: 'line', source: src, 'source-layer': 'water', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': P.water, 'line-width': 2 } },
      { id: 'buildings', type: 'fill', source: src, 'source-layer': 'buildings', minzoom: 14, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': P.buildings, 'fill-outline-color': P.buildingLine } },
      { id: 'roads-casing', type: 'line', source: src, 'source-layer': 'roads', paint: { 'line-color': P.casing, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 16, 9] } },
      { id: 'roads', type: 'line', source: src, 'source-layer': 'roads', paint: { 'line-color': ['match', ['get', 'kind'], 'highway', P.highway, 'major_road', P.major, P.street], 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 16, 7] } }
    );
  }
  // A straight dashed line from you to the chosen place: direction, not turn-by-turn routing.
  layers.push({ id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round' }, paint: { 'line-color': P.route, 'line-opacity': 0.9, 'line-width': 3, 'line-dasharray': [0.7, 2.4] } });
  const style = { version: 8, sources: { route: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } }, layers };
  if (TILES) style.sources[src] = { type: 'vector', tiles: ['buddy://{z}/{x}/{y}'], minzoom: CONFIG.minzoom, maxzoom: CONFIG.maxzoom, attribution: '© OpenStreetMap contributors' };

  const b = CONFIG.bounds;
  const map = new maplibregl.Map({ container: 'map', style, bounds: [[b[0], b[1]], [b[2], b[3]]], maxBounds: [[b[0] - 0.005, b[1] - 0.005], [b[2] + 0.005, b[3] + 0.005]], attributionControl: { compact: true } });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  if (!CONFIG.hasTiles) {
    const note = document.createElement('div');
    note.className = 'notiles';
    note.textContent = 'No map tiles bundled: run scripts/build-tiles.mjs';
    document.body.appendChild(note);
  }

  map.on('click', e => post({ type: 'press', lat: e.lngLat.lat, lon: e.lngLat.lng }));

  const markers = new Map();
  let you;
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
    if (state.you) {
      if (!you) { const el = document.createElement('div'); el.className = 'you'; you = new maplibregl.Marker({ element: el }); }
      you.setLngLat([state.you.lon, state.you.lat]).addTo(map);
    }
    const route = map.getSource('route');
    if (route) {
      route.setData(state.route
        ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: state.route } }
        : { type: 'FeatureCollection', features: [] });
    }
    if (state.flyTo) map.flyTo({ center: [state.flyTo.lon, state.flyTo.lat], zoom: Math.max(map.getZoom(), 15.5), speed: 1.4 });
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
