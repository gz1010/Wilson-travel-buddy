import { seville } from '../../pack/seville';
import { NearbyIndex, nearbyAnswer, nearbyQuery, type NearbyFile } from '../nearby';

const file = require('../../pack/seville/nearby.json') as NearbyFile;
const index = new NearbyIndex(file);
const plazaNueva = seville.places.find(p => p.id === 'plaza-nueva')!.point;

describe('nearby questions', () => {
  it.each([
    ['find movie theatre in sevilla', 'cinema'],
    ['Is there a cinema near here?', 'cinema'],
    ['where can I watch a movie', 'cinema'],
    ['where is the nearest pharmacy', 'pharmacy'],
    ['farmacia cerca', 'pharmacy'],
    ['¿Dónde hay un cajero?', 'atm'],
    ['I need a cash machine', 'atm'],
    ['toilets?', 'toilets'],
    ['any supermarket open now', 'supermarket'],
    ['theatre near me', 'theatre'],
    ['closest restaurant', 'restaurant'],
    ['nearest museum', 'museum'],
  ])('%s → %s', (text, id) => {
    expect(nearbyQuery(text)?.category.id).toBe(id);
  });

  it.each([
    'tell me about the cathedral',
    'which museum should I visit this afternoon',
    'recommend a restaurant for dinner',
    'what is the history of the Giralda',
    'Im staying two more days',
    'where should I eat tapas tonight',
  ])('leaves "%s" to the guide', text => {
    expect(nearbyQuery(text)).toBeUndefined();
  });

  it('asks only for open places when the question says so', () => {
    expect(nearbyQuery('a pharmacy open now?')?.openNow).toBe(true);
    expect(nearbyQuery('nearest pharmacy')?.openNow).toBe(false);
  });
});

describe('the nearby index', () => {
  it('holds the map’s cinemas, not only the guide’s places', () => {
    const names = index.places.filter(p => p.kind === 'cinema').map(p => p.name);
    expect(names).toEqual(expect.arrayContaining(['Cines Avenida', 'Cine Cervantes']));
    expect(index.places.length).toBeGreaterThan(1000);
  });

  it('finds the nearest cinemas from Plaza Nueva, nearest first', () => {
    const q = nearbyQuery('find a cinema')!;
    const found = index.search(q, plazaNueva);
    expect(found.length).toBe(3);
    expect(found.every(r => r.place.kind === 'cinema')).toBe(true);
    expect(found[0].meters).toBeLessThan(1000);
    expect(found.map(r => r.meters)).toEqual([...found.map(r => r.meters)].sort((a, b) => a - b));
    const text = nearbyAnswer(q, found, { city: 'Seville', covered: index.covers(plazaNueva) });
    expect(text).toContain(`The nearest cinema is ${found[0].place.name}`);
    expect(text).toMatch(/about \d+ min on foot/);
    expect(text).toContain('no showtimes');
  });

  it('puts places known to be closed after open ones, and leaves them out for "open now"', () => {
    const tiny = new NearbyIndex({
      source: 'test',
      builtAt: '2026-11-15',
      bounds: [-6.02, 37.37, -5.97, 37.41],
      items: [
        ['Farmacia Cerrada', 'pharmacy', plazaNueva.lat + 0.001, plazaNueva.lon, { hours: { daily: '09:00-14:00' } }],
        ['Farmacia Abierta', 'pharmacy', plazaNueva.lat + 0.004, plazaNueva.lon, { hours: { daily: '09:00-22:00' } }],
      ],
    });
    const evening = { date: '2026-11-15', minute: 18 * 60 };
    const q = nearbyQuery('nearest pharmacy')!;
    expect(tiny.search(q, plazaNueva, evening).map(r => r.place.name)).toEqual(['Farmacia Abierta', 'Farmacia Cerrada']);
    const now = nearbyQuery('pharmacy open now')!;
    const open = tiny.search(now, plazaNueva, evening);
    expect(open.map(r => r.place.name)).toEqual(['Farmacia Abierta']);
    expect(nearbyAnswer(now, open, { city: 'Seville', covered: true })).toContain('open until 22:00');
  });

  it('says so instead of guessing when nothing matches or you are outside the map', () => {
    const q = nearbyQuery('nearest pharmacy')!;
    expect(nearbyAnswer(q, [], { city: 'Seville', covered: true })).toContain("can't find a pharmacy");
    expect(index.covers({ lat: 40.4168, lon: -3.7038 })).toBe(false); // Madrid
    expect(nearbyAnswer(q, [], { city: 'Seville', covered: false })).toContain('only covers the city centre');
  });

  it('never promises "open now" without hours', () => {
    const now = nearbyQuery('pharmacy open now')!;
    const found = index.search(now, plazaNueva, { date: '2026-11-15', minute: 18 * 60 });
    expect(found.every(r => r.place.kind === 'pharmacy')).toBe(true);
    const text = nearbyAnswer(now, found, { city: 'Seville', covered: true });
    if (!found[0].open) expect(text).toContain("can't promise it's open now");
  });
});
