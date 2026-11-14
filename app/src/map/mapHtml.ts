// Builds the self-contained HTML page for the map web view: MapLibre GL JS
// and the vector tiles are inlined, so nothing is fetched from anywhere.
// Pins are HTML elements rather than map symbols, so no font files are needed.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const maplibre: { js: string; css: string } = require('buddy-maplibre');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tileSet: { minzoom: number; maxzoom: number; tiles: Record<string, string> | null } = require('buddy-tiles');

export const hasTiles = !!tileSet.tiles;

const escapeScript = (s: string) => s.replace(/<\/script/gi, '<\\/script');

export function buildMapHtml(bounds: [number, number, number, number]): string {
  const config = { bounds, minzoom: tileSet.minzoom, maxzoom: tileSet.maxzoom, hasTiles };
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
  const layers = [{ id: 'bg', type: 'background', paint: { 'background-color': '#efe9df' } }];
  if (TILES) {
    layers.push(
      { id: 'earth', type: 'fill', source: src, 'source-layer': 'earth', paint: { 'fill-color': '#f3efe7' } },
      { id: 'parks', type: 'fill', source: src, 'source-layer': 'landuse', filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['in', ['get', 'kind'], ['literal', ['park', 'garden', 'grass', 'forest', 'wood', 'cemetery', 'pitch', 'playground']]]], paint: { 'fill-color': '#d3e6c4' } },
      { id: 'water', type: 'fill', source: src, 'source-layer': 'water', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#a8cbe0' } },
      { id: 'waterways', type: 'line', source: src, 'source-layer': 'water', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#a8cbe0', 'line-width': 2 } },
      { id: 'buildings', type: 'fill', source: src, 'source-layer': 'buildings', minzoom: 14, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#e2dbcf', 'fill-outline-color': '#d4ccbe' } },
      { id: 'roads-casing', type: 'line', source: src, 'source-layer': 'roads', paint: { 'line-color': '#d8d0c2', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 16, 9] } },
      { id: 'roads', type: 'line', source: src, 'source-layer': 'roads', paint: { 'line-color': ['match', ['get', 'kind'], 'highway', '#f6d38a', 'major_road', '#fbe7b5', '#ffffff'], 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 16, 7] } }
    );
  }
  const style = { version: 8, sources: {}, layers };
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
    if (state.flyTo) map.flyTo({ center: [state.flyTo.lon, state.flyTo.lat], zoom: Math.max(map.getZoom(), 15.5), speed: 1.4 });
  };
  map.on('load', () => post({ type: 'ready' }));
})();
</script>
</body></html>`;
}
