import { seville } from '../../pack/seville';
import { environment, forecastAge, savedClock, skyWords } from '../environment';
import { PackIndex } from '../pack';
import type { Pack } from '../types';

const hhmm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
const at = (date: string, time: string) => ({ date, minute: hhmm(time) });

// A pack whose forecast is saved Saturday 14 Nov 16:00 CET, clear and 15°C,
// with rain likely on Tuesday 17 Nov from 16:00.
const pack: Pack = {
  ...seville,
  forecast: {
    savedAt: '2026-11-14T16:00:00+01:00',
    source: 'test',
    hours: Array.from({ length: 5 * 24 }, (_, i) => {
      const date = `2026-11-${String(15 + Math.floor(i / 24)).padStart(2, '0')}`;
      const hour = i % 24;
      const rain = date === '2026-11-17' && hour >= 16;
      return {
        time: `${date}T${String(hour).padStart(2, '0')}:00`,
        temperatureC: 15.4,
        precipitationChance: rain ? 80 : 10,
        code: rain ? 61 : 0,
      };
    }),
  },
};
const index = new PackIndex(pack);

describe('forecast age', () => {
  test('savedAt is read in destination time, whatever the offset it was written with', () => {
    expect(savedClock('2026-11-14T16:00:00+01:00', 60)).toEqual(at('2026-11-14', '16:00'));
    expect(savedClock('2026-11-14T15:00:00Z', 60)).toEqual(at('2026-11-14', '16:00'));
  });

  test.each([
    [at('2026-11-14', '16:30'), 'saved just now'],
    [at('2026-11-14', '21:10'), 'saved 5 h ago'],
    [at('2026-11-15', '18:00'), 'saved yesterday'],
    [at('2026-11-17', '13:00'), 'saved 2 days ago'],
    [at('2026-11-14', '09:00'), 'saved Sat 16:00'],
  ])('%j → %s', (now, text) => {
    expect(forecastAge(at('2026-11-14', '16:00'), now)).toBe(text);
  });
});

test('skyWords', () => {
  expect(skyWords(0)).toBe('clear');
  expect(skyWords(3)).toBe('cloudy');
  expect(skyWords(63)).toBe('rain');
  expect(skyWords(81)).toBe('rain');
  expect(skyWords(undefined)).toBeUndefined();
});

describe('environment', () => {
  test('Tuesday 13:00: dry now, rain likely from 16:00, sun times, forecast age', () => {
    const env = environment(index, at('2026-11-17', '13:00'));
    expect(env.rainFrom).toBe('16:00');
    expect(env.dark).toBe(false);
    expect(env.line).toMatch(
      /^15°C clear · 10% rain · rain likely from 16:00 · sunrise 08:0\d, sunset 18:1\d · forecast saved 2 days ago$/,
    );
  });

  test('Tuesday 17:00: raining now, so no "from" time', () => {
    const env = environment(index, at('2026-11-17', '17:00'));
    expect(env.rainFrom).toBeUndefined();
    expect(env.sky).toBe('rain');
    expect(env.line.startsWith('15°C rain · 80% rain · sunrise')).toBe(true);
  });

  test('rain more than six hours away is not mentioned yet', () => {
    expect(environment(index, at('2026-11-17', '08:00')).rainFrom).toBeUndefined();
    expect(environment(index, at('2026-11-17', '10:00')).rainFrom).toBe('16:00');
  });

  test('dark before sunrise and after sunset', () => {
    expect(environment(index, at('2026-11-17', '07:00')).dark).toBe(true);
    expect(environment(index, at('2026-11-17', '19:30')).dark).toBe(true);
  });

  test('outside the saved forecast it says so instead of guessing', () => {
    const env = environment(index, at('2026-11-25', '12:00'));
    expect(env.now).toBeUndefined();
    expect(env.line.startsWith('no forecast for this time · sunrise')).toBe(true);
  });

  test('works on the real Seville pack', () => {
    const env = environment(new PackIndex(seville), at('2026-11-15', '12:00'));
    expect(env.now).toBeDefined();
    expect(env.line).toContain('forecast saved');
  });
});
