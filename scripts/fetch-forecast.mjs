#!/usr/bin/env node
// Saves a real hourly forecast for the destination into its pack, from
// Open-Meteo (no key needed). Run while online, close to the demo:
//   node scripts/fetch-forecast.mjs [seville]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dest = process.argv[2] ?? 'seville';
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'app/src/pack', dest);
const d = JSON.parse(readFileSync(join(dir, 'destination.json'), 'utf8'));
const url = `https://api.open-meteo.com/v1/forecast?latitude=${d.center.lat}&longitude=${d.center.lon}&hourly=temperature_2m,precipitation_probability,weather_code&forecast_days=7&timezone=auto`;
const res = await fetch(url);
if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
const j = await res.json();
const hours = j.hourly.time.map((t, i) => ({
  time: t, // already local "YYYY-MM-DDTHH:00"
  temperatureC: j.hourly.temperature_2m[i],
  precipitationChance: j.hourly.precipitation_probability[i] ?? 0,
  code: j.hourly.weather_code[i],
}));
const offset = j.utc_offset_seconds / 60;
const sign = offset >= 0 ? '+' : '-';
const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
const mm = String(Math.abs(offset) % 60).padStart(2, '0');
const now = new Date(Date.now() + offset * 60_000).toISOString().slice(0, 19);
writeFileSync(
  join(dir, 'forecast.json'),
  JSON.stringify({ savedAt: `${now}${sign}${hh}:${mm}`, source: 'Open-Meteo (open-meteo.com), CC BY 4.0', hours }, null, 1),
);
if (offset !== d.utcOffsetMinutes) console.warn(`Note: destination.json has utcOffsetMinutes ${d.utcOffsetMinutes}, Open-Meteo says ${offset}.`);
console.log(`Saved ${hours.length} hours, ${hours[0].time} to ${hours.at(-1).time}. The app's clock starts at the first day.`);
