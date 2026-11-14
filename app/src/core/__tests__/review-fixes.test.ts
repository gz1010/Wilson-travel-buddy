import { seville } from '../../pack/seville';
import { FixtureLLM } from '../../services/llm/fixtureLLM';
import { routeIntent } from '../intent';
import { PackIndex } from '../pack';
import { Recommender } from '../recommend';
import { scoreCandidates } from '../scoring';
import { SideAssigner } from '../translate';
import type { Situation } from '../types';

const index = new PackIndex(seville);

describe('fixes from the code review', () => {
  it.each([
    ["What's near my hotel?", false, 'guide'],
    ['Tell me about the Cathedral', false, 'guide'],
    ['What is there to see in three days?', true, 'guide'],
    ["Actually I'm here four days", true, 'trip.edit'],
    ["I'm here three days, staying near the old town, I love street food and architecture, Tuesday afternoon I have a museum ticket", false, 'trip.setup'],
  ])('routes "%s"', (text, hasTrip, intent) => {
    expect(routeIntent(text, hasTrip)).toBe(intent);
  });

  it('resolves "the old town" to Santa Cruz, not a park that mentions it', () => {
    expect(index.findPlace('the old town')?.id).toBe('santa-cruz');
  });

  it('does not guess a place from a vague phrase', () => {
    expect(index.findPlace('museum ticket')).toBeUndefined();
  });

  it('puts sentences on the side of their language, even when voice prints disagree', () => {
    const s = new SideAssigner('en', 'es');
    expect(s.assign(0, 'en')).toBe('traveler');
    expect(s.assign(0, 'es')).toBe('local'); // both voices landed on speaker 0
    expect(s.assign(1, undefined)).toBe('traveler'); // unknown language, new speaker: takes the free side
  });
  it('uses the speaker number when the language is unclear', () => {
    const s = new SideAssigner('en', 'es');
    expect(s.assign(1, 'es')).toBe('local');
    expect(s.assign(1, 'fr')).toBe('local');
  });

  it('shares one model call between identical recommendation requests', async () => {
    const llm = new FixtureLLM({ recommend: (_r, schema: any) => JSON.stringify({ picks: [{ place_id: schema.properties.picks.items.properties.place_id.enum[0], reason: 'ok' }] }) }, 0);
    const r = new Recommender(llm, index);
    const sit: Situation = { clock: { date: '2026-11-15', minute: 12 * 60 }, location: seville.destination.center, locationLabel: 'x', visited: [] };
    const [a, b] = await Promise.all([r.refine(undefined, sit), r.refine(undefined, { ...sit })]);
    expect(llm.calls.length).toBe(1);
    expect(a).toBe(b);
  });

  it('treats the hours before sunrise as dark for outdoor places', () => {
    const sit: Situation = { clock: { date: '2026-11-16', minute: 0 }, location: index.place('santa-cruz')!.point, locationLabel: 'x', visited: [] };
    const top = scoreCandidates(index, undefined, sit, { limit: 50 });
    const garden = top.find(c => c.place.id === 'jardines-murillo');
    expect(garden?.notes).toContain('after dark');
  });
});
