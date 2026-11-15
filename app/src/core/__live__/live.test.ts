/**
 * Live checks against a real Bonsai-2 llama-server: `npm run test:live`.
 * Skipped by `npm test`. Prints every answer and writes last-run.json.
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { seville } from '../../pack/seville';
import { Guide } from '../guide';
import { PackIndex } from '../pack';
import { NOT_IN_GUIDE } from '../prompts';
import { Recommender } from '../recommend';
import { Translator } from '../translate';
import { TripPlanner } from '../trip';
import type { Situation, Trip } from '../types';
import { NodeLlama } from './nodeLlama';

jest.setTimeout(600_000);

const llm = new NodeLlama();
const index = new PackIndex(seville);
const report: Record<string, unknown> = { model: llm.baseUrl, at: new Date().toISOString() };
const SPEC_SENTENCE =
  "I'm here three days, staying near the old town, I love street food and architecture, Tuesday afternoon I have a museum ticket";
const DAY1 = '2026-11-15'; // Sunday; the sample forecast has rain from 16:00

beforeAll(async () => {
  if (!(await llm.ready())) throw new Error(`No llama-server at ${llm.baseUrl}. Start it first.`);
});
afterAll(() => {
  report.calls = llm.log;
  writeFileSync(join(__dirname, 'last-run.json'), JSON.stringify(report, null, 1));
});

let trip: Trip | undefined;

test('trip setup: the spec sentence, five tries', async () => {
  const planner = new TripPlanner(llm, index);
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const t = await planner.extract(SPEC_SENTENCE, DAY1);
    const museum = t.stops.find(s => s.fixed);
    const ok =
      t.days === 3 && !!museum && museum.day === 3 && !!museum.start && museum.start >= '12:00' && museum.start <= '18:00';
    runs.push({ ok, ms: Date.now() - t0, days: t.days, base: t.base?.name, interests: t.interests, stops: t.stops.map(({ id, ...s }) => s) });
    trip ??= ok ? t : undefined;
  }
  report.trip = runs;
  console.log('TRIP', JSON.stringify(runs, null, 1));
  expect(runs.filter(r => r.ok).length).toBeGreaterThanOrEqual(4);
});

test('recommendations at 13:00 and 17:00 (rain from 16:00)', async () => {
  const r = new Recommender(llm, index, 60_000);
  const t: Trip = trip ?? { startDate: DAY1, days: 3, interests: ['food', 'architecture'], stops: [], description: '' };
  const at = (minute: number): Situation => ({ clock: { date: DAY1, minute }, location: seville.destination.center, locationLabel: 'the old town', visited: [] });
  const out: Record<string, unknown> = {};
  for (const [label, minute] of [['13:00', 13 * 60], ['17:00', 17 * 60]] as const) {
    const t0 = Date.now();
    const recs = await r.refine(t, at(minute));
    out[label] = {
      ms: Date.now() - t0,
      picks: recs.map(x => ({ id: x.placeId, indoor: x.candidate.place.indoor, fromModel: x.fromModel, reason: x.reason })),
    };
  }
  report.recommend = out;
  console.log('RECOMMEND', JSON.stringify(out, null, 1));
  const evening = (out['17:00'] as any).picks as { indoor: boolean; fromModel: boolean; reason: string }[];
  expect(evening.every(p => p.indoor)).toBe(true);
  expect(evening.some(p => p.fromModel)).toBe(true);
});

test('guide: answers from the pack, declines what is not in it', async () => {
  const g = new Guide(llm, index);
  const sit: Situation = { clock: { date: DAY1, minute: 11 * 60 }, location: seville.destination.center, locationLabel: 'the old town', visited: [] };
  const inPack = [
    'What should I know before visiting the Alcazar?',
    'Why does the Giralda have ramps?',
    'Where is Columbus buried?',
    'What should I order at El Rinconcillo?',
  ];
  const offPack = ['Who won the World Cup in 2010?', 'Is it safe to drink tap water?', 'What is the best sushi in Tokyo?'];
  const out = [];
  for (const q of [...inPack, ...offPack]) {
    const t0 = Date.now();
    let first = 0;
    const a = await g.answer(q, sit, trip, () => (first ||= Date.now() - t0));
    out.push({ q, offPack: offPack.includes(q), ms: Date.now() - t0, firstTokenMs: first, text: a.text, places: a.places.map(p => p.id) });
  }
  report.guide = out;
  console.log('GUIDE', JSON.stringify(out, null, 1));
  const declined = (t: string) => t.trim() === NOT_IN_GUIDE || /isn.t in my guide/i.test(t);
  expect(out.filter(o => o.offPack).every(o => declined(o.text))).toBe(true);
  expect(out.filter(o => !o.offPack).filter(o => !declined(o.text)).length).toBeGreaterThanOrEqual(3);
});

test('translation: ten sentences each way, for grading', async () => {
  const tr = new Translator(llm, [], 'en', 'es'); // no phrasebook: test the model itself
  const en = [
    'Could you tell me how to get to the cathedral from here?',
    'Is this table free?',
    'We would like two glasses of red wine, please.',
    'What time does the last bus to the airport leave?',
    'I booked a room for three nights under the name Smith.',
    'Is there a pharmacy open near here at this hour?',
    'Can I pay by card?',
    'My phone has no signal, can I use your wifi?',
    'Which of these tapas do you recommend?',
    'Excuse me, I think there is a mistake in the bill.',
  ];
  const es = [
    'Está a cinco minutos andando, todo recto por esta calle.',
    'Sí, siéntese donde quiera.',
    '¿Quieren algo de comer o solo beber?',
    'El último autobús sale a las once y media.',
    'Lo siento, la cocina cierra a las cuatro.',
    'Hay una farmacia de guardia en la plaza.',
    'Sí, aceptamos tarjeta.',
    'La contraseña está en el ticket.',
    'Le recomiendo las espinacas con garbanzos.',
    'Perdone, ahora mismo se lo corrijo.',
  ];
  const out = [];
  for (const [from, to, list] of [['en', 'es', en], ['es', 'en', es]] as const) {
    for (const s of list) {
      const t0 = Date.now();
      const t = await tr.translate(s, from, to);
      out.push({ from, to, source: s, words: s.split(/\s+/).length, ms: Date.now() - t0, translation: t });
    }
  }
  report.translate = out;
  console.log('TRANSLATE', JSON.stringify(out, null, 1));
  expect(out.every(o => o.translation.length > 0)).toBe(true);
});
