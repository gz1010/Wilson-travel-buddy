import { itineraryAnswer, SAMPLE_ITINERARY } from '../../fixtures/llmAnswers';
import { FixtureLLM } from '../../services/llm/fixtureLLM';
import { seville } from '../../pack/seville';
import {
  detect,
  importIcs,
  importItinerary,
  importText,
  MAX_TRIP_DAYS,
  nameInTitle,
  parseDayHeading,
  parseIcsDuration,
  parseIcsEvents,
  planTextChunks,
  unescapeIcsText,
  unfoldIcs,
} from '../itineraryImport';
import { PackIndex } from '../pack';
import { TRIP_SCHEMA } from '../trip';
import type { ChatRequest, Stop } from '../types';

const index = new PackIndex(seville); // utcOffsetMinutes 60
const ics = (...lines: string[]) => lines.join('\r\n');
const cal = (...events: string[]) =>
  ics('BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...events, 'END:VCALENDAR');
const at = (stops: Stop[], title: string) => {
  const s = stops.find(x => x.title === title);
  if (!s) throw new Error(`No stop "${title}" in ${stops.map(x => x.title).join(' | ')}`);
  return s;
};

const MADRID_VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Madrid',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'DTSTART:19810329T020000',
  'TZNAME:CEST',
  'TZOFFSETTO:+0200',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'DTSTART:19961027T030000',
  'TZNAME:CET',
  'TZOFFSETTO:+0100',
  'END:STANDARD',
  'END:VTIMEZONE',
];

// What Google Calendar exports: UTC times, escaped commas in full addresses, folded lines,
// reminders (VALARM) with their own DESCRIPTION.
const GOOGLE = ics(
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'CALSCALE:GREGORIAN',
  'METHOD:PUBLISH',
  'X-WR-CALNAME:Seville trip',
  'X-WR-TIMEZONE:Europe/Madrid',
  'BEGIN:VEVENT',
  'DTSTART:20261116T083000Z',
  'DTEND:20261116T103000Z',
  'DTSTAMP:20261101T120000Z',
  'UID:abc123@google.com',
  'DESCRIPTION:Tickets booked for 2 people\\, reference AB-1234. Bring ID\\; arri',
  ' ve 15 minutes early.',
  'LOCATION:Real Alcázar de Sevilla\\, Patio de Banderas\\, s/n\\, 41004 Sevilla\\, Spain',
  'SEQUENCE:0',
  'STATUS:CONFIRMED',
  'SUMMARY:Alcázar tickets',
  'TRANSP:OPAQUE',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:This is an event reminder',
  'TRIGGER:-P0DT0H30M0S',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART:20261116T200000Z',
  'DTEND:20261116T213000Z',
  'UID:def456@google.com',
  'LOCATION:Casa Román\\, Plaza de los Venerables\\, 1\\, 41004 Sevilla\\, Spain',
  'SUMMARY:Dinner at Casa Román',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART:20261117T090000Z',
  'DTEND:20261117T103000Z',
  'UID:ghi789@google.com',
  'LOCATION:Catedral de Sevilla\\, Av. de la Constitución\\, s/n\\, 41004 Sevilla\\, Spain',
  'SUMMARY:Cathedral and Giralda',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART:20261115T113000Z',
  'DTEND:20261115T130500Z',
  'UID:flight@google.com',
  'LOCATION:Heathrow Terminal 5',
  'SUMMARY:Flight BA 2620 LHR to SVQ',
  'END:VEVENT',
  'END:VCALENDAR',
);

// What Apple Calendar exports: TZID times with the zone's VTIMEZONE, structured locations
// with coordinates, a hotel stay as a multi-day all-day event.
const APPLE = ics(
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Apple Inc.//macOS 15.1//EN',
  'CALSCALE:GREGORIAN',
  ...MADRID_VTIMEZONE,
  'BEGIN:VEVENT',
  'UID:A1',
  'DTSTART;TZID=Europe/Madrid:20261116T093000',
  'DTEND;TZID=Europe/Madrid:20261116T113000',
  'SUMMARY:Alcázar tickets',
  'LOCATION:Real Alcázar de Sevilla\\nPatio de Banderas\\, s/n\\, 41004 Sevilla\\, España',
  'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS="Patio de Banderas, s/n, 41004 Sevilla, España";X-APPLE-RADIUS=100;X-TITLE="Real Alcázar de Sevilla":geo:37.383,-5.990',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:A2',
  'DTSTART;VALUE=DATE:20261115',
  'DTEND;VALUE=DATE:20261118',
  'SUMMARY:Hotel Casa 1800',
  'LOCATION:Hotel Casa 1800\\nCalle Rodrigo Caro\\, 6\\, 41004 Sevilla\\, España',
  'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE="Hotel Casa 1800":geo:37.3857,-5.9906',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:A3',
  'DTSTART;TZID=Europe/Madrid:20261117T183000',
  'DURATION:PT1H30M',
  'SUMMARY:Basílica de Jesús del Gran Poder',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:A4',
  'DTSTART;TZID=Europe/Madrid:20261117T200000',
  'DTEND;TZID=Europe/Madrid:20261117T220000',
  'SUMMARY:Opera',
  'LOCATION:Teatro de la Maestranza\\nPaseo de Cristóbal Colón\\, 22\\, 41001 Sevilla',
  'END:VEVENT',
  'END:VCALENDAR',
);

describe('detect', () => {
  test('a calendar file is ics, anything else is text', () => {
    expect(detect(GOOGLE)).toBe('ics');
    expect(detect('﻿begin:vcalendar\nEND:VCALENDAR')).toBe('ics');
    expect(detect(SAMPLE_ITINERARY)).toBe('text');
    expect(detect('')).toBe('text');
  });
});

describe('iCalendar reading', () => {
  test('unfolds lines (space or tab) and unescapes text', () => {
    expect(unfoldIcs('SUMMARY:Lunch at El Rinc\r\n oncillo\r\nDESCRIPTION:a\r\n\tb\r\n')).toEqual([
      'SUMMARY:Lunch at El Rinconcillo',
      'DESCRIPTION:ab',
    ]);
    expect(unescapeIcsText('Patio de Banderas\\, s/n\\; 41004\\nSevilla\\\\x')).toBe('Patio de Banderas, s/n; 41004\nSevilla\\x');
  });

  test('reads events, not the reminders inside them', () => {
    const events = parseIcsEvents(GOOGLE);
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      summary: 'Alcázar tickets',
      location: 'Real Alcázar de Sevilla, Patio de Banderas, s/n, 41004 Sevilla, Spain',
      description: 'Tickets booked for 2 people, reference AB-1234. Bring ID; arrive 15 minutes early.',
      start: { date: '2026-11-16', minute: 8 * 60 + 30, utc: true },
    });
  });

  test('DURATION values', () => {
    expect(parseIcsDuration('PT1H30M')).toBe(90);
    expect(parseIcsDuration('P1D')).toBe(1440);
    expect(parseIcsDuration('P1W')).toBe(10080);
    expect(parseIcsDuration('-PT15M')).toBe(-15);
    expect(parseIcsDuration('P')).toBeUndefined();
    expect(parseIcsDuration('soon')).toBeUndefined();
  });

  test('the place name in an event title', () => {
    expect(nameInTitle('Dinner at Casa Román')).toBe('Casa Román');
    expect(nameInTitle('Tickets: Real Alcázar (2 adults)')).toBe('Real Alcázar');
    expect(nameInTitle('Mercado de Feria')).toBe('Mercado de Feria');
    expect(nameInTitle('Late drinks')).toBe('');
    // People and calls are no place; a preposition left by the activity goes.
    expect(nameInTitle('Meet Ana')).toBe('');
    expect(nameInTitle('Coffee with Juan')).toBe('');
    expect(nameInTitle('Dinner at Casa Román with Ana')).toBe('Casa Román');
    expect(nameInTitle('Concert in the Cathedral')).toBe('Cathedral');
    expect(nameInTitle('Meeting point: Plaza Nueva')).toBe('Plaza Nueva');
  });

  test('a calendar pasted with every line indented still reads', () => {
    const pasted = '    BEGIN:VCALENDAR\n    BEGIN:VEVENT\n    DTSTART:20261116T130000\n    SUMMARY:Lunch at El Rinc\n     oncillo\n    END:VEVENT\n    END:VCALENDAR';
    expect(detect(pasted)).toBe('ics');
    expect(parseIcsEvents(pasted)).toMatchObject([{ summary: 'Lunch at El Rinconcillo' }]);
  });
});

describe('importIcs: Google Calendar style (UTC)', () => {
  const { trip, unmatched, warnings } = importIcs(GOOGLE, index, { fileName: 'seville.ics' });

  test('UTC times become Seville time (UTC+1) on the right trip days', () => {
    expect(trip.startDate).toBe('2026-11-15');
    expect(trip.days).toBe(3);
    expect(at(trip.stops, 'Alcázar tickets')).toMatchObject({ day: 2, start: '09:30', durationMinutes: 120, placeId: 'alcazar', fixed: true });
    expect(at(trip.stops, 'Cathedral and Giralda')).toMatchObject({ day: 3, start: '10:00', durationMinutes: 90, placeId: 'catedral' });
    expect(at(trip.stops, 'Flight BA 2620 LHR to SVQ')).toMatchObject({ day: 1, start: '12:30', durationMinutes: 95 });
  });

  test('every event is a fixed stop, in day and time order', () => {
    expect(trip.stops.every(s => s.fixed)).toBe(true);
    expect(trip.stops.map(s => `${s.day} ${s.start}`)).toEqual(['1 12:30', '2 09:30', '2 21:00', '3 10:00']);
    expect(new Set(trip.stops.map(s => s.id)).size).toBe(trip.stops.length);
  });

  test('the description becomes the note; a reminder text does not', () => {
    expect(at(trip.stops, 'Alcázar tickets').note).toBe('Tickets booked for 2 people, reference AB-1234. Bring ID; arrive 15 minutes early.');
  });

  test('a restaurant not in the pack is an unmatched stop with its address, and an unmatched name', () => {
    const dinner = at(trip.stops, 'Dinner at Casa Román');
    expect(dinner).toMatchObject({ day: 2, start: '21:00', durationMinutes: 90 });
    expect(dinner.placeId).toBeUndefined();
    expect(dinner.note).toContain('Plaza de los Venerables');
    expect(unmatched).toEqual(['Casa Román']);
  });

  test('a flight is a stop but no name to look up', () => {
    expect(unmatched.some(n => /flight|heathrow|terminal/i.test(n))).toBe(false);
    expect(warnings).toEqual([]);
  });

  test('the trip survives a save and reload', () => {
    expect(JSON.parse(JSON.stringify(trip))).toEqual(trip);
    expect(trip.description).toContain('Imported from seville.ics.');
  });
});

describe('importIcs: Apple Calendar style (TZID=Europe/Madrid)', () => {
  const { trip, unmatched, warnings } = importIcs(APPLE, index, { interests: ['flamenco'] });

  test('Madrid times stay as they are in November (same offset as the pack)', () => {
    expect(at(trip.stops, 'Alcázar tickets')).toMatchObject({ day: 2, start: '09:30', durationMinutes: 120, placeId: 'alcazar' });
    expect(warnings.some(w => /converted/.test(w))).toBe(false);
  });

  test('the hotel stay is the base (with its coordinates), not a stop, and its name is kept', () => {
    expect(trip.base).toEqual({ name: 'Hotel Casa 1800', placeId: undefined, point: { lat: 37.3857, lon: -5.9906 } });
    expect(trip.stops.some(s => /Casa 1800/.test(s.title))).toBe(false);
    expect(unmatched).toContain('Hotel Casa 1800');
  });

  test('days run from the hotel check-in to its last night', () => {
    expect(trip.startDate).toBe('2026-11-15');
    expect(trip.days).toBe(3);
    expect(trip.interests).toEqual(['flamenco']);
  });

  test('DURATION gives the length; a longer local name still finds the pack place', () => {
    expect(at(trip.stops, 'Basílica de Jesús del Gran Poder')).toMatchObject({ day: 3, start: '18:30', durationMinutes: 90, placeId: 'gran-poder' });
  });

  test('a near name is not taken for a pack place: the opera house is not the bullring', () => {
    const opera = at(trip.stops, 'Opera');
    expect(opera.placeId).toBeUndefined();
    expect(unmatched).toContain('Teatro de la Maestranza');
  });
});

describe('importIcs: times and dates', () => {
  test('all-day events: a pack place is an untimed stop; an unknown name is only a name', () => {
    const { trip, unmatched } = importIcs(
      cal(
        ics('BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261120', 'DTEND;VALUE=DATE:20261121', 'SUMMARY:Feria Market', 'END:VEVENT'),
        ics('BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261121', 'SUMMARY:Convento de Santa Paula', 'END:VEVENT'),
      ),
      index,
    );
    expect(trip).toMatchObject({ startDate: '2026-11-20', days: 2 });
    expect(trip.stops).toHaveLength(1);
    expect(trip.stops[0]).toMatchObject({ title: 'Feria Market', placeId: 'mercado-feria', day: 1, fixed: true });
    expect(trip.stops[0].start).toBeUndefined();
    expect(trip.stops[0].durationMinutes).toBe(index.place('mercado-feria')!.visitMinutes);
    expect(unmatched).toEqual(['Convento de Santa Paula']);
  });

  test('floating times are Seville time; UTC late at night rolls into the next day', () => {
    const { trip } = importIcs(
      cal(
        ics('BEGIN:VEVENT', 'DTSTART:20261116T200000', 'SUMMARY:Tablao Los Gallos', 'END:VEVENT'),
        ics('BEGIN:VEVENT', 'DTSTART:20261116T233000Z', 'SUMMARY:Late drinks', 'LOCATION:Calle Betis 12\\, Sevilla', 'END:VEVENT'),
      ),
      index,
    );
    expect(at(trip.stops, 'Tablao Los Gallos')).toMatchObject({ day: 1, start: '20:00', placeId: 'los-gallos' });
    // An address is not matched to the street's pack place, and "Late drinks" names nothing.
    expect(at(trip.stops, 'Late drinks')).toMatchObject({ day: 2, start: '00:30' });
    expect(at(trip.stops, 'Late drinks').placeId).toBeUndefined();
  });

  test('a TZID without VTIMEZONE is converted through Intl, and the traveller is told', () => {
    const { trip, warnings } = importIcs(
      cal(ics('BEGIN:VEVENT', 'DTSTART;TZID=America/New_York:20261116T040000', 'DTEND;TZID=America/New_York:20261116T060000', 'SUMMARY:Real Alcázar', 'END:VEVENT')),
      index,
    );
    // 04:00 in New York (UTC-5) is 09:00 UTC, 10:00 in Seville.
    expect(trip.stops[0]).toMatchObject({ start: '10:00', durationMinutes: 120, placeId: 'alcazar' });
    expect(warnings.join(' ')).toMatch(/America\/New_York \(UTC-05:00 on 2026-11-16\) were converted to Seville time \(UTC\+01:00\)/);
  });

  test('VTIMEZONE daylight rules: a July 10:00 in Madrid is 10:00 for a summer pack (UTC+2)', () => {
    const summer = new PackIndex({ ...seville, destination: { ...seville.destination, utcOffsetMinutes: 120 } });
    const { trip, warnings } = importIcs(
      cal(
        ...MADRID_VTIMEZONE,
        ics('BEGIN:VEVENT', 'DTSTART;TZID=Europe/Madrid:20260710T100000', 'SUMMARY:Real Alcázar', 'END:VEVENT'),
        ics('BEGIN:VEVENT', 'DTSTART:20260710T150000Z', 'SUMMARY:Seville Cathedral', 'END:VEVENT'),
      ),
      summer,
    );
    expect(trip.stops.map(s => [s.placeId, s.start])).toEqual([
      ['alcazar', '10:00'],
      ['catedral', '17:00'],
    ]);
    expect(warnings).toEqual([]);
  });

  test('an unknown time zone is read as Seville time, with a warning', () => {
    const { trip, warnings } = importIcs(cal(ics('BEGIN:VEVENT', 'DTSTART;TZID=Somewhere Standard Time:20261116T110000', 'SUMMARY:Plaza de España', 'END:VEVENT')), index);
    expect(trip.stops[0]).toMatchObject({ start: '11:00', placeId: 'plaza-espana' });
    expect(warnings).toEqual(['Unknown time zone Somewhere Standard Time: its times were read as Seville time.']);
  });
});

describe('importIcs: what is left out', () => {
  test('a whole-trip event sets the days but is neither a stop nor a name', () => {
    const { trip, unmatched } = importIcs(
      cal(
        ics('BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261115', 'DTEND;VALUE=DATE:20261120', 'SUMMARY:Sevilla trip 2026', 'END:VEVENT'),
        ics('BEGIN:VEVENT', 'DTSTART:20261116T100000', 'SUMMARY:Torre del Oro', 'END:VEVENT'),
      ),
      index,
    );
    expect(trip).toMatchObject({ startDate: '2026-11-15', days: 5 });
    expect(trip.stops.map(s => s.title)).toEqual(['Torre del Oro']);
    expect(unmatched).toEqual([]);
  });

  test('cancelled events are skipped; events far away are not matched to the pack', () => {
    const { trip, unmatched, warnings } = importIcs(
      cal(
        ics('BEGIN:VEVENT', 'DTSTART:20261116T100000', 'SUMMARY:Real Alcázar', 'STATUS:CANCELLED', 'END:VEVENT'),
        ics('BEGIN:VEVENT', 'DTSTART:20261117T090000', 'SUMMARY:Mezquita-Catedral', 'LOCATION:Mezquita-Catedral de Córdoba', 'GEO:37.8789;-4.7794', 'END:VEVENT'),
      ),
      index,
    );
    expect(trip.stops).toHaveLength(1);
    expect(trip.stops[0]).toMatchObject({ title: 'Mezquita-Catedral', start: '09:00' });
    expect(trip.stops[0].placeId).toBeUndefined();
    expect(unmatched).toEqual(['Mezquita-Catedral de Córdoba']);
    expect(warnings).toEqual(['Skipped 1 cancelled event.', 'Outside Seville: "Mezquita-Catedral".']);
  });

  test('an address in another town (Google exports no GEO) is not matched to the pack', () => {
    const { trip, unmatched, warnings } = importIcs(
      cal(
        ics(
          'BEGIN:VEVENT',
          'DTSTART:20261117T090000Z',
          'SUMMARY:Mezquita',
          'LOCATION:Mezquita-Catedral de Córdoba\\, Calle Cardenal Herrero\\, 1\\, 14003 Córdoba\\, Spain',
          'END:VEVENT',
        ),
        // A town near Seville gives its province, and a flight's airport is no outside event.
        ics('BEGIN:VEVENT', 'DTSTART:20261117T180000', 'SUMMARY:Itálica', 'LOCATION:Conjunto Arqueológico de Itálica\\, Av. de Extremadura\\, 2\\, 41970 Santiponce\\, Sevilla\\, Spain', 'END:VEVENT'),
        ics('BEGIN:VEVENT', 'DTSTART:20261116T080000Z', 'SUMMARY:Flight to Seville', 'LOCATION:Madrid-Barajas\\, Av de la Hispanidad\\, s/n\\, 28042 Madrid\\, Spain', 'END:VEVENT'),
      ),
      index,
    );
    expect(at(trip.stops, 'Mezquita').placeId).toBeUndefined();
    expect(unmatched).toEqual(['Mezquita-Catedral de Córdoba', 'Conjunto Arqueológico de Itálica']);
    expect(warnings).toEqual(['Outside Seville: "Mezquita".']);
  });

  test('a meal at a hotel is no stay: the multi-day stay is the base', () => {
    const { trip, unmatched } = importIcs(
      cal(
        ics('BEGIN:VEVENT', 'DTSTART:20261116T200000', 'DTEND:20261116T220000', 'SUMMARY:Dinner', 'LOCATION:Hotel Alfonso XIII\\, Calle San Fernando\\, 2\\, 41004 Sevilla', 'END:VEVENT'),
        ics('BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261115', 'DTEND;VALUE=DATE:20261118', 'SUMMARY:Stay at Hotel Casa 1800', 'END:VEVENT'),
      ),
      index,
    );
    expect(trip.base?.name).toBe('Hotel Casa 1800');
    expect(at(trip.stops, 'Dinner')).toMatchObject({ day: 2, start: '20:00', durationMinutes: 120 });
    expect(unmatched).toEqual(['Hotel Alfonso XIII', 'Hotel Casa 1800']);
  });

  test('a neighbourhood as the location keeps the venue in the title; links and people are no names', () => {
    const { trip, unmatched } = importIcs(
      cal(
        ics('BEGIN:VEVENT', 'DTSTART:20261116T130000', 'SUMMARY:Lunch at El Rinconcillo', 'LOCATION:Santa Cruz', 'END:VEVENT'),
        ics('BEGIN:VEVENT', 'DTSTART:20261116T200000', 'SUMMARY:Dinner at Casa Román with Ana', 'LOCATION:Santa Cruz\\, Sevilla', 'END:VEVENT'),
        ics('BEGIN:VEVENT', 'DTSTART:20261117T100000', 'SUMMARY:Team sync', 'LOCATION:https://meet.google.com/abc-defg-hij', 'END:VEVENT'),
        ics('BEGIN:VEVENT', 'DTSTART:20261117T120000', 'SUMMARY:Meet Ana', 'END:VEVENT'),
      ),
      index,
    );
    expect(at(trip.stops, 'Lunch at El Rinconcillo').placeId).toBe('rinconcillo');
    expect(at(trip.stops, 'Dinner at Casa Román with Ana').placeId).toBe('santa-cruz');
    expect(unmatched).toEqual(['Casa Román']);
  });

  test('a street and its number is an address: the venue in the title is the name', () => {
    const { trip, unmatched } = importIcs(
      cal(
        ics('BEGIN:VEVENT', 'DTSTART:20261116T200000', 'SUMMARY:Dinner at Casa Román', 'LOCATION:Plaza de los Venerables\\, 1\\, 41004 Sevilla', 'END:VEVENT'),
        ics('BEGIN:VEVENT', 'DTSTART:20261117T140000', 'SUMMARY:Lunch at Eslava', 'LOCATION:Calle Eslava\\, 3\\, Sevilla', 'END:VEVENT'),
        ics('BEGIN:VEVENT', 'DTSTART:20261117T100000', 'SUMMARY:Visit', 'LOCATION:Real Alcázar\\, Patio de Banderas\\, s/n\\, Sevilla', 'END:VEVENT'),
      ),
      index,
    );
    expect(at(trip.stops, 'Dinner at Casa Román').placeId).toBeUndefined();
    expect(at(trip.stops, 'Dinner at Casa Román').note).toContain('Plaza de los Venerables');
    expect(at(trip.stops, 'Lunch at Eslava').placeId).toBe('eslava');
    expect(at(trip.stops, 'Visit').placeId).toBe('alcazar');
    expect(unmatched).toEqual(['Casa Román']);
  });

  test('one distinctive word finds its place; a word several places share does not', () => {
    const { trip, unmatched } = importIcs(
      cal(
        ics('BEGIN:VEVENT', 'DTSTART:20261116T180000', 'SUMMARY:Sunset at Las Setas', 'END:VEVENT'),
        ics('BEGIN:VEVENT', 'DTSTART:20261116T120000', 'SUMMARY:Bullfight museum', 'LOCATION:Real Maestranza', 'END:VEVENT'),
        ics('BEGIN:VEVENT', 'DTSTART:20261116T200000', 'SUMMARY:Tapas crawl in Triana', 'END:VEVENT'),
      ),
      index,
    );
    expect(trip.stops.map(s => [s.title, s.placeId ?? null])).toEqual([
      ['Bullfight museum', 'maestranza'],
      ['Sunset at Las Setas', 'setas'],
      ['Tapas crawl in Triana', null],
    ]);
    expect(unmatched).toEqual(['Triana']);
  });

  test('more than 14 days: keeps the 14 with the most events', () => {
    const day = (date: string, title: string) => ics('BEGIN:VEVENT', `DTSTART:${date}T100000`, `SUMMARY:${title}`, 'END:VEVENT');
    const { trip, warnings } = importIcs(
      cal(day('20261001', 'Dentist'), day('20261115', 'Real Alcázar'), day('20261116', 'Seville Cathedral'), day('20261120', 'Plaza de España'), day('20261231', 'Party')),
      index,
    );
    expect(trip.startDate).toBe('2026-11-15');
    expect(trip.days).toBe(6);
    expect(trip.days).toBeLessThanOrEqual(MAX_TRIP_DAYS);
    expect(trip.stops.map(s => s.placeId)).toEqual(['alcazar', 'catedral', 'plaza-espana']);
    expect(warnings).toEqual(['Left out 2 events outside 2026-11-15 to 2026-11-28: the app plans up to 14 days.']);
  });

  test('a file without events gives an empty one-day trip from today', () => {
    const { trip, warnings } = importIcs(cal(), index, { today: '2026-11-15' });
    expect(trip).toMatchObject({ startDate: '2026-11-15', days: 1, stops: [] });
    expect(warnings).toEqual(['No events found in the calendar file.']);
  });
});

describe('day headings in pasted text', () => {
  const TODAY = '2026-11-15'; // a Sunday
  test.each([
    ['Day 1', { dayNum: 1 }],
    ['## Día 3 (martes)', { dayNum: 3, wd: 2 }],
    ['Days 4-5: Córdoba', { dayNum: 4, dayEnd: 5 }],
    ['Day 2 – Tuesday 17 Nov', { dayNum: 2, wd: 2, date: '2026-11-17' }],
    ['Mon 16 Nov', { wd: 1, date: '2026-11-16' }],
    ['**Wednesday**', { wd: 3 }],
    ['Tuesday: Alcázar at 10', { wd: 2 }],
    ['2026-11-18', { date: '2026-11-18' }],
    ['18/11/2026 - Córdoba', { date: '2026-11-18' }],
    ['16 de noviembre', { date: '2026-11-16' }],
    ['November 16th', { date: '2026-11-16' }],
    ['Jan 3', { date: '2027-01-03' }],
    ['Monday 16th', { wd: 1, date: '2026-11-16' }],
    ['Lunes 16: Triana', { wd: 1, date: '2026-11-16' }],
    ['16/11 - Córdoba', { date: '2026-11-16' }],
  ])('%s is a heading', (line, expected) => {
    expect(parseDayHeading(line, TODAY)).toEqual(expected);
  });
  test.each([
    'Tuesday afternoon I have a museum ticket',
    'Day trip to Córdoba',
    'Sunset at Las Setas',
    '10:00 Alcázar',
    '1. Cathedral',
    '1/2 day at the beach',
    'Tuesday 3 museums',
    'Monday 10 am Alcázar',
    'Monday 16:30 Alcázar',
    'Monday 16 - Alcázar',
    '10.30 - Alcázar',
    '11.10 - Cathedral',
  ])(
    '%s is not a heading',
    line => {
      expect(parseDayHeading(line, TODAY)).toBeUndefined();
    },
  );
});

describe('splitting pasted text into model calls', () => {
  test('one call per day heading; a short intro rides with day 1', () => {
    const plan = planTextChunks(SAMPLE_ITINERARY, '2026-11-14');
    expect(plan.startDate).toBe('2026-11-15');
    expect(plan.days).toBe(3);
    expect(plan.chunks.map(c => c.day)).toEqual([1, 2, 3]);
    expect(plan.chunks[0].text.startsWith('Seville, staying at Hotel Casa 1800')).toBe(true);
    expect(plan.chunks[0].countDays).toBe(true);
    expect(plan.chunks[2].text).toBe('Day 3 - Tuesday 17 Nov\n10:00 Plaza de España\n12:00 Parque de María Luisa\n15:00 Museo de Bellas Artes');
  });

  test('weekday headings start the trip on the first such day', () => {
    const plan = planTextChunks('Tuesday:\nAlcázar 10:00\nCathedral 13:00\n\nWednesday:\nLas Setas at sunset\n\nThursday - Triana Market, then lunch', '2026-11-15');
    expect(plan.startDate).toBe('2026-11-17');
    expect(plan.chunks.map(c => [c.day, c.text.split('\n')[0]])).toEqual([
      [1, 'Tuesday:'],
      [2, 'Wednesday:'],
      [3, 'Thursday - Triana Market, then lunch'],
    ]);
  });

  test('a short text without headings is one call, the model choosing the days (as in setup by voice)', () => {
    const plan = planTextChunks("I'm here three days. Tuesday afternoon I have a museum ticket.", '2026-11-15');
    expect(plan.chunks).toEqual([{ text: "I'm here three days. Tuesday afternoon I have a museum ticket.", countDays: true, label: 'the itinerary' }]);
  });

  test('a long text without headings reads each paragraph as a day', () => {
    const para = (n: number) => Array.from({ length: 4 }, (_, i) => `${10 + i}:00 stop ${n}.${i}`).join('\n');
    const plan = planTextChunks([para(1), para(2), para(3)].join('\n\n'), '2026-11-15');
    expect(plan.chunks.map(c => c.day)).toEqual([1, 2, 3]);
    expect(plan.warnings).toEqual(['No day headings found: each paragraph was read as one day.']);
  });

  test('a busy day is split so no call has more than 8 stops, all on that day', () => {
    const busy = ['Day 2', ...Array.from({ length: 14 }, (_, i) => `${String(8 + i).padStart(2, '0')}:00 Place ${i + 1}`)].join('\n');
    const plan = planTextChunks(`Day 1\n10:00 Real Alcázar\n\n${busy}`, '2026-11-15');
    const day2 = plan.chunks.filter(c => c.day === 2);
    expect(day2).toHaveLength(2);
    expect(day2[1].text.startsWith('Day 2 (Monday 2026-11-16), continued:')).toBe(true);
    for (const c of plan.chunks) expect(c.text.split('\n').filter(l => /^\d\d:00/.test(l)).length).toBeLessThanOrEqual(8);
  });

  test('one line with more stops than a call takes is cut at its times', () => {
    const line = Array.from({ length: 20 }, (_, i) => `${String(8 + (i % 12)).padStart(2, '0')}:00 Place ${i}`).join(', ');
    const plan = planTextChunks(`Day 1: ${line}`, '2026-11-15');
    expect(plan.chunks.length).toBeGreaterThanOrEqual(3);
    expect(plan.chunks.every(c => c.day === 1)).toBe(true);
    for (const c of plan.chunks) expect((c.text.match(/\d\d:00/g) ?? []).length).toBeLessThanOrEqual(8);
    expect(plan.chunks.map(c => c.text).join('\n')).toContain('15:00 Place 19');
  });

  test('days after day 14 are left out with a warning', () => {
    const text = Array.from({ length: 16 }, (_, i) => `Day ${i + 1}\n10:00 Real Alcázar`).join('\n\n');
    const plan = planTextChunks(text, '2026-11-15');
    expect(plan.days).toBe(14);
    expect(plan.chunks).toHaveLength(14);
    expect(plan.warnings).toEqual(['Left out 2 days after day 14: the app plans up to 14 days.']);
  });
});

describe('importText (recorded Bonsai-2 answers)', () => {
  test('reads each day through trip.extract and merges them in order', async () => {
    const llm = new FixtureLLM({ 'trip.extract': itineraryAnswer }, 0);
    const progress: string[] = [];
    const { trip, unmatched, warnings } = await importText(SAMPLE_ITINERARY, {
      llm,
      index,
      today: '2026-11-14',
      onProgress: (done, total) => progress.push(`${done}/${total}`),
    });
    expect(progress).toEqual(['0/3', '1/3', '2/3', '3/3']);
    expect(llm.calls).toHaveLength(3);
    for (const { req, schema } of llm.calls) {
      expect(schema).toBe(TRIP_SCHEMA);
      expect(req.maxTokens).toBe(700);
    }
    // Each call's calendar starts on its own day, so "day 1" is that day.
    expect(llm.calls[1].req.messages[0].content).toContain('day 1 = Monday 2026-11-16');
    expect(trip.startDate).toBe('2026-11-15');
    expect(trip.days).toBe(3);
    // The model numbered day 3's stops 2, 3 and 4; the headings put them all on day 3.
    expect(trip.stops.map(s => [s.day, s.start, s.placeId ?? null])).toEqual([
      [1, '14:00', null],
      [1, '18:00', 'santa-cruz'],
      [1, '21:00', null],
      [2, '09:30', 'alcazar'],
      [2, '13:00', 'rinconcillo'],
      [2, '16:00', 'catedral'],
      [2, '21:00', 'casa-memoria'],
      [3, '10:00', 'plaza-espana'],
      [3, '12:00', 'parque-maria-luisa'],
      [3, '15:00', 'bellas-artes'],
    ]);
    expect(trip.base).toMatchObject({ name: 'Hotel Casa 1800 in Santa Cruz', placeId: 'santa-cruz' });
    expect(trip.interests).toEqual(['tapas', 'flamenco']);
    expect(unmatched).toEqual(['Casa Román', 'Hotel Casa 1800']);
    expect(warnings).toEqual([]);
    expect(JSON.parse(JSON.stringify(trip))).toEqual(trip);
  });

  test('without headings: one call, and the model sets the days, as in setup by voice', async () => {
    const llm = new FixtureLLM(
      {
        'trip.extract': JSON.stringify({
          days: 3,
          base_area: null,
          interests: ['architecture'],
          stops: [{ title: 'Museum ticket', place_name: null, weekday: 'Tuesday', day: 2, start: '15:00', duration_minutes: null, fixed: true }],
        }),
      },
      0,
    );
    const { trip } = await importText("I'm here three days. Tuesday afternoon I have a museum ticket.", { llm, index, today: '2026-11-15' });
    expect(llm.calls).toHaveLength(1);
    expect(trip).toMatchObject({ startDate: '2026-11-15', days: 3 });
    expect(trip.stops[0]).toMatchObject({ day: 3, start: '15:00', fixed: true });
  });

  test("a fuzzy pin the model's place name does not confirm is undone, and the name kept", async () => {
    const stop = (title: string, place_name: string, start: string) => ({ title, place_name, weekday: null, day: 1, start, duration_minutes: null, fixed: true });
    const llm = new FixtureLLM(
      {
        'trip.extract': JSON.stringify({
          days: 1,
          base_area: null,
          interests: [],
          stops: [
            stop('Opera', 'Teatro de la Maestranza', '20:00'),
            stop('Iglesia de San Marcos', 'Iglesia de San Marcos', '11:00'),
            stop('Bullfight museum', 'Real Maestranza', '13:00'),
          ],
        }),
      },
      0,
    );
    const { trip, unmatched } = await importText('Day 1\n11:00 Iglesia de San Marcos\n13:00 Real Maestranza\n20:00 Opera at Teatro de la Maestranza', { llm, index, today: '2026-11-15' });
    expect(trip.stops.map(s => [s.title, s.placeId ?? null, s.durationMinutes ?? null])).toEqual([
      ['Iglesia de San Marcos', null, null],
      ['Bullfight museum', 'maestranza', index.place('maestranza')!.visitMinutes],
      ['Opera', null, null],
    ]);
    expect(unmatched).toEqual(['Teatro de la Maestranza', 'Iglesia de San Marcos']);
  });

  test('the city itself as base_area is no base', async () => {
    const answer = (base_area: string) =>
      JSON.stringify({ days: 1, base_area, interests: [], stops: [{ title: 'Real Alcázar', place_name: 'Real Alcázar', weekday: null, day: 1, start: '10:00', duration_minutes: null, fixed: true }] });
    const city = await importText('Day 1: Real Alcázar at 10:00', { llm: new FixtureLLM({ 'trip.extract': answer('Seville') }, 0), index, today: '2026-11-15' });
    expect(city.trip.base).toBeUndefined();
    expect(city.unmatched).toEqual([]);
    const hotel = await importText('Day 1: Real Alcázar at 10:00', { llm: new FixtureLLM({ 'trip.extract': answer('Hotel Casa 1800') }, 0), index, today: '2026-11-15' });
    expect(hotel.trip.base?.name).toBe('Hotel Casa 1800');
  });

  test('a day that fails becomes a warning; the other days are kept', async () => {
    const llm = new FixtureLLM(
      {
        'trip.extract': (req: ChatRequest) => {
          if (/Day 2/.test(req.messages[1].content)) throw new Error('Model returned invalid JSON');
          return itineraryAnswer(req);
        },
      },
      0,
    );
    const { trip, warnings } = await importText(SAMPLE_ITINERARY, { llm, index, today: '2026-11-14' });
    expect(trip.stops.map(s => s.day)).toEqual([1, 1, 1, 3, 3, 3]);
    expect(trip.days).toBe(3);
    expect(warnings).toEqual(["Couldn't read day 2: Model returned invalid JSON"]);
  });

  test('when every call fails (no model), it throws', async () => {
    const llm = new FixtureLLM({}, 0);
    await expect(importText(SAMPLE_ITINERARY, { llm, index, today: '2026-11-14' })).rejects.toThrow('No recorded answer for "trip.extract"');
  });

  test('stops between days when cancelled', async () => {
    const signal = { aborted: false };
    const llm = new FixtureLLM({ 'trip.extract': itineraryAnswer }, 0);
    const run = importText(SAMPLE_ITINERARY, {
      llm,
      index,
      today: '2026-11-14',
      signal,
      onProgress: done => {
        if (done === 1) signal.aborted = true;
      },
    });
    await expect(run).rejects.toThrow('Import cancelled.');
    expect(llm.calls).toHaveLength(1);
  });
});

describe('importItinerary', () => {
  test('a calendar file is read in code, without the model', async () => {
    const llm = new FixtureLLM({}, 0);
    const { trip } = await importItinerary(GOOGLE, { llm, index, today: '2026-11-14' });
    expect(llm.calls).toHaveLength(0);
    expect(trip.stops).toHaveLength(4);
  });

  test('text goes through the model', async () => {
    const llm = new FixtureLLM({ 'trip.extract': itineraryAnswer }, 0);
    const { trip } = await importItinerary(SAMPLE_ITINERARY, { llm, index, today: '2026-11-14' });
    expect(llm.calls).toHaveLength(3);
    expect(trip.stops).toHaveLength(10);
  });
});
