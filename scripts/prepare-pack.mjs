#!/usr/bin/env node
// Prepares a city pack in one go while you have Wi-Fi, so the app can then run with it off:
// Wikipedia facts, Commons photos, the Open-Meteo forecast, the OpenStreetMap tiles and IGN's
// aerial photos.
//
//   node scripts/prepare-pack.mjs                     # Seville
//   node scripts/prepare-pack.mjs --dest seville
//   node scripts/prepare-pack.mjs --skip tiles        # any of: facts, photos, forecast, tiles, aerial
//   node scripts/prepare-pack.mjs --cache /tmp/wm     # reuse Wikimedia answers (and aerial tiles, in aerial/) saved there by an earlier run
//
// It runs fetch-facts.mjs, build-photos.mjs, fetch-forecast.mjs, build-tiles.mjs and
// build-aerial.mjs in that order (photos use the articles the facts step matched), reports each
// step, carries on past a step that fails, and then writes app/src/pack/<dest>/prepared.json,
// counted from what is actually in the pack: { preparedAt, places, facts, wikiFacts, photos,
// heroes, tiles, aerial, forecastFrom, forecastTo, steps } (aerial: photo tiles for the map's
// Aerial layer). The Welcome screen shows it ("Seville guide prepared Nov 14 · …").
// preparedAt only moves when at least one step succeeded.
//
// Wikimedia allows 10 API requests a minute to clients without contact details, so the facts
// and photos steps pace themselves (about 20 minutes for Seville). Set WIKIMEDIA_CONTACT to an
// email or URL to go faster; see fetch-facts.mjs.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = name => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const destId = opt('dest') ?? 'seville';
const skip = new Set((opt('skip') ?? '').split(',').filter(Boolean));
const cache = opt('cache'); // passed to the two Wikimedia steps, and as <cache>/aerial to the aerial step
const packDir = join(root, 'app/src/pack', destId);
const tilesPath = join(root, 'app/src/map/generated/tiles.js');
const aerialPath = join(root, 'app/src/map/generated/aerial.js');
if (!existsSync(join(packDir, 'places.json'))) {
  console.error(`No pack at app/src/pack/${destId}: it needs at least places.json and destination.json.`);
  process.exit(1);
}

const wikimedia = cache ? ['--cache', cache] : [];
const STEPS = [
  { name: 'facts', script: 'fetch-facts.mjs', what: 'Wikipedia facts', args: wikimedia },
  { name: 'photos', script: 'build-photos.mjs', what: 'Commons photos', args: wikimedia },
  { name: 'forecast', script: 'fetch-forecast.mjs', what: 'Open-Meteo forecast' },
  { name: 'tiles', script: 'build-tiles.mjs', what: 'OpenStreetMap tiles' },
  { name: 'aerial', script: 'build-aerial.mjs', what: 'IGN aerial photos', args: cache ? ['--cache', join(cache, 'aerial')] : [] },
];

function run(script, args = []) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(root, 'scripts', script), '--dest', destId, ...args], { cwd: root, stdio: 'inherit', env: process.env });
    child.on('error', e => resolve({ code: 1, error: e.message }));
    child.on('exit', code => resolve({ code: code ?? 1 }));
  });
}

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
};

/** Local time with its offset, e.g. "2026-11-14T23:05:12-05:00": the preparer's own day. */
function localStamp(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19);
  const abs = Math.abs(off);
  return `${local}${off >= 0 ? '+' : '-'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

const results = [];
const started = Date.now();
for (const [i, step] of STEPS.entries()) {
  if (skip.has(step.name)) {
    console.log(`\n── ${i + 1}/${STEPS.length} ${step.what}: skipped`);
    results.push({ name: step.name, ok: false, skipped: true, seconds: 0 });
    continue;
  }
  console.log(`\n── ${i + 1}/${STEPS.length} ${step.what} (scripts/${step.script})`);
  const t0 = Date.now();
  const r = await run(step.script, step.args);
  const seconds = Math.round((Date.now() - t0) / 1000);
  results.push({ name: step.name, ok: r.code === 0, seconds });
  console.log(`── ${step.what}: ${r.code === 0 ? 'done' : `FAILED (exit ${r.code}${r.error ? `, ${r.error}` : ''}); carrying on`} in ${seconds} s`);
}

// Count what the pack now holds, whatever each step said.
const places = readJson(join(packDir, 'places.json'), []);
const facts = readJson(join(packDir, 'facts.json'), []);
const dest = readJson(join(packDir, 'destination.json'), {});
const forecast = readJson(join(packDir, 'forecast.json'), { hours: [] });
const photoExists = p => !!p?.file && existsSync(join(packDir, 'photos', p.file));
/** How many tiles a generated map module holds (0 when it was never built or can't be read). */
const countTiles = path => {
  if (!existsSync(path)) return 0;
  try {
    return Object.keys(createRequire(import.meta.url)(path).tiles ?? {}).length;
  } catch {
    return 0;
  }
};
const tiles = countTiles(tilesPath);
const aerial = countTiles(aerialPath);
const previous = readJson(join(packDir, 'prepared.json'), {});
const anyOk = results.some(r => r.ok);
const prepared = {
  preparedAt: anyOk ? localStamp() : previous.preparedAt ?? null,
  places: places.length,
  facts: facts.length,
  wikiFacts: facts.filter(f => String(f.id).startsWith('wiki-')).length,
  photos: places.filter(p => photoExists(p.photo)).length,
  heroes: Object.values(dest.heroes ?? {}).filter(photoExists).length,
  tiles,
  aerial,
  forecastFrom: forecast.hours[0]?.time ?? null,
  forecastTo: forecast.hours.at(-1)?.time ?? null,
  // A skipped step keeps the record of its last real run (with when it ran), so a partial run
  // (say --skip facts,photos,forecast,tiles for the aerial photos only) doesn't erase the others.
  steps: results.map(({ name, ok, skipped, seconds }) => {
    const before = (previous.steps ?? []).find(s => s.name === name && !s.skipped);
    if (skipped && before) return { ...before, at: before.at ?? previous.preparedAt ?? null };
    return { name, ok, ...(skipped ? { skipped } : {}), seconds, ...(ok ? { at: localStamp() } : {}) };
  }),
};
writeFileSync(join(packDir, 'prepared.json'), JSON.stringify(prepared, null, 1) + '\n');

const photoBytes = places
  .filter(p => photoExists(p.photo))
  .map(p => p.photo.file)
  .concat(Object.values(dest.heroes ?? {}).filter(photoExists).map(h => h.file))
  .reduce((n, f) => n + statSync(join(packDir, 'photos', f)).size, 0);
console.log(`\n${dest.name ?? destId} pack, ${Math.round((Date.now() - started) / 60000)} min:`);
for (const r of results) console.log(`  ${r.ok ? 'ok    ' : r.skipped ? 'skip  ' : 'FAILED'} ${r.name} (${r.seconds} s)`);
console.log(
  `  ${prepared.places} places · ${prepared.facts} facts (${prepared.wikiFacts} from Wikipedia) · ${prepared.photos} place photos + ${prepared.heroes} heroes ` +
    `(${(photoBytes / 1e6).toFixed(1)} MB) · ${prepared.tiles} map tiles · ${prepared.aerial} aerial tiles · forecast ${prepared.forecastFrom ?? '-'} to ${prepared.forecastTo ?? '-'}`,
);
console.log(`Wrote app/src/pack/${destId}/prepared.json${anyOk ? '' : ' (no step succeeded, so preparedAt is unchanged)'}.`);
if (results.some(r => !r.ok && !r.skipped)) {
  console.log('Some steps failed: run them again on their own (node scripts/<step>.mjs), then this once more to update prepared.json.');
  process.exitCode = 1;
}
if (results.some(r => (r.name === 'tiles' || r.name === 'aerial') && r.ok)) console.log('New tiles: restart Metro with --reset-cache so the app bundles them.');
