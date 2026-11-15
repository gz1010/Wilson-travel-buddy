import { NOT_IN_GUIDE } from '../core/prompts';
import type { FixtureAnswer } from '../services/llm/fixtureLLM';
// Real Bonsai-2 answers saved by `npm run eval`; used in place of the hand-written ones below.
import recorded from './recorded.json';

// Recorded model answers for the dev app when no llama-server is running.
// These are real Bonsai-2 4B outputs (14 Nov 2026, `npm run test:live` on
// B's PC), so screens are built against what the model actually writes.

// Real reasons the model gave, by place. Candidates change with the clock and
// location, so places without a recorded reason get a code-style one.
const REASONS: Record<string, string> = {
  'lonja-barranco': 'You can enjoy food at the market while it is indoors and rain is likely now.',
  salvador: 'You can admire architecture at the church which is indoors and close to you.',
  catedral: 'You can admire architecture at the cathedral which is indoors and close to you.',
  'la-campana': 'You can enjoy food here in 8 minutes, and the cafe closes at 21:30.',
  'plaza-nueva': 'You can see architecture in this landmark just 5 minutes from your current location.',
  'palacio-lebrija': 'You can explore this museum\'s architecture, but be aware it closes at 18:00.',
};

// The spec sentence. The model counted Tuesday as day 2; the weekday field
// lets code put it on day 3, as the real app does.
const handWritten: Record<string, FixtureAnswer> = {
  'trip.extract': JSON.stringify({
    days: 3,
    base_area: 'near the old town',
    interests: ['architecture', 'food'],
    stops: [{ title: 'museum', place_name: null, weekday: 'Tuesday', day: 2, start: '15:00', duration_minutes: null, fixed: true }],
  }),
  'trip.revise': req => {
    // Echo the current trip back unchanged; the real model applies the edit.
    const m = /Current trip:\n(.*)\n\nChange:/s.exec(req.messages[1].content);
    return m ? m[1] : '{"days":1,"base_area":null,"interests":[],"stops":[]}';
  },
  recommend: (_req, schema) => {
    const ids: string[] = ((schema as any)?.properties?.picks?.items?.properties?.place_id?.enum ?? []).slice(0, 3);
    return JSON.stringify({
      picks: ids.map(id => ({ place_id: id, reason: REASONS[id] ?? 'It is a short walk away and matches what you like.' })),
    });
  },
  guide: req => guideAnswer(req.messages[1]?.content ?? ''),
  'translate.en-es': '¿Podrías decirme cómo llegar a la catedral desde aquí?',
  'translate.es-en': "It's five minutes away, walking straight down this street.",
  'translate*': '(translation)',
};

/** A real Bonsai-2 4B answer about the Giralda, with the source number the answer prompt asks for. */
const GIRALDA =
  "The Giralda was originally a minaret before it became the Cathedral's tower [1]. Inside there are 35 ramps instead of stairs for riders on horseback to climb [1].";

/**
 * Without a model, a guide question gets the Giralda answer when it is about the Giralda, else
 * the first two sentences of its best source, numbered like the model numbers them: the facts
 * panel and the answers then follow the question, as they do with Bonsai-2.
 */
function guideAnswer(user: string): string {
  const question = /\nQuestion: (.*)$/s.exec(user)?.[1] ?? '';
  const sources = [...user.matchAll(/^\[(\d+)\] [^:\n]+: (.+)$/gm)];
  const giralda = sources.find(s => /Giralda/.test(s[2]));
  if (/giralda/i.test(question) && giralda) return GIRALDA.replace(/\[1\]/g, `[${giralda[1]}]`);
  const best = sources[0];
  if (!best) return NOT_IN_GUIDE;
  const sentences = best[2].replace(/\s*\([^)]*\)/g, '').match(/[^.!?]+[.!?]+/g) ?? [best[2]];
  return sentences
    .slice(0, 2)
    .map(s => `${s.trim().replace(/[.!?]+$/, '')} [${best[1]}].`)
    .join(' ');
}

// Recorded answers win for fixed-text requests. Recommendations stay hand-written: their
// allowed place IDs change with the clock, so a recorded pick could name a closed place.
const replayable = Object.entries(recorded as Record<string, string>).filter(([tag]) => tag !== 'recommend' && tag !== 'trip.revise');
export const llmAnswers: Record<string, FixtureAnswer> = { ...handWritten, ...Object.fromEntries(replayable) };

// ---------------------------------------------------------------------------
// Itinerary import (core/itineraryImport.ts): pasted text is read one day per trip.extract call.

/** A pasted itinerary: a short intro, then three days with headings. */
export const SAMPLE_ITINERARY = `Seville, staying at Hotel Casa 1800 in Santa Cruz. We love tapas and flamenco.

Day 1 - Sunday 15 Nov
14:00 Check in
18:00 Walk through Santa Cruz
21:00 Dinner at Casa Román

Day 2 - Monday 16 Nov
09:30 Real Alcázar (tickets booked)
13:00 Lunch at El Rinconcillo
16:00 Cathedral and Giralda
21:00 Flamenco at Casa de la Memoria

Day 3 - Tuesday 17 Nov
10:00 Plaza de España
12:00 Parque de María Luisa
15:00 Museo de Bellas Artes`;

const itineraryStop = (title: string, place_name: string | null, start: string, day: number, weekday: string | null = null) => ({
  title,
  place_name,
  weekday,
  day,
  start,
  duration_minutes: null,
  fixed: true,
});

/**
 * Real Bonsai-2 4B answers (15 Nov 2026, llama-server) for each day of SAMPLE_ITINERARY, keyed by
 * its heading. The model's day numbers drift (day 3's stops came back as days 2, 3 and 4, with
 * "days": 3); the import pins each stop to its heading's day.
 */
const ITINERARY_DAYS: Record<string, unknown> = {
  'Day 1': {
    days: 1,
    base_area: 'Hotel Casa 1800 in Santa Cruz',
    interests: ['tapas', 'flamenco'],
    stops: [
      itineraryStop('Check in', null, '14:00', 1),
      itineraryStop('Walk through Santa Cruz', 'Santa Cruz', '18:00', 1),
      itineraryStop('Dinner at Casa Román', 'Casa Román', '21:00', 1),
    ],
  },
  'Day 2': {
    days: 1,
    base_area: null,
    interests: [],
    stops: [
      itineraryStop('Real Alcázar', 'Real Alcázar', '09:30', 2, 'Monday'),
      itineraryStop('Lunch at El Rinconcillo', 'El Rinconcillo', '13:00', 2),
      itineraryStop('Cathedral and Giralda', 'Cathedral and Giralda', '16:00', 2),
      itineraryStop('Flamenco at Casa de la Memoria', 'Casa de la Memoria', '21:00', 2),
    ],
  },
  'Day 3': {
    days: 3,
    base_area: null,
    interests: [],
    stops: [
      itineraryStop('Plaza de España', 'Plaza de España', '10:00', 2, 'Tuesday'),
      itineraryStop('Parque de María Luisa', 'Parque de María Luisa', '12:00', 3),
      itineraryStop('Museo de Bellas Artes', 'Museo de Bellas Artes', '15:00', 4),
    ],
  },
};

/** trip.extract for SAMPLE_ITINERARY's days: the recorded answer for the day heading in the request. */
export function itineraryAnswer(req: Parameters<Exclude<FixtureAnswer, string>>[0]): string {
  const user = req.messages[1]?.content ?? '';
  const key = Object.keys(ITINERARY_DAYS).find(k => new RegExp(`(^|\\n)${k}\\b`).test(user));
  return JSON.stringify(key ? ITINERARY_DAYS[key] : { days: 1, base_area: null, interests: [], stops: [] });
}
