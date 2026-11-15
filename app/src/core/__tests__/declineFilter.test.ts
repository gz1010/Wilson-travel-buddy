import { DeclineFilter } from '../guide';
import { NOT_IN_GUIDE } from '../prompts';

const words = (s: string) => s.match(/\S+\s*/g) ?? [];
const run = (tokens: string[]) => {
  const shown: string[] = [];
  const f = new DeclineFilter(t => shown.push(t));
  tokens.forEach(t => f.push(t));
  const text = f.end();
  return { text, shown: shown.join('') };
};

describe('DeclineFilter', () => {
  test('drops a refusal tacked onto an answer (seen live from Bonsai-2 4B)', () => {
    const live = `Columbus is buried in the Cathedral. This is located near the old town where you are staying. ${NOT_IN_GUIDE}`;
    const { text, shown } = run(words(live));
    expect(text).toBe('Columbus is buried in the Cathedral. This is located near the old town where you are staying.');
    expect(shown).toBe(text);
  });

  test('talk about the sources becomes the refusal (seen live: "No, the sources do not mention…")', () => {
    const { text } = run(words(`No, the sources do not mention drinking tap water safety. ${NOT_IN_GUIDE}`));
    expect(text).toBe(NOT_IN_GUIDE);
  });

  test('a refusal on its own passes through', () => {
    expect(run(words(NOT_IN_GUIDE))).toEqual({ text: NOT_IN_GUIDE, shown: NOT_IN_GUIDE });
  });

  test('ordinary answers come through whole, including "That…" sentences and a guidebook mention', () => {
    const answer = 'That tower is the Giralda. A guided tour is worth it! Go early.';
    expect(run(words(answer)).text).toBe(answer);
  });

  test('each sentence is released as soon as it ends', () => {
    const shown: string[] = [];
    const f = new DeclineFilter(t => shown.push(t));
    f.push('The Giralda ');
    expect(shown).toEqual([]);
    f.push('has ramps. ');
    expect(shown).toEqual(['The Giralda has ramps.']);
    f.push('Go early');
    expect(f.end()).toBe('The Giralda has ramps. Go early');
    expect(shown).toEqual(['The Giralda has ramps.', ' Go early']);
  });

  test('keeps "3.5 km" whole and an empty stream ends as the refusal', () => {
    expect(run(['It is 3.5 km away. ']).text).toBe('It is 3.5 km away.');
    expect(run([]).text).toBe(NOT_IN_GUIDE);
  });
});
