import { addDays, formatHHMM, minutesBetween, openState, parseHHMM, shiftClock, weekday } from '../time';

describe('dates and clock', () => {
  test('weekday ignores the Mac time zone', () => {
    expect(weekday('2026-11-15')).toBe(0); // Sunday
    expect(weekday('2026-11-17')).toBe(2); // Tuesday
  });

  test('addDays crosses month ends', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  test('HH:MM round trip', () => {
    expect(parseHHMM('09:05')).toBe(545);
    expect(formatHHMM(545)).toBe('09:05');
    expect(formatHHMM(1440 + 30)).toBe('00:30');
    expect(() => parseHHMM('9am')).toThrow();
  });

  test('shiftClock rolls over midnight both ways', () => {
    expect(shiftClock({ date: '2026-11-15', minute: 1430 }, 20)).toEqual({ date: '2026-11-16', minute: 10 });
    expect(shiftClock({ date: '2026-11-15', minute: 10 }, -20)).toEqual({ date: '2026-11-14', minute: 1430 });
  });

  test('minutesBetween spans days', () => {
    expect(minutesBetween({ date: '2026-11-15', minute: 1380 }, { date: '2026-11-16', minute: 60 })).toBe(120);
  });
});

describe('openState', () => {
  const tue = (hhmm: string) => ({ date: '2026-11-17', minute: parseHHMM(hhmm) });

  test('open with time left and closing time', () => {
    expect(openState({ tue: '11:00-17:00' }, tue('16:00'))).toEqual({ open: true, minutesLeft: 60, closesAt: '17:00' });
  });

  test('closed before opening reports next opening', () => {
    expect(openState({ tue: '11:00-17:00' }, tue('09:00'))).toEqual({ open: false, opensAt: '11:00' });
  });

  test('split hours', () => {
    const hours = { tue: '12:00-16:00,20:00-23:30' };
    expect(openState(hours, tue('17:00')).open).toBe(false);
    expect(openState(hours, tue('17:00')).opensAt).toBe('20:00');
    expect(openState(hours, tue('21:00')).open).toBe(true);
  });

  test('a late range runs past midnight into the next day', () => {
    // Monday 20:00–02:00 is still open at 01:00 on Tuesday.
    expect(openState({ mon: '20:00-02:00', tue: 'closed' }, tue('01:00')).open).toBe(true);
    expect(openState({ mon: '20:00-02:00', tue: 'closed' }, tue('03:00')).open).toBe(false);
  });

  test('daily, 24h, closed and unknown', () => {
    expect(openState({ daily: '10:00-14:00' }, tue('12:00')).open).toBe(true);
    expect(openState({ daily: '24h' }, tue('04:00'))).toEqual({ open: true });
    expect(openState({ tue: 'closed' }, tue('12:00')).open).toBe(false);
    expect(openState({ mon: '10:00-14:00' }, tue('12:00'))).toEqual({ open: true, unknown: true });
  });
});
