#!/usr/bin/env node
// Saves a real hourly forecast for the destination into the pack, from
// Open-Meteo (free, no key). Run once while online, shortly before the demo;
// the app shows the forecast's age, so it stays honest offline.
//
//   node scripts/fetch-forecast.mjs                    # writes app/src/pack/seville/forecast.json
//   node scripts/fetch-forecast.mjs --days 5 --out /tmp/forecast.json
//
// Weather data by Open-Meteo.com (CC BY 4.0).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const destId = opt('dest', 'seville');
const days = Number(opt('days', 7));
const out = opt('out', join(app, `src/pack/${destId}/forecast.json`));
const timezone = opt('timezone', 'Europe/Madrid');

const dest = JSON.parse(readFileSync(join(app, `src/pack/${destId}/destination.json`), 'utf8'));
const url = new URL('https://api.open-meteo.com/v1/forecast');
url.search = new URLSearchParams({
  latitude: String(dest.center.lat),
  longitude: String(dest.center.lon),
  hourly: 'temperature_2m,precipitation_probability,weather_code',
  timezone,
  forecast_days: String(days),
}).toString();

const res = await fetch(url, { headers: { 'User-Agent': 'travel-buddy-pack-builder' } });
if (!res.ok) {
  console.error(`Open-Meteo returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const data = await res.json();
const h = data.hourly;
const hours = h.time.map((time, i) => ({
  time, // already destination local time, "YYYY-MM-DDTHH:00"
  temperatureC: Math.round(h.temperature_2m[i] * 10) / 10,
  precipitationChance: h.precipitation_probability[i] ?? 0,
  code: h.weather_code[i] ?? undefined,
}));

// savedAt in destination time with its offset, e.g. "2026-11-14T21:05:00+01:00".
const offsetMin = data.utc_offset_seconds / 60;
if (offsetMin !== dest.utcOffsetMinutes) {
  console.warn(`Note: ${timezone} is UTC${offsetMin >= 0 ? '+' : ''}${offsetMin / 60} now, but destination.json says ${dest.utcOffsetMinutes} min.`);
}
const local = new Date(Date.now() + offsetMin * 60_000).toISOString().slice(0, 19);
const sign = offsetMin >= 0 ? '+' : '-';
const abs = Math.abs(offsetMin);
const savedAt = `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;

const forecast = { savedAt, source: 'Open-Meteo.com (CC BY 4.0)', hours };
writeFileSync(out, JSON.stringify(forecast, null, 1));
const rainy = hours.filter(x => x.precipitationChance >= 50).length;
console.log(`Saved ${hours.length} hours (${hours[0].time} to ${hours.at(-1).time}), ${rainy} with rain ≥50%, to ${out}`);
