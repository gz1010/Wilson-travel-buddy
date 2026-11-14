import type { GeoPoint } from './types';

// Sunrise and sunset from the NOAA solar calculator equations
// (https://gml.noaa.gov/grad/solcalc/calcdetails.html). Accurate to about a
// minute at mid latitudes, which is all the panel needs.

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export interface SunTimes {
  /** Minutes after local midnight, or undefined during polar day/night. */
  sunrise?: number;
  sunset?: number;
}

/**
 * @param date YYYY-MM-DD at the destination
 * @param utcOffsetMinutes the destination's offset from UTC on that date
 */
export function sunTimes(date: string, point: GeoPoint, utcOffsetMinutes: number): SunTimes {
  const [y, m, d] = date.split('-').map(Number);
  // Julian day at local noon, which keeps the solar position close to the events.
  const jd = Date.UTC(y, m - 1, d, 12) / 86_400_000 + 2440587.5 - utcOffsetMinutes / 1440;
  const t = (jd - 2451545) / 36525;

  const meanLong = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const meanAnom = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const ecc = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const center =
    Math.sin(rad(meanAnom)) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(rad(2 * meanAnom)) * (0.019993 - 0.000101 * t) +
    Math.sin(rad(3 * meanAnom)) * 0.000289;
  const trueLong = meanLong + center;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(rad(125.04 - 1934.136 * t));
  const meanObliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliq = meanObliq + 0.00256 * Math.cos(rad(125.04 - 1934.136 * t));
  const decl = deg(Math.asin(Math.sin(rad(obliq)) * Math.sin(rad(appLong))));

  const yy = Math.tan(rad(obliq / 2)) ** 2;
  const eqTime =
    4 *
    deg(
      yy * Math.sin(2 * rad(meanLong)) -
        2 * ecc * Math.sin(rad(meanAnom)) +
        4 * ecc * yy * Math.sin(rad(meanAnom)) * Math.cos(2 * rad(meanLong)) -
        0.5 * yy * yy * Math.sin(4 * rad(meanLong)) -
        1.25 * ecc * ecc * Math.sin(2 * rad(meanAnom)),
    );

  const cosHA =
    Math.cos(rad(90.833)) / (Math.cos(rad(point.lat)) * Math.cos(rad(decl))) -
    Math.tan(rad(point.lat)) * Math.tan(rad(decl));
  if (cosHA < -1 || cosHA > 1) return {};
  const ha = deg(Math.acos(cosHA));

  const solarNoon = 720 - 4 * point.lon - eqTime + utcOffsetMinutes;
  return { sunrise: solarNoon - ha * 4, sunset: solarNoon + ha * 4 };
}
