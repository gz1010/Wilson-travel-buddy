import type { FixtureAnswer } from '../services/llm/fixtureLLM';

// Recorded model answers for the dev app when no llama-server is running.
// Replace these with real Bonsai-2 output once A has the model running, so
// the UI is built against realistic text.

export const llmAnswers: Record<string, FixtureAnswer> = {
  'trip.extract': JSON.stringify({
    days: 3,
    base_area: 'Santa Cruz',
    interests: ['food', 'tapas', 'architecture'],
    stops: [
      { title: 'Museum of Fine Arts visit', place_name: 'Museum of Fine Arts', day: 3, start: '15:00', duration_minutes: 90, fixed: true },
    ],
  }),
  'trip.revise': (req) => {
    // Echo the current trip back unchanged; the real model applies the edit.
    const m = /Current trip:\n(.*)\n\nChange:/s.exec(req.messages[1].content);
    return m ? m[1] : '{"days":1,"base_area":null,"interests":[],"stops":[]}';
  },
  recommend: (_req, schema) => {
    // Pick the first three allowed IDs, as a model would.
    const ids: string[] = ((schema as any)?.properties?.picks?.items?.properties?.place_id?.enum ?? []).slice(0, 3);
    return JSON.stringify({
      picks: ids.map(id => ({ place_id: id, reason: 'A recorded answer: run llama-server for real reasons.' })),
    });
  },
  guide: 'The Giralda was a minaret before it became the bell tower of Seville Cathedral. You climb it by ramps, not stairs.',
  'translate.en-es': '¿Dónde está la catedral?',
  'translate.es-en': 'It is five minutes from here, straight ahead.',
  'translate*': '(translation)',
};
