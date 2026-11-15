import {
  DAY_SLOTS,
  dayLabel,
  dayTimeline,
  forecastDates,
  monthLabel,
  pickDistinct,
  placeBefore,
  planDates,
  planDays,
  reasonWithoutWalk,
  spokenDate,
  stopSpan,
} from '../dayplan';
import type { Stop, Trip } from '../types';

const trip = (startDate: string, days: number, stops: Stop[] = []): Trip => ({ startDate, days, interests: [], stops, description: '' });
const stop = (id: string, start?: string, durationMinutes?: number, placeId?: string, day = 1): Stop => ({ id, title: id, day, start, durationMinutes, placeId, fixed: false });
const forecast = ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'];

describe('day labels', () => {
  test('short, month and spoken forms ignore the Mac time zone', () => {
    expect(dayLabel('2026-11-15')).toBe('Sun 15');
    expect(dayLabel('2026-12-01')).toBe('Tue 1');
    expect(monthLabel('2026-11-15')).toBe('Nov');
    expect(spokenDate('2026-11-16')).toBe('Monday 16 November');
  });

  test('forecast dates are the distinct days of its hours, in order', () => {
    expect(forecastDates([{ time: '2026-11-16T01:00' }, { time: '2026-11-15T23:00' }, { time: '2026-11-16T02:00' }])).toEqual(['2026-11-15', '2026-11-16']);
  });
});

describe('the day strip', () => {
  test('a trip shows each of its days from the start date', () => {
    expect(planDates(trip('2026-11-15', 3), '2026-11-15', forecast)).toEqual(['2026-11-15', '2026-11-16', '2026-11-17']);
  });

  test('days added to the trip show up', () => {
    const t = trip('2026-11-15', 3);
    expect(planDates({ ...t, days: 5 }, '2026-11-15')).toHaveLength(5);
    expect(planDates({ ...t, days: 5 }, '2026-11-15').at(-1)).toBe('2026-11-19');
  });

  test('no trip: today and the next days the forecast covers', () => {
    expect(planDates(undefined, '2026-11-18', forecast)).toEqual(['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21']);
    expect(planDates(undefined, '2026-12-25', forecast)).toEqual(['2026-12-25']);
    expect(planDates(undefined, '2026-11-15')).toEqual(['2026-11-15']);
  });

  test('today outside the trip is still there, in date order', () => {
    expect(planDates(trip('2026-11-17', 2), '2026-11-15')).toEqual(['2026-11-15', '2026-11-17', '2026-11-18']);
    expect(planDates(trip('2026-11-10', 2), '2026-11-15')).toEqual(['2026-11-10', '2026-11-11', '2026-11-15']);
  });

  test('never more than the longest trip', () => {
    expect(planDates(trip('2026-11-15', 40), '2026-11-15')).toHaveLength(14);
    expect(planDates(trip('2026-11-15', 0), '2026-11-15')).toEqual(['2026-11-15']);
  });

  test('the month shows on the first day and where it changes; trip days and today are marked', () => {
    const days = planDays(trip('2026-11-29', 4), '2026-11-30');
    expect(days.map(d => d.label)).toEqual(['Sun 29', 'Mon 30', 'Tue 1', 'Wed 2']);
    expect(days.map(d => d.month)).toEqual(['Nov', undefined, 'Dec', undefined]);
    expect(days.map(d => d.tripDay)).toEqual([1, 2, 3, 4]);
    expect(days.map(d => d.today)).toEqual([false, true, false, false]);
    expect(days[2].spoken).toBe('Tuesday 1 December');
  });

  test('a day outside the trip has no trip day', () => {
    const days = planDays(trip('2026-11-17', 1), '2026-11-15');
    expect(days.map(d => [d.date, d.tripDay])).toEqual([
      ['2026-11-15', undefined],
      ['2026-11-17', 1],
    ]);
  });
});

describe('a day timeline', () => {
  const labels = (rows: ReturnType<typeof dayTimeline>) => rows.map(r => r.label);

  test('an empty day is the default times', () => {
    const rows = dayTimeline([]);
    expect(labels(rows)).toEqual(['09:00', '11:00', '13:00', '16:00', '18:00', '20:00', '22:00']);
    expect(rows.every(r => r.open && !r.past && !r.now && r.stops.length === 0)).toBe(true);
    expect(DAY_SLOTS).toHaveLength(7);
  });

  test('stops add their own times and fill the default times they cover', () => {
    const rows = dayTimeline([stop('museum', '10:30', 120), stop('lunch', '13:00'), stop('show', '21:15', 75)]);
    // 11:00 is inside the museum, 13:00 is the lunch itself (an hour by default), 22:00 inside the show.
    expect(labels(rows)).toEqual(['09:00', '10:30', '13:00', '16:00', '18:00', '20:00', '21:15']);
    expect(rows.find(r => r.label === '13:00')).toMatchObject({ key: 'stop-780', open: false, stops: [expect.objectContaining({ id: 'lunch' })] });
  });

  test('stops at the same time share a row; stops with no time come first', () => {
    const rows = dayTimeline([stop('a', '18:00', 30), stop('b', '18:00', 30), stop('loose'), stop('bad', 'nine')]);
    expect(rows[0]).toMatchObject({ key: 'any', label: 'Any time', open: false });
    expect(rows[0].stops.map(s => s.id)).toEqual(['loose', 'bad']);
    expect(rows.find(r => r.key === 'stop-1080')?.stops.map(s => s.id)).toEqual(['a', 'b']);
  });

  test('today: past default times go, past stops stay marked, now gets a row, the next hour is left to it', () => {
    const rows = dayTimeline([stop('breakfast', '09:30', 45), stop('tour', '17:00', 90)], { now: 10 * 60 + 20 });
    expect(labels(rows)).toEqual(['09:30', '10:20', '13:00', '16:00', '17:00', '20:00', '22:00']);
    expect(rows[0]).toMatchObject({ past: true, open: false });
    expect(rows[1]).toMatchObject({ key: 'now', now: true, open: true, past: false });
    // 11:00 is within the hour after now; 18:00 is inside the tour.
    expect(rows.some(r => r.label === '11:00' || r.label === '18:00')).toBe(false);
  });

  test('a stop still going on is not past', () => {
    const rows = dayTimeline([stop('museum', '10:00', 120), stop('coffee', '10:00', 15), stop('walk', '09:00')], { now: 10 * 60 + 20 });
    expect(rows.map(r => [r.key, r.past])).toEqual([
      ['stop-540', true],
      ['stop-600', false],
      ['now', false],
      ['slot-780', false],
      ['slot-960', false],
      ['slot-1080', false],
      ['slot-1200', false],
      ['slot-1320', false],
    ]);
  });

  test('a stop starting right now comes before the now row', () => {
    const rows = dayTimeline([stop('ticket', '12:00', 60)], { now: 12 * 60 });
    expect(rows.slice(0, 2).map(r => r.key)).toEqual(['stop-720', 'now']);
    expect(rows[0].past).toBe(false);
  });

  test('late at night only now is left', () => {
    expect(dayTimeline([], { now: 23 * 60 + 30 }).map(r => r.key)).toEqual(['now']);
  });

  test('custom slots', () => {
    expect(labels(dayTimeline([], { slots: [8 * 60, 19 * 60 + 30] }))).toEqual(['08:00', '19:30']);
  });
});

describe('suggestions down the day', () => {
  const c = (id: string) => ({ place: { id } });

  test('each time gets its best place not already taken', () => {
    const picks = pickDistinct([[c('a'), c('b')], [c('a'), c('c'), c('d')], [c('b'), c('c')]], ['b']);
    expect(picks.map(p => p.map(x => x.place.id))).toEqual([['a'], ['c'], []]);
  });

  test('more than one per time', () => {
    expect(pickDistinct([[c('a'), c('b'), c('c')], [c('c'), c('d')]], [], 2).map(p => p.map(x => x.place.id))).toEqual([['a', 'b'], ['c', 'd']]);
  });

  test('where the traveller will be: the latest stop with a place before the time', () => {
    const stops = [stop('a', '09:00', 60, 'alcazar'), stop('b', '12:00', 60), stop('c', '14:00', 60, 'triana'), stop('d', undefined, 60, 'loose')];
    expect(placeBefore(stops, 8 * 60)).toBeUndefined();
    expect(placeBefore(stops, 13 * 60)).toBe('alcazar');
    expect(placeBefore(stops, 14 * 60)).toBe('alcazar');
    expect(placeBefore(stops, 16 * 60)).toBe('triana');
  });
});

describe('card text', () => {
  test('stop span', () => {
    expect(stopSpan(stop('a', '13:00', 90))).toBe('13:00–14:30');
    expect(stopSpan(stop('a', '23:30', 60))).toBe('23:30–00:30');
    expect(stopSpan(stop('a', '13:00'))).toBe('13:00');
    expect(stopSpan(stop('a'))).toBeUndefined();
  });

  test('the walk is on its own pill, so the reason drops it', () => {
    expect(reasonWithoutWalk('8 min walk; you like tapas; open until 23:00.')).toBe('You like tapas; open until 23:00.');
    expect(reasonWithoutWalk('8 min walk.')).toBeUndefined();
    expect(reasonWithoutWalk('A quiet courtyard, 8 min walk away.')).toBe('A quiet courtyard, 8 min walk away.');
  });
});
