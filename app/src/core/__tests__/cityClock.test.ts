import { cityClock, euSummerTime, minutesBetween, shiftClock } from '../time';

describe('cityClock', () => {
  it('reads Seville time from the Mac clock in winter (UTC+1)', () => {
    // 14:02:30 UTC on 15 Nov 2026 is 15:02 in Seville.
    expect(cityClock(Date.UTC(2026, 10, 15, 14, 2, 30), 60)).toEqual({ date: '2026-11-15', minute: 15 * 60 + 2 });
  });

  it('adds the summer hour (UTC+2) and rolls over midnight', () => {
    expect(cityClock(Date.UTC(2026, 6, 1, 22, 30), 60)).toEqual({ date: '2026-07-02', minute: 30 });
  });

  it('switches on the last Sundays of March and October at 01:00 UTC', () => {
    // 2026: 29 March and 25 October.
    expect(euSummerTime(Date.UTC(2026, 2, 29, 0, 59))).toBe(false);
    expect(euSummerTime(Date.UTC(2026, 2, 29, 1, 0))).toBe(true);
    expect(euSummerTime(Date.UTC(2026, 9, 25, 0, 59))).toBe(true);
    expect(euSummerTime(Date.UTC(2026, 9, 25, 1, 0))).toBe(false);
  });

  it('measures and undoes a move of the clock', () => {
    const now = { date: '2026-11-15', minute: 15 * 60 + 3 };
    const later = { date: '2026-11-16', minute: 9 * 60 };
    const d = minutesBetween(now, later);
    expect(d).toBe(1440 - (15 * 60 + 3) + 9 * 60);
    expect(shiftClock(now, d)).toEqual(later);
  });
});
