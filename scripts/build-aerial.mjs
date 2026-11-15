#!/usr/bin/env node
// Bakes aerial photos (orthophotos) of the destination into the app, so the map's Aerial layer
// works with Wi-Fi off. Run once while online:
//
//   node scripts/build-aerial.mjs                         # Seville, zooms 12-17
//   node scripts/build-aerial.mjs --maxzoom 16 --margin 0.004
//   node scripts/build-aerial.mjs --cache /tmp/aerial     # keep the tiles there and reuse them next time
//
// Source: Spain's Instituto Geográfico Nacional (IGN), the PNOA "máxima actualidad" orthophotos
// (25-50 cm), from its WMTS https://www.ign.es/wmts/pnoa-ma (layer OI.OrthoimageCoverage, tile
// matrix set GoogleMapsCompatible: the same z/x/y grid as the vector tiles). Below about 1:70,000
// (z12-13 here) the same service serves Sentinel-2 imagery instead.
//
// Licence, checked online on 2026-11-15:
// - IGN's licence (https://www.ign.es/resources/licencia/Condiciones_licenciaUso_IGN.pdf, after
//   Orden FOM/2807/2015): using IGN products and services is free and means accepting CC BY 4.0,
//   which allows copying and redistributing in any medium, so keeping a small area for offline use
//   is allowed. The credit must show legibly with the data, at the foot of the map; for a service
//   used unmodified it is the service's own <AccessConstraints>.
// - The WMTS capabilities: AccessConstraints "CC BY 4.0 scne.es", Fees "No se aplican
//   condiciones". The IDEE metadata record (spaignwmts_pnoa-ma): "Sin limitaciones al acceso
//   público", licence CC BY 4.0. Nothing there limits fetching a few hundred tiles.
// The app shows ATTRIBUTION below on the map whenever the Aerial layer is on. Tiles are stored
// exactly as served (no re-encoding, so no derived work).
//
// Area: the bounding box of the pack's places plus a margin, joined with the area the map lets you
// pan to (the destination's bounds plus 0.005°, see mapHtml.ts), so the photos reach every edge.
// Requests go one at a time with a short pause and a generic User-Agent. Each zoom level is kept
// only if the total stays under --max-mb (25 by default); the first level that would pass it, and
// any above, are dropped. Seville at z12-17 is about 600 tiles, 12 MB, 3 minutes.
//
// Writes app/src/map/generated/aerial.js (gitignored), which Metro serves as `buddy-aerial`
// (see app/metro.config.js); without it the Aerial layer is simply not offered.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const destId = opt('dest', 'seville');
const minzoom = Number(opt('minzoom', 12));
const maxzoom = Number(opt('maxzoom', 17));
const margin = Number(opt('margin', 0.005));
const delayMs = Number(opt('delay', 120));
const maxMb = Number(opt('max-mb', 25));
const cacheDir = opt('cache');

const SOURCE = {
  id: 'ign-pnoa-ma',
  name: 'IGN PNOA máxima actualidad',
  tile: (z, x, y) =>
    'https://www.ign.es/wmts/pnoa-ma?service=WMTS&request=GetTile&version=1.0.0&layer=OI.OrthoimageCoverage' +
    `&style=default&format=image/jpeg&tilematrixset=GoogleMapsCompatible&tilematrix=${z}&tilerow=${y}&tilecol=${x}`,
  covers: country => /^(spain|españa|es)$/i.test(country ?? ''),
};
const ATTRIBUTION = 'PNOA máxima actualidad CC BY 4.0 scne.es';
// No personal details: just what the tool is.
const USER_AGENT = 'travel-buddy-build-aerial/1.0 (offline map pack script)';

const packDir = join(app, 'src/pack', destId);
const dest = JSON.parse(readFileSync(join(packDir, 'destination.json'), 'utf8'));
const places = JSON.parse(readFileSync(join(packDir, 'places.json'), 'utf8'));
if (!SOURCE.covers(dest.country)) {
  console.error(`${SOURCE.name} covers Spain only; ${dest.name} is in ${dest.country}. Add a source for it to this script.`);
  process.exit(1);
}

// [west, south, east, north]: places plus margin, joined with the map's pannable area.
const lons = places.map(p => p.point.lon);
const lats = places.map(p => p.point.lat);
const [bw, bs, be, bn] = dest.bounds;
const PAN = 0.005; // mapHtml.ts: maxBounds = bounds ± 0.005
const area = [
  Math.min(Math.min(...lons) - margin, bw - PAN),
  Math.min(Math.min(...lats) - margin, bs - PAN),
  Math.max(Math.max(...lons) + margin, be + PAN),
  Math.max(Math.max(...lats) + margin, bn + PAN),
].map(v => Math.round(v * 1e5) / 1e5);
const [west, south, east, north] = area;

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};
const tilesAt = z => {
  const out = [];
  for (let x = lon2x(west, z); x <= lon2x(east, z); x++) for (let y = lat2y(north, z); y <= lat2y(south, z); y++) out.push([x, y]);
  return out;
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
let requests = 0;
async function fetchTile(z, x, y) {
  const cached = cacheDir && join(cacheDir, `${z}-${x}-${y}.jpg`);
  if (cached && existsSync(cached)) return readFileSync(cached);
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (requests++ > 0) await sleep(attempt ? 1000 * 3 ** attempt : delayMs);
    try {
      const res = await fetch(SOURCE.tile(z, x, y), { headers: { 'User-Agent': USER_AGENT } });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!type.startsWith('image/jpeg')) throw new Error(`got ${type || 'no content type'}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error(`not a JPEG (${buf.length} bytes)`);
      if (cached) writeFileSync(cached, buf);
      return buf;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

if (cacheDir) mkdirSync(cacheDir, { recursive: true });
console.log(`${SOURCE.name} for ${dest.name}: area [${area.join(', ')}], zooms ${minzoom}-${maxzoom}`);
const tiles = {};
let bytes = 0;
let failed = 0;
let topZoom = minzoom - 1;
const started = Date.now();
for (let z = minzoom; z <= maxzoom; z++) {
  const level = {};
  let levelBytes = 0;
  let levelFailed = 0;
  for (const [x, y] of tilesAt(z)) {
    try {
      const buf = await fetchTile(z, x, y);
      level[`${z}/${x}/${y}`] = buf.toString('base64');
      levelBytes += buf.length;
    } catch (e) {
      levelFailed++;
      console.warn(`  z${z} ${x}/${y}: ${e.message}`);
    }
  }
  if ((bytes + levelBytes) / 1e6 > maxMb) {
    console.log(`z${z}: ${Object.keys(level).length} tiles would bring the total to ${((bytes + levelBytes) / 1e6).toFixed(1)} MB, over ${maxMb} MB: stopping at z${z - 1}.`);
    break;
  }
  Object.assign(tiles, level);
  bytes += levelBytes;
  failed += levelFailed;
  topZoom = z;
  console.log(`z${z}: ${Object.keys(level).length} tiles (${(levelBytes / 1e6).toFixed(1)} MB${levelFailed ? `, ${levelFailed} failed` : ''}); ${Object.keys(tiles).length} tiles, ${(bytes / 1e6).toFixed(1)} MB in all`);
}

const count = Object.keys(tiles).length;
if (!count) {
  console.error('No aerial tiles fetched; nothing written.');
  process.exit(1);
}
const out = join(app, 'src/map/generated/aerial.js');
mkdirSync(dirname(out), { recursive: true });
const data = {
  source: SOURCE.id,
  attribution: ATTRIBUTION,
  fetchedAt: new Date().toISOString().slice(0, 10),
  minzoom,
  maxzoom: topZoom,
  bounds: area,
  format: 'jpeg',
  tiles,
};
writeFileSync(out, `// Generated by scripts/build-aerial.mjs from ${SOURCE.name} (${ATTRIBUTION}). Do not edit or commit.\nmodule.exports = ${JSON.stringify(data)};\n`);
const seconds = Math.round((Date.now() - started) / 1000);
console.log(`Wrote ${count} aerial tiles, z${minzoom}-${topZoom}, ${(bytes / 1e6).toFixed(1)} MB of JPEG (${(Buffer.byteLength(JSON.stringify(tiles)) / 1e6).toFixed(1)} MB as base64) to app/src/map/generated/aerial.js in ${seconds} s.`);
console.log('Restart Metro with --reset-cache so the app bundles them.');
// Too many holes make a patchy map: fail so prepare-pack reports it, but keep what was fetched.
if (failed > count * 0.05) {
  console.error(`${failed} tiles failed: run it again (add --cache <dir> to keep what arrived).`);
  process.exitCode = 1;
}
