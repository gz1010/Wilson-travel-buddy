import { bearingDegrees, compassPoint, distanceMeters, formatDistance, walkingMinutes } from '../geo';
import { sunTimes } from '../sun';

const cathedral = { lat: 37.3858, lon: -5.993 };
const plazaEspana = { lat: 37.3772, lon: -5.9869 };

describe('geo', () => {
  test('cathedral to Plaza de España is about 1.1 km, south-south-east', () => {
    const m = distanceMeters(cathedral, plazaEspana);
    expect(m).toBeGreaterThan(1000);
    expect(m).toBeLessThan(1200);
    const b = bearingDegrees(cathedral, plazaEspana);
    expect(b).toBeGreaterThan(140);
    expect(b).toBeLessThan(165);
    expect(compassPoint(b)).toBe('SE');
  });

  test('distance is zero to itself and symmetric', () => {
    expect(distanceMeters(cathedral, cathedral)).toBe(0);
    expect(distanceMeters(cathedral, plazaEspana)).toBeCloseTo(distanceMeters(plazaEspana, cathedral), 6);
  });

  test('walking time and formatting', () => {
    expect(walkingMinutes(0)).toBe(1);
    expect(walkingMinutes(750)).toBe(13);
    expect(formatDistance(432)).toBe('430 m');
    expect(formatDistance(1234)).toBe('1.2 km');
  });
});

describe('sunTimes', () => {
  const seville = { lat: 37.3891, lon: -5.9925 };

  test('near the March equinox the day is a little over 12 hours', () => {
    const { sunrise, sunset } = sunTimes('2026-03-20', seville, 60);
    // Refraction and the sun's disc add about 8 minutes at this latitude.
    expect(sunset! - sunrise!).toBeGreaterThan(12 * 60);
    expect(sunset! - sunrise!).toBeLessThan(12 * 60 + 15);
  });

  test('solar noon in Seville is around 13:30 CET (west of the time zone meridian)', () => {
    const { sunrise, sunset } = sunTimes('2026-03-20', seville, 60);
    const noon = (sunrise! + sunset!) / 2;
    expect(noon).toBeGreaterThan(13 * 60 + 20);
    expect(noon).toBeLessThan(13 * 60 + 40);
  });

  test('November days are shorter than June days', () => {
    const nov = sunTimes('2026-11-15', seville, 60);
    const jun = sunTimes('2026-06-21', seville, 120);
    expect(nov.sunset! - nov.sunrise!).toBeLessThan(11 * 60);
    expect(jun.sunset! - jun.sunrise!).toBeGreaterThan(14 * 60);
  });

  test('polar night has no sunrise', () => {
    expect(sunTimes('2026-12-21', { lat: 78, lon: 15 }, 60)).toEqual({});
  });

  // PLAN.md feature 6 "done when": sunrise within two minutes of a published
  // value. Published times (CET) from weather2travel.com (1, 15, 30 Nov),
  // time.is (6 Nov) and solarwatch.app (8 Nov), looked up 2026-11-14.
  test.each([
    ['2026-11-01', '07:49', '18:26'],
    ['2026-11-06', '07:53', '18:20'],
    ['2026-11-08', '07:56', '18:21'],
    ['2026-11-15', '08:03', '18:14'],
    ['2026-11-30', '08:18', '18:07'],
  ])('Seville %s: sunrise %s, sunset %s, within two minutes', (date, rise, set) => {
    const { sunrise, sunset } = sunTimes(date, seville, 60);
    const min = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
    expect(Math.abs(sunrise! - min(rise))).toBeLessThanOrEqual(2);
    expect(Math.abs(sunset! - min(set))).toBeLessThanOrEqual(2);
  });
});
