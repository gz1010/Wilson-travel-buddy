#!/usr/bin/env node
// Prepares a city pack while online, so the app can then run with Wi-Fi off. One command for
// every download step, in order; a failed step is reported and the rest still run:
//
//   node scripts/prepare-pack.mjs                     # Seville
//   node scripts/prepare-pack.mjs --skip forecast     # keep the committed forecast (the demo's sample rain)
//   node scripts/prepare-pack.mjs --dest seville --skip tiles,photos
//
// Steps: fetch-facts (Wikipedia summaries), build-photos (Wikimedia Commons), fetch-forecast
// (Open-Meteo), build-tiles (OpenStreetMap via Protomaps). Then it writes
// app/src/pack/<dest>/prepared.json, which the Welcome screen reads ("guide prepared …").
// Map tiles are gitignored, so run this on every machine that runs the app.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = name => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const destId = opt('dest') ?? 'seville';
const skip = new Set((opt('skip') ?? '').split(',').filter(Boolean));
const packDir = join(root, 'app/src/pack', destId);

const STEPS = [
  { name: 'facts', script: 'fetch-facts.mjs', args: ['--dest', destId] },
  { name: 'photos', script: 'build-photos.mjs', args: ['--dest', destId] },
  { name: 'forecast', script: 'fetch-forecast.mjs', args: ['--dest', destId] },
  { name: 'tiles', script: 'build-tiles.mjs', args: ['--dest', destId] },
];

const results = [];
for (const step of STEPS) {
  if (skip.has(step.name)) {
    console.log(`\n== ${step.name}: skipped\n`);
    results.push([step.name, 'skipped']);
    continue;
  }
  console.log(`\n== ${step.name}: node scripts/${step.script} ${step.args.join(' ')}\n`);
  const started = Date.now();
  const run = spawnSync(process.execPath, [join(root, 'scripts', step.script), ...step.args], { stdio: 'inherit' });
  const secs = Math.round((Date.now() - started) / 1000);
  const ok = run.status === 0;
  results.push([step.name, ok ? `ok (${secs} s)` : `FAILED (exit ${run.status ?? run.error?.message})`]);
}

const read = file => JSON.parse(readFileSync(join(packDir, file), 'utf8'));
const places = read('places.json');
const facts = read('facts.json');
const dest = read('destination.json');
const forecast = read('forecast.json');
const tilesFile = join(root, 'app/src/map/generated/tiles.js');
const hours = forecast.hours ?? [];

const prepared = {
  preparedAt: new Date().toISOString(),
  places: places.length,
  facts: facts.length,
  wikiFacts: facts.filter(f => f.id.startsWith('wiki-')).length,
  photos: places.filter(p => p.photo).length,
  heroes: Object.keys(dest.heroes ?? {}).length,
  // Tiles are gitignored: this says whether the machine that ran this has them.
  tiles: existsSync(tilesFile) && statSync(tilesFile).size > 0,
  forecastFrom: hours[0]?.time ?? null,
  forecastTo: hours.at(-1)?.time ?? null,
  forecastIsSample: /^sample/i.test(forecast.source ?? ''),
};
writeFileSync(join(packDir, 'prepared.json'), JSON.stringify(prepared, null, 1) + '\n');

console.log('\n== Summary');
for (const [name, status] of results) console.log(`  ${name.padEnd(9)} ${status}`);
console.log(
  `\n  ${prepared.places} places · ${prepared.facts} facts (${prepared.wikiFacts} from Wikipedia) · ` +
    `${prepared.photos} photos · ${prepared.heroes} city photos · tiles ${prepared.tiles ? 'yes' : 'no'}`,
);
console.log(`  forecast ${prepared.forecastFrom} → ${prepared.forecastTo}${prepared.forecastIsSample ? ' (sample data)' : ''}`);
console.log(`\nWrote app/src/pack/${destId}/prepared.json`);
if (results.some(([, s]) => s.startsWith('FAILED'))) process.exitCode = 1;
