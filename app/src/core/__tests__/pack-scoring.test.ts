import { routeIntent } from '../intent';
import { PackIndex, fold } from '../pack';
import { scoreCandidates } from '../scoring';
import type { Pack, Situation, Trip } from '../types';
import { seville } from '../../pack/seville';

const index = new PackIndex(seville);

describe('the Seville pack', () => {
  test('place IDs are unique and every place has what scoring needs', () => {
    const ids = seville.places.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const [w, s, e, n] = seville.destination.bounds;
    for (const p of seville.places) {
      expect(p.point.lon).toBeGreaterThanOrEqual(w);
      expect(p.point.lon).toBeLessThanOrEqual(e);
      expect(p.point.lat).toBeGreaterThanOrEqual(s);
      expect(p.point.lat).toBeLessThanOrEqual(n);
      expect(p.tags.length).toBeGreaterThan(0);
      expect(p.visitMinutes).toBeGreaterThan(0);
      expect(typeof p.indoor).toBe('boolean');
    }
  });

  test('facts point at real places', () => {
    for (const f of seville.facts) {
      if (f.placeId) expect(index.place(f.placeId)).toBeDefined();
    }
  });

  test('forecast hours are consecutive', () => {
    const hours = seville.forecast.hours;
    for (let i = 1; i < hours.length; i++) {
      const prev = new Date(hours[i - 1].time + ':00Z').getTime();
      const cur = new Date(hours[i].time + ':00Z').getTime();
      expect(cur - prev).toBe(3_600_000);
    }
  });
});

describe('PackIndex', () => {
  test('fold strips accents', () => {
    expect(fold('Real Alcázar')).toBe('real alcazar');
  });

  test('findPlace matches names with or without accents and articles', () => {
    expect(index.findPlace('take me to the cathedral')?.id).toBe('catedral');
    expect(index.findPlace('is the Alcazar open?')?.id).toBe('alcazar');
    expect(index.findPlace('Plaza de España')?.id).toBe('plaza-espana');
  });

  test('search finds a place by what it is', () => {
    const hits = index.query('Columbus tomb');
    expect(hits.some(h => h.placeId === 'catedral')).toBe(true);
  });
});

describe('routeIntent', () => {
  test.each([
    ['What should I do now?', true, 'recommend'],
    ["I'm hungry", true, 'recommend'],
    ['Translate for me, I need to talk to the waiter', true, 'translator'],
    ['How do I say thank you?', true, 'phrase'],
    ['Move the museum to tomorrow', true, 'trip.edit'],
    ["I'm here three days, staying near the old town", false, 'trip.setup'],
    ['When was the cathedral built?', true, 'guide'],
    ['When was the cathedral built?', false, 'trip.setup'],
  ] as const)('%s (trip: %s) → %s', (text, hasTrip, intent) => {
    expect(routeIntent(text, hasTrip)).toBe(intent);
  });
});

describe('scoreCandidates', () => {
  // Tuesday 17 November 2026, standing in the middle of the old town.
  const date = '2026-11-17';
  const trip: Trip = {
    startDate: '2026-11-16',
    days: 3,
    interests: ['architecture', 'food', 'views'],
    stops: [],
    description: '',
  };
  const at = (hhmm: string): Situation => {
    const [h, m] = hhmm.split(':').map(Number);
    return {
      clock: { date, minute: h * 60 + m },
      location: seville.destination.center,
      locationLabel: 'Old town',
      visited: [],
    };
  };
  const withRainFrom = (hour: number): PackIndex => {
    const pack: Pack = {
      ...seville,
      forecast: {
        ...seville.forecast,
        hours: seville.forecast.hours.map(h =>
          h.time.startsWith(date) && Number(h.time.slice(11, 13)) >= hour ? { ...h, precipitationChance: 80 } : h,
        ),
      },
    };
    return new PackIndex(pack);
  };

  test('returns at most 8, all from the pack, best first', () => {
    const c = scoreCandidates(index, trip, at('13:00'));
    expect(c.length).toBeGreaterThan(0);
    expect(c.length).toBeLessThanOrEqual(8);
    for (const x of c) expect(index.place(x.place.id)).toBe(x.place);
    for (let i = 1; i < c.length; i++) expect(c[i - 1].score).toBeGreaterThanOrEqual(c[i].score);
  });

  test('skips places that are closed or already visited', () => {
    const late = scoreCandidates(index, trip, at('23:30'), { limit: 100 });
    for (const x of late) expect(x.place.id).not.toBe('catedral');
    const visited = { ...at('13:00'), visited: ['catedral'] };
    expect(scoreCandidates(index, trip, visited, { limit: 100 }).map(x => x.place.id)).not.toContain('catedral');
  });

  // PLAN.md, feature 2 "done when": moving the clock from 13:00 to 17:00 with
  // rain forecast after 16:00 drops the outdoor viewpoint.
  test('rain after 16:00 pushes the outdoor viewpoint below indoor places', () => {
    const rainy = withRainFrom(16);
    const rank = (hhmm: string) => scoreCandidates(rainy, trip, at(hhmm), { limit: 100 }).map(x => x.place.id);

    const midday = rank('13:00');
    const evening = rank('17:00');
    expect(midday.slice(0, 3)).toContain('setas');
    expect(evening.slice(0, 3)).not.toContain('setas');

    const top3 = scoreCandidates(rainy, trip, at('17:00')).slice(0, 3);
    for (const c of top3) expect(c.place.indoor).toBe(true);
  });
});
