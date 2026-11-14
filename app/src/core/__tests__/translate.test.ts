import { FixtureLLM } from '../../services/llm/fixtureLLM';
import { seville } from '../../pack/seville';
import { SentenceChunker } from '../sentences';
import { SideAssigner, Translator } from '../translate';
import type { Lang } from '../types';

const conversation: { speaker: number; language: Lang; text: string }[] = require('../../fixtures/conversation_es_en.json');

describe('SideAssigner', () => {
  test('the scripted six-turn conversation lands every turn on the right side', () => {
    const a = new SideAssigner('en', 'es');
    const sides = conversation.map(t => a.assign(t.speaker, t.language));
    expect(sides).toEqual(['traveler', 'local', 'traveler', 'local', 'traveler', 'local']);
  });

  test('a speaker keeps their side even when language detection slips', () => {
    const a = new SideAssigner('en', 'es');
    a.assign(0, 'en');
    a.assign(1, 'es');
    // The local says "OK" and it is detected as English: still the local.
    expect(a.assign(1, 'en')).toBe('local');
  });

  test('unknown language: a new speaker takes whichever side is free', () => {
    const a = new SideAssigner('en', 'es');
    expect(a.assign(0, undefined)).toBe('traveler');
    expect(a.assign(1, 'fr')).toBe('local');
  });

  test('without speaker numbers (push-to-talk), the language decides', () => {
    const a = new SideAssigner('en', 'es');
    expect(a.assign(undefined, 'es')).toBe('local');
    expect(a.assign(undefined, 'en')).toBe('traveler');
    expect(a.assign(undefined, undefined)).toBe('traveler');
  });

  test('direction follows the detected language, else the side', () => {
    const a = new SideAssigner('en', 'es');
    expect(a.direction('traveler', 'es')).toEqual({ from: 'es', to: 'en' });
    expect(a.direction('local', 'en')).toEqual({ from: 'en', to: 'es' });
    expect(a.direction('local')).toEqual({ from: 'es', to: 'en' });
    expect(a.direction('traveler')).toEqual({ from: 'en', to: 'es' });
  });

  test('reset forgets speakers', () => {
    const a = new SideAssigner('en', 'es');
    a.assign(0, 'es');
    a.reset();
    expect(a.assign(0, 'en')).toBe('traveler');
  });
});

describe('Translator', () => {
  const make = (answers = {}) => {
    const llm = new FixtureLLM(answers, 0);
    return { llm, t: new Translator(llm, seville.phrases, 'en', 'es') };
  };

  test('exact phrasebook matches skip the model, both ways, ignoring case, accents and punctuation', async () => {
    const { llm, t } = make();
    expect(await t.translate('thank you!', 'en', 'es')).toBe('Gracias');
    expect(await t.translate('¡GRACIAS!', 'es', 'en')).toBe('Thank you');
    expect(llm.calls).toHaveLength(0);
  });

  test('everything else goes to the model, tagged by direction, with quotes stripped', async () => {
    const { llm, t } = make({ 'translate.en-es': '"¿Cuánto tarda andando a la Giralda?"' });
    const tokens: string[] = [];
    expect(await t.translate('How long is the walk to the Giralda?', 'en', 'es', x => tokens.push(x))).toBe('¿Cuánto tarda andando a la Giralda?');
    expect(llm.calls[0].req.tag).toBe('translate.en-es');
    expect(llm.calls[0].req.messages[0].content).toContain('from English to Spanish');
    expect(tokens.length).toBeGreaterThan(0);
  });

  test('same language is returned as is', async () => {
    const { llm, t } = make();
    expect(await t.translate('Hola', 'es', 'es')).toBe('Hola');
    expect(llm.calls).toHaveLength(0);
  });
});

describe('SentenceChunker', () => {
  const feed = (tokens: string[]) => {
    const c = new SentenceChunker();
    const out = tokens.flatMap(t => c.push(t));
    return [...out, ...c.flush()];
  };

  test('hands out each sentence as soon as the next one starts', () => {
    const c = new SentenceChunker();
    expect(c.push('The Giralda was ')).toEqual([]);
    expect(c.push('a minaret. You ')).toEqual(['The Giralda was a minaret.']);
    expect(c.push('climb it by ramps!')).toEqual([]);
    expect(c.flush()).toEqual(['You climb it by ramps!']);
  });

  test('does not split decimal numbers', () => {
    expect(feed(['It is ', '3.5 km away. ', 'Take water.'])).toEqual(['It is 3.5 km away.', 'Take water.']);
  });

  test('handles question marks, ellipses and Spanish punctuation', () => {
    expect(feed(['¿Está abierto? ', 'Sí… ', 'hasta las cinco.'])).toEqual(['¿Está abierto?', 'Sí…', 'hasta las cinco.']);
  });

  test('flush on an empty stream gives nothing', () => {
    expect(new SentenceChunker().flush()).toEqual([]);
  });
});
