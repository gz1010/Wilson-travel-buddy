import { FixtureLLM } from '../../services/llm/fixtureLLM';
import { seville } from '../../pack/seville';
import { prompts } from '../prompts';
import { SentenceChunker } from '../sentences';
import { conversationLanguages, isLang, LANG_NATIVE, LANGS, SideAssigner, Translator } from '../translate';
import { LANG_NAMES, type Lang } from '../types';

const conversation: { speaker: number; language: Lang; text: string }[] = require('../../fixtures/conversation_es_en.json');

describe('SideAssigner', () => {
  test('the scripted six-turn conversation lands every turn on the right side', () => {
    const a = new SideAssigner('en', 'es');
    const sides = conversation.map(t => a.assign(t.speaker, t.language));
    expect(sides).toEqual(['traveler', 'local', 'traveler', 'local', 'traveler', 'local']);
  });

  test('the detected language wins over a speaker number (voice prints are weak on short sentences)', () => {
    const a = new SideAssigner('en', 'es');
    a.assign(0, 'en');
    // Diarization put the local's Spanish under speaker 0: the language decides.
    expect(a.assign(0, 'es')).toBe('local');
  });

  test('when the language is unknown, the speaker\'s last known side decides', () => {
    const a = new SideAssigner('en', 'es');
    a.assign(0, 'en');
    a.assign(1, 'es');
    expect(a.assign(1, undefined)).toBe('local');
    expect(a.assign(0, undefined)).toBe('traveler');
  });

  test('any language but the home one is the local\'s, not only the destination\'s', () => {
    const a = new SideAssigner('en', 'es');
    a.assign(0, 'en');
    // Speaker 0 is the traveller, but French is never theirs.
    expect(a.assign(0, 'fr')).toBe('local');
    for (const l of LANGS.filter(x => x !== 'en')) expect(a.assign(undefined, l)).toBe('local');
    expect(a.assign(undefined, 'en')).toBe('traveler');
  });

  test('unknown language: a new speaker takes whichever side is free', () => {
    const a = new SideAssigner('en', 'es');
    expect(a.assign(0, undefined)).toBe('traveler');
    expect(a.assign(1, undefined)).toBe('local');
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

describe('the local\'s language', () => {
  test('starts as the destination\'s, then follows what the local is heard speaking', () => {
    const a = new SideAssigner('en', 'es');
    expect([a.localLanguage, a.localSource]).toEqual(['es', 'expected']);
    // The traveller speaks first: English goes into the destination's language for now.
    expect(a.direction('traveler', 'en')).toEqual({ from: 'en', to: 'es' });
    // The local answers in French: that is now their language, both ways.
    const side = a.assign(1, 'fr');
    a.hear(side, 'fr');
    expect([a.localLanguage, a.localSource]).toEqual(['fr', 'detected']);
    expect(a.direction(side, 'fr')).toEqual({ from: 'fr', to: 'en' });
    expect(a.direction('traveler', 'en')).toEqual({ from: 'en', to: 'fr' });
    // Unknown language on the local's side: their language, not the destination's.
    expect(a.direction('local')).toEqual({ from: 'fr', to: 'en' });
    expect(a.direction('traveler')).toEqual({ from: 'en', to: 'fr' });
  });

  test('only the local\'s side changes it, and never to the home language', () => {
    const a = new SideAssigner('en', 'es');
    a.hear('traveler', 'de');
    a.hear('local', 'en');
    a.hear('local', undefined);
    expect([a.localLanguage, a.localSource]).toEqual(['es', 'expected']);
    a.hear('local', 'ja');
    expect(a.localLanguage).toBe('ja');
  });

  test('a pin wins over what is heard, until it is cleared', () => {
    const a = new SideAssigner('en', 'es');
    a.hear('local', 'it');
    a.pinLocal('pt');
    expect([a.localLanguage, a.localSource, a.localPin]).toEqual(['pt', 'pinned', 'pt']);
    a.hear('local', 'fr');
    expect(a.localLanguage).toBe('pt');
    a.pinLocal(undefined);
    // Back to detection: the last language heard while pinned counts.
    expect([a.localLanguage, a.localSource]).toEqual(['fr', 'detected']);
  });

  test('a restart that keeps the turns keeps the language; a fresh one forgets it; pins stay', () => {
    const a = new SideAssigner('en', 'es');
    a.hear('local', 'de');
    a.reset(false);
    expect(a.localLanguage).toBe('de');
    a.reset();
    expect(a.localLanguage).toBe('es');
    a.pinLocal('ko');
    a.reset();
    expect(a.localLanguage).toBe('ko');
  });

  test('the traveller can pick another home language', () => {
    const a = new SideAssigner('en', 'es');
    a.setHome('de');
    expect(a.homeLanguage).toBe('de');
    expect(a.assign(undefined, 'de')).toBe('traveler');
    expect(a.assign(undefined, 'en')).toBe('local');
    expect(a.direction('traveler', 'de')).toEqual({ from: 'de', to: 'es' });
  });

  test('the local\'s language is never the traveller\'s own', () => {
    const a = new SideAssigner('en', 'es');
    // The local was heard in French, then the traveller picks French: the local goes back to the destination's.
    a.hear('local', 'fr');
    a.setHome('fr');
    expect([a.localLanguage, a.localSource]).toEqual(['es', 'expected']);
    // A pin on the language the traveller then picks is dropped.
    a.pinLocal('de');
    a.setHome('de');
    expect([a.localLanguage, a.localPin]).toEqual(['es', undefined]);
    // A traveller who speaks the destination's language: English for the local until they are heard.
    a.setHome('es');
    expect(a.localLanguage).toBe('en');
    expect(a.direction('traveler', 'es')).toEqual({ from: 'es', to: 'en' });
    a.hear('local', 'it');
    expect(a.localLanguage).toBe('it');
  });

  test('push-to-talk: the pressed button decides the direction', () => {
    const a = new SideAssigner('en', 'es');
    expect(a.pressedDirection('traveler', 'en')).toEqual({ from: 'en', to: 'es' });
    expect(a.pressedDirection('local', 'fr')).toEqual({ from: 'fr', to: 'en' });
    // The local spoke, but Argmax heard English (or nothing): their known language.
    expect(a.pressedDirection('local', 'en')).toEqual({ from: 'es', to: 'en' });
    expect(a.pressedDirection('local')).toEqual({ from: 'es', to: 'en' });
  });
});

describe('languages', () => {
  test('the ten the voice speaks, each with its English and its own name', () => {
    expect([...LANGS].sort()).toEqual(['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'ru', 'zh']);
    for (const l of LANGS) {
      expect(LANG_NAMES[l]).toBeTruthy();
      expect(LANG_NATIVE[l]).toBeTruthy();
    }
    expect(LANG_NATIVE.fr).toBe('Français');
  });

  test('isLang accepts only the ten (the helper may send any of Whisper\'s codes)', () => {
    expect(isLang('fr')).toBe(true);
    expect(isLang('ca')).toBe(false);
    expect(isLang('toString')).toBe(false);
    expect(isLang(undefined)).toBe(false);
  });

  test('the conversation listens for all ten, home first, or for home and the pinned one', () => {
    const all = conversationLanguages('en');
    expect(all[0]).toBe('en');
    expect(new Set(all).size).toBe(10);
    expect(conversationLanguages('en', 'fr')).toEqual(['en', 'fr']);
    expect(conversationLanguages('de', 'de')[0]).toBe('de');
    expect(conversationLanguages('de', 'de')).toHaveLength(10);
  });

  test('the translate prompt names both languages for every pair', () => {
    for (const from of LANGS) {
      for (const to of LANGS) {
        if (from !== to) expect(prompts.translate(LANG_NAMES[from], LANG_NAMES[to])).toContain(`from ${LANG_NAMES[from]} to ${LANG_NAMES[to]}`);
      }
    }
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

  test('the phrasebook only answers for its own pair: English to French goes to the model', async () => {
    const { llm, t } = make({ 'translate.en-fr': 'Merci !', 'translate.fr-en': 'Thank you!' });
    expect(await t.translate('Thank you!', 'en', 'fr')).toBe('Merci !');
    expect(await t.translate('Gracias', 'fr', 'en')).toBe('Thank you!');
    expect(llm.calls.map(c => c.req.tag)).toEqual(['translate.en-fr', 'translate.fr-en']);
    expect(llm.calls[0].req.messages[0].content).toContain('from English to French');
  });

  test('any pair of the ten, tagged by direction', async () => {
    const { llm, t } = make({ 'translate.ja-de': 'Wo ist der Bahnhof?' });
    expect(await t.translate('駅はどこですか', 'ja', 'de')).toBe('Wo ist der Bahnhof?');
    expect(llm.calls[0].req.tag).toBe('translate.ja-de');
    expect(llm.calls[0].req.messages[0].content).toContain('from Japanese to German');
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
