import type { FixtureAnswer } from '../services/llm/fixtureLLM';

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

export const llmAnswers: Record<string, FixtureAnswer> = {
  // The spec sentence. The model counted Tuesday as day 2; the weekday field
  // lets code put it on day 3, as the real app does.
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
  guide:
    "The Giralda was originally a minaret before it became the Cathedral's tower. Inside there are 35 ramps instead of stairs for riders on horseback to climb.",
  'translate.en-es': '¿Podrías decirme cómo llegar a la catedral desde aquí?',
  'translate.es-en': "It's five minutes away, walking straight down this street.",
  'translate*': '(translation)',
};
