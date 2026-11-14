import type { PackIndex } from './pack';
import { RAIN_THRESHOLD } from './scoring';
import { sunTimes } from './sun';
import { formatHHMM, minutesBetween, WEEKDAY_NAMES, weekday } from './time';
import type { Clock, ForecastHour } from './types';

// The environment panel: weather from the saved forecast, with its age, and
// sunrise and sunset computed on-device. Everything is relative to the app's
// clock (the time control), not the Mac's, so the demo can move through the day.

export interface Environment {
  /** The forecast hour for the clock, if the saved forecast covers it. */
  now?: ForecastHour;
  /** Plain-words sky, from the WMO code: "clear", "rain", … */
  sky?: string;
  /** Start of the next hour with rain likely, within six hours, if it is not raining now. */
  rainFrom?: string;
  sunrise?: string;
  sunset?: string;
  dark: boolean;
  /** "saved 3 h ago", "saved yesterday", "saved 4 days ago". */
  forecastAge: string;
  /** One line for the panel or the screen reader. */
  line: string;
}

/** The forecast's savedAt as a destination clock. */
export function savedClock(savedAt: string, utcOffsetMinutes: number): Clock {
  const t = new Date(Date.parse(savedAt) + utcOffsetMinutes * 60_000);
  return { date: t.toISOString().slice(0, 10), minute: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

export function forecastAge(saved: Clock, now: Clock): string {
  const mins = minutesBetween(saved, now);
  if (mins < 0) return `saved ${WEEKDAY_NAMES[weekday(saved.date)].slice(0, 3)} ${formatHHMM(saved.minute)}`;
  if (mins < 60) return 'saved just now';
  if (mins < 24 * 60) return `saved ${Math.floor(mins / 60)} h ago`;
  const days = Math.floor(mins / (24 * 60));
  return days === 1 ? 'saved yesterday' : `saved ${days} days ago`;
}

/** WMO weather interpretation codes, as used by Open-Meteo. */
export function skyWords(code: number | undefined): string | undefined {
  if (code === undefined) return undefined;
  if (code === 0) return 'clear';
  if (code <= 2) return 'partly cloudy';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if (code >= 95) return 'thunderstorms';
  return undefined;
}

export function environment(index: PackIndex, clock: Clock): Environment {
  const dest = index.destination;
  const sun = sunTimes(clock.date, dest.center, dest.utcOffsetMinutes);
  const ahead = index.forecastAhead(clock, 7);
  const now = ahead[0];
  const rainingNow = !!now && now.precipitationChance >= RAIN_THRESHOLD;
  const rainHour = rainingNow ? undefined : ahead.slice(1).find(h => h.precipitationChance >= RAIN_THRESHOLD);
  const age = forecastAge(savedClock(index.pack.forecast.savedAt, dest.utcOffsetMinutes), clock);
  const dark =
    sun.sunrise !== undefined && sun.sunset !== undefined ? clock.minute < sun.sunrise || clock.minute >= sun.sunset : false;

  const env: Environment = {
    now,
    sky: skyWords(now?.code),
    rainFrom: rainHour?.time.slice(11),
    sunrise: sun.sunrise !== undefined ? formatHHMM(sun.sunrise) : undefined,
    sunset: sun.sunset !== undefined ? formatHHMM(sun.sunset) : undefined,
    dark,
    forecastAge: age,
    line: '',
  };

  const parts: string[] = [];
  if (now) {
    parts.push(`${Math.round(now.temperatureC)}°C${env.sky ? ` ${env.sky}` : ''}`);
    parts.push(`${now.precipitationChance}% rain`);
    if (env.rainFrom) parts.push(`rain likely from ${env.rainFrom}`);
  } else {
    parts.push('no forecast for this time');
  }
  if (env.sunrise && env.sunset) parts.push(`sunrise ${env.sunrise}, sunset ${env.sunset}`);
  parts.push(`forecast ${age}`);
  env.line = parts.join(' · ');
  return env;
}
