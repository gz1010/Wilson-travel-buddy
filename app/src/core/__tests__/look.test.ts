import { seville } from '../../pack/seville';
import { clockFor, placeNameSize, sceneFor, timeOfDay } from '../look';
import { PackIndex } from '../pack';

const dest = seville.destination;
const index = new PackIndex(seville);
const at = (h: number, m = 0) => ({ date: '2026-11-15', minute: h * 60 + m }); // sunset ≈ 18:13

describe('time of day', () => {
  it.each([
    [at(6), 'night'],
    [at(9), 'midday'],
    [at(13, 30), 'midday'],
    [at(15), 'afternoon'],
    [at(17, 40), 'dusk'],
    [at(18, 30), 'dusk'],
    [at(19), 'night'],
    [at(23), 'night'],
  ])('%j → %s', (clock, tod) => {
    expect(timeOfDay(clock, dest)).toBe(tod);
  });

  it('each chip sets a clock that reads back as that time of day', () => {
    for (const tod of ['midday', 'afternoon', 'dusk', 'night'] as const) {
      const c = clockFor(tod, at(10), dest);
      expect(timeOfDay(c, dest)).toBe(tod);
      expect(c.minute % 15).toBe(0);
    }
  });

  it('dusk follows the season: later in June than in November', () => {
    const nov = clockFor('dusk', { date: '2026-11-15', minute: 0 }, dest).minute;
    const jun = clockFor('dusk', { date: '2026-06-21', minute: 0 }, { ...dest, utcOffsetMinutes: 120 }).minute;
    expect(jun - nov).toBeGreaterThan(180);
  });
});

describe('place names and scene tiles', () => {
  it('sizes names by length', () => {
    expect(placeNameSize('Las Setas')).toBe(62);
    expect(placeNameSize('Triana Market')).toBe(62);
    expect(placeNameSize('Seville Cathedral')).toBe(46);
    expect(placeNameSize('Casa de Pilatos!')).toBe(54);
  });

  it('gives every place a scene', () => {
    const scenes = new Set(seville.places.map(sceneFor));
    for (const s of scenes) expect(['arches', 'awnings', 'cup', 'tower', 'river']).toContain(s);
    expect(sceneFor(index.place('catedral')!)).toBe('tower');
    expect(sceneFor(index.place('mercado-triana')!)).toBe('awnings');
    expect(sceneFor(index.place('la-campana')!)).toBe('cup');
    expect(sceneFor(index.place('calle-betis')!)).toBe('river');
    expect(sceneFor(index.place('plaza-espana')!)).toBe('arches');
  });
});
