#!/usr/bin/env node
// Prepares a city pack in one go while you have Wi-Fi, so the app can then run with it off:
// Wikipedia facts (and more from the articles' sections), Commons photos, the Open-Meteo
// forecast, the OpenStreetMap tiles, the nearby places made from them, and IGN's aerial photos.
//
//   node scripts/prepare-pack.mjs                     # Seville
//   node scripts/prepare-pack.mjs --dest seville
//   node scripts/prepare-pack.mjs --skip tiles        # any of: facts, more-facts, photos, forecast, tiles, nearby, aerial
//   node scripts/prepare-pack.mjs --cache /tmp/wm     # reuse Wikimedia answers (and OSM answers in osm/, aerial tiles in aerial/) saved there by an earlier run
//   node scripts/prepare-pack.mjs --itinerary trip.ics   # add the places a trip names that the pack lacks (.ics or text)
//
// It runs fetch-facts.mjs, deepen-facts.mjs, build-photos.mjs, fetch-forecast.mjs, build-tiles.mjs,
// build-nearby.mjs and build-aerial.mjs in that order (more facts and photos use the articles the
// facts step matched; the nearby index is made from the tiles), reports each
// step, carries on past a step that fails, and then writes app/src/pack/<dest>/prepared.json,
// counted from what is actually in the pack: { preparedAt, places, facts, wikiFacts, photos,
// heroes, tiles, aerial, forecastFrom, forecastTo, steps } (aerial: photo tiles for the map's
// Aerial layer). The home's city card shows it ("60 places · ready offline", "Prepared Nov 15 · …").
// preparedAt only moves when at least one step succeeded.
//
// --itinerary reads an iCalendar file or a plain-text itinerary (scripts/itinerary.mjs; dry run:
// node scripts/itinerary.mjs trip.ics), looks the places the pack does not have up in
// OpenStreetMap (scripts/fetch-places.mjs --match), adds them to places.json with category, tags,
// indoor, visit length and hours from OSM's tags and needsReview: true, then runs the facts and
// photos steps for those places only (--only) and makes each one's summary the first sentence or
// two of its Wikipedia fact. A name that is a pack place under another name only becomes an alias
// of it. The more-facts, forecast, tiles, nearby and aerial steps do not run (new places lie
// inside the map already).
// prepared.json gets { itinerary: { file, at, added, notFound, aliased, steps } }; its other
// steps and preparedAt stay as the last full run left them.
//
// Wikimedia allows 10 API requests a minute to clients without contact details, so the facts,
// more-facts and photos steps pace themselves (about 26 minutes for Seville's 60 places). Set
// WIKIMEDIA_CONTACT to an email or URL to go faster; see fetch-facts.mjs and the README's
// "Prepare before you travel". Outside Spain the aerial step fails (IGN covers Spain only) and the
// run reports it; the other steps still run.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { itineraryPlaces, mergeFound, readItinerary, summaryFromFact, words } from './itinerary.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = name => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const destId = opt('dest') ?? 'seville';
const skip = new Set((opt('skip') ?? '').split(',').filter(Boolean));
const cache = opt('cache'); // passed to the two Wikimedia steps, and as <cache>/aerial to the aerial step
const itineraryFile = opt('itinerary');
if (argv.includes('--itinerary') && !itineraryFile) {
  console.error('--itinerary needs a file: node scripts/prepare-pack.mjs --itinerary trip.ics');
  process.exit(1);
}
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
  { name: 'more-facts', script: 'deepen-facts.mjs', what: 'more Wikipedia facts per place', args: wikimedia },
  { name: 'photos', script: 'build-photos.mjs', what: 'Commons photos', args: wikimedia },
  { name: 'forecast', script: 'fetch-forecast.mjs', what: 'Open-Meteo forecast' },
  { name: 'tiles', script: 'build-tiles.mjs', what: 'OpenStreetMap tiles' },
  // Made from the tiles: every cinema, pharmacy, cash machine… on the map, for "find X near me".
  { name: 'nearby', script: 'build-nearby.mjs', what: 'nearby places (OpenStreetMap)', args: cache ? ['--cache', join(cache, 'osm')] : [] },
  { name: 'aerial', script: 'build-aerial.mjs', what: 'IGN aerial photos', args: cache ? ['--cache', join(cache, 'aerial')] : [] },
];

/** Runs a step's script for this destination; with capture, also returns what it printed on stdout. */
function run(script, args = [], { capture = false } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(root, 'scripts', script), '--dest', destId, ...args], {
      cwd: root,
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      env: process.env,
    });
    let stdout = '';
    child.stdout?.on('data', d => (stdout += d));
    child.on('error', e => resolve({ code: 1, error: e.message, stdout }));
    child.on('exit', code => resolve({ code: code ?? 1, stdout }));
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
const placesPath = join(packDir, 'places.json');
const writePlaces = list => writeFileSync(placesPath, JSON.stringify(list, null, 1)); // as build-photos.mjs writes it

/** Runs one step (its own args, then `extra`) and records it in results. */
async function runStep(step, counter, extra = []) {
  console.log(`\n── ${counter} ${step.what} (scripts/${step.script})`);
  const t0 = Date.now();
  const r = await run(step.script, [...(step.args ?? []), ...extra]);
  const seconds = Math.round((Date.now() - t0) / 1000);
  results.push({ name: step.name, ok: r.code === 0, seconds });
  console.log(`── ${step.what}: ${r.code === 0 ? 'done' : `FAILED (exit ${r.code}${r.error ? `, ${r.error}` : ''}); carrying on`} in ${seconds} s`);
  return r.code === 0;
}

/** A new place's summary becomes the start of its Wikipedia fact, once the facts step found one. */
function summariesFromFacts(ids) {
  const list = readJson(placesPath, []);
  const factById = new Map(readJson(join(packDir, 'facts.json'), []).map(f => [f.id, f]));
  let n = 0;
  for (const p of list) {
    const body = ids.includes(p.id) && p.needsReview ? factById.get(`wiki-${p.id}`)?.body : undefined;
    const summary = body ? summaryFromFact(body) : undefined;
    if (summary && summary !== p.summary) {
      p.summary = summary;
      n++;
    }
  }
  if (n) writePlaces(list);
  console.log(`── Summaries: ${n} of ${ids.length} places now start from their Wikipedia fact; the rest keep OpenStreetMap's line.`);
}

/**
 * --itinerary: the places the file names that the pack lacks, looked up in OpenStreetMap and added
 * to places.json, then the facts and photos steps for them only (and for places an earlier
 * itinerary added that still have no fact or photo).
 */
async function addItinerary(file) {
  let text;
  try {
    text = readItinerary(resolvePath(file));
  } catch (e) {
    console.error(`Cannot read the itinerary ${file}: ${e.message}`);
    process.exit(1);
  }
  const packPlaces = readJson(placesPath, []);
  const destination = readJson(join(packDir, 'destination.json'), {});
  const cityNames = [destination.name].filter(Boolean);
  const plan = itineraryPlaces(text, packPlaces, { cityNames });
  const known = [...new Set(plan.entries.filter(e => e.known).map(e => e.known))];
  const travel = plan.entries.filter(e => e.skipped === 'travel').length;
  console.log(`\n── 1/3 Itinerary places (scripts/itinerary.mjs, then scripts/fetch-places.mjs --match)`);
  console.log(
    `${basename(file)}: ${plan.kind === 'ics' ? 'iCalendar' : 'text'}, ${plan.entries.length} ${plan.kind === 'ics' ? 'event' : 'phrase'}${plan.entries.length === 1 ? '' : 's'}` +
      `${travel ? ` (${travel} travel)` : ''}; in the pack already: ${known.join(', ') || 'none'}; to look up: ${plan.lookups.join('; ') || 'nothing'}` +
      `${plan.dropped ? ` (${plan.dropped} more names left out: split the file)` : ''}.`,
  );
  const t0 = Date.now();
  let ok = true;
  let answers = [];
  if (plan.lookups.length) {
    const r = await run('fetch-places.mjs', ['--match', ...plan.lookups], { capture: true });
    try {
      if (r.code !== 0) throw new Error(`exit ${r.code}${r.error ? `, ${r.error}` : ''}`);
      answers = JSON.parse(r.stdout);
    } catch (e) {
      ok = false;
      console.log(`── Itinerary places: FAILED (${e.message}); places.json left as it was`);
    }
  }
  const found = new Map(answers.map(a => [words(a.name).join(' '), a.place]));
  const merged = mergeFound(packPlaces, plan.entries, found, { cityNames });
  if (merged.added.length || merged.aliased.length) writePlaces(packPlaces);
  // A name nothing could be asked about (Overpass down and Nominatim too, or past the run's limit
  // of names) is not "not found".
  const asked = new Set(plan.lookups.map(n => words(n).join(' ')));
  const unsure = new Set(answers.filter(a => a.unsure).map(a => words(a.name).join(' ')));
  for (const e of plan.entries) for (const c of e.candidates) if (!asked.has(words(c).join(' '))) unsure.add(words(c).join(' '));
  const notFound = merged.notFound.filter(n => !unsure.has(words(n).join(' ')));
  const notLookedUp = merged.notFound.filter(n => unsure.has(words(n).join(' ')));
  if (notLookedUp.length) ok = false;
  const seconds = Math.round((Date.now() - t0) / 1000);
  results.push({ name: 'lookup', ok, seconds });
  if (ok || merged.added.length) {
    console.log(
      `── Itinerary places: added ${merged.added.length}${merged.added.length ? ` (${merged.added.join(', ')})` : ''}` +
        `${merged.aliased.length ? `; new aliases: ${merged.aliased.map(a => `"${a.name}" for ${a.placeId}`).join(', ')}` : ''}` +
        `${notFound.length ? `; not found in ${destination.name ?? destId}: ${notFound.join('; ')}` : ''}` +
        `${notLookedUp.length ? `; not looked up (OpenStreetMap did not answer): ${notLookedUp.join('; ')}` : ''} in ${seconds} s`,
    );
  }

  const facts = readJson(join(packDir, 'facts.json'), []);
  const hasFact = new Set(facts.filter(f => String(f.id).startsWith('wiki-')).map(f => f.placeId));
  const retry = known.filter(id => {
    const p = packPlaces.find(x => x.id === id);
    return p?.needsReview && (!hasFact.has(id) || !(p.photo?.file && existsSync(join(packDir, 'photos', p.photo.file))));
  });
  const todo = [...merged.added, ...retry];
  if (retry.length) console.log(`── Added by an earlier itinerary and still without a Wikipedia fact or photo: ${retry.join(', ')}; trying them again.`);
  for (const [i, step] of STEPS.filter(s => s.name === 'facts' || s.name === 'photos').entries()) {
    if (!todo.length || skip.has(step.name)) {
      console.log(`\n── ${i + 2}/3 ${step.what}: skipped${todo.length ? '' : ' (no new places)'}`);
      results.push({ name: step.name, ok: false, skipped: true, seconds: 0 });
      continue;
    }
    await runStep(step, `${i + 2}/3`, ['--only', todo.join(',')]);
    if (step.name === 'facts') summariesFromFacts(todo);
  }
  // Only the names past the limit went unasked (OpenStreetMap answered the rest): rerunning won't help.
  const tooMany = plan.dropped > 0 && answers.length > 0 && !answers.some(a => a.unsure);
  return { file: basename(file), ok, tooMany, added: merged.added, aliased: merged.aliased, notFound, notLookedUp, known, retried: retry };
}

let itinerary;
if (itineraryFile) {
  itinerary = await addItinerary(itineraryFile);
  // (Facts or photos retried for an earlier run's places may have changed the pack even so.)
  if (!itinerary.ok && !itinerary.added.length && !itinerary.aliased.length && !results.some(r => r.name !== 'lookup' && r.ok)) {
    console.log(`\nNothing changed: ${itinerary.tooMany ? 'split the itinerary into smaller files (at most 40 new names each) and run each one' : 'run this again while online'}.`);
    process.exit(1);
  }
} else {
  for (const [i, step] of STEPS.entries()) {
    if (skip.has(step.name)) {
      console.log(`\n── ${i + 1}/${STEPS.length} ${step.what}: skipped`);
      results.push({ name: step.name, ok: false, skipped: true, seconds: 0 });
      continue;
    }
    await runStep(step, `${i + 1}/${STEPS.length}`);
  }
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
  // An itinerary run adds places but is not a full preparation: the date and steps stay as they were.
  preparedAt: !itinerary && anyOk ? localStamp() : previous.preparedAt ?? null,
  places: places.length,
  facts: facts.length,
  wikiFacts: facts.filter(f => /^wiki(more)?-/.test(String(f.id))).length,
  photos: places.filter(p => photoExists(p.photo)).length,
  heroes: Object.values(dest.heroes ?? {}).filter(photoExists).length,
  tiles,
  aerial,
  forecastFrom: forecast.hours[0]?.time ?? null,
  forecastTo: forecast.hours.at(-1)?.time ?? null,
  // A skipped step keeps the record of its last real run (with when it ran), so a partial run
  // (say --skip facts,photos,forecast,tiles for the aerial photos only) doesn't erase the others.
  steps: itinerary
    ? previous.steps ?? []
    : results.map(({ name, ok, skipped, seconds }) => {
        const before = (previous.steps ?? []).find(s => s.name === name && !s.skipped);
        if (skipped && before) return { ...before, at: before.at ?? previous.preparedAt ?? null };
        return { name, ok, ...(skipped ? { skipped } : {}), seconds, ...(ok ? { at: localStamp() } : {}) };
      }),
  // The last --itinerary run: the file's name (not its path), the places it added (with those an
  // earlier run of the same file added, while they are still in the pack) and the names
  // OpenStreetMap had nothing for. A full run keeps it.
  ...(itinerary
    ? {
        itinerary: {
          file: itinerary.file,
          at: localStamp(),
          added: [...new Set([...(previous.itinerary?.file === itinerary.file ? previous.itinerary.added ?? [] : []), ...itinerary.added])].filter(id =>
            places.some(p => p.id === id),
          ),
          notFound: itinerary.notFound,
          ...(itinerary.aliased.length ? { aliased: Object.fromEntries(itinerary.aliased.map(a => [a.name, a.placeId])) } : {}),
          ...(itinerary.notLookedUp.length ? { notLookedUp: itinerary.notLookedUp } : {}),
          steps: results.map(({ name, ok, skipped, seconds }) => ({ name, ok, ...(skipped ? { skipped } : {}), seconds })),
        },
      }
    : previous.itinerary
      ? { itinerary: previous.itinerary }
      : {}),
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
if (itinerary) {
  console.log(
    `Itinerary ${itinerary.file}: ${itinerary.added.length} places added${itinerary.added.length ? ` with needsReview: true (${itinerary.added.join(', ')})` : ''}, ` +
      `${itinerary.known.length} already in the pack${itinerary.notFound.length ? `, not found: ${itinerary.notFound.join('; ')}` : ''}.`,
  );
  if (itinerary.added.length)
    console.log(`Check their category, tags, visit length, hours and summary in app/src/pack/${destId}/places.json, then drop needsReview. Reload the app (Metro serves the new places.json) to use them.`);
}
if (results.some(r => !r.ok && !r.skipped)) {
  console.log(
    itinerary
      ? `Some steps failed: run this again with --itinerary ${itinerary.file} (it retries the facts and photos of places it added).`
      : 'Some steps failed: run them again on their own (node scripts/<step>.mjs), then this once more to update prepared.json.',
  );
  process.exitCode = 1;
}
if (results.some(r => (r.name === 'tiles' || r.name === 'aerial') && r.ok)) console.log('New tiles: restart Metro with --reset-cache so the app bundles them.');
