import { LevelFeed, isDismissal, parseWake, withoutName } from '../wake';

// The same cases as WakeWord.cases in audio-helper/Sources/BuddyAudio/Wake.swift
// (`BuddyAudio --wake-selftest` runs those): the helper and the app read the name alike.
const CASES: [string, string | undefined][] = [
  ['Wilson, where is the cathedral?', 'Where is the cathedral?'],
  ['Hey Wilson, where is the cathedral?', 'Where is the cathedral?'],
  ["Hi, Wilson. What's open now?", "What's open now?"],
  ['Hey, Wilson!', ''],
  ['Wilson.', ''],
  ['wilson', ''],
  ['Willson, is it going to rain?', 'Is it going to rain?'],
  ['Wilsen, tell me about the Alcázar.', 'Tell me about the Alcázar.'],
  ['Will son, what time is it?', 'What time is it?'],
  ['WILSON — find me lunch', 'Find me lunch'],
  ['Wilsón, ¿qué hora es?', 'Qué hora es?'],
  ["Okay so Wilson, what's next?", "What's next?"],
  ["Wilson's going to help", 'Going to help'],
  ['Where is the cathedral?', undefined],
  ['I told Wilson about it.', undefined],
  ['Nelson, where is it?', undefined],
  ['Will someone help me?', undefined],
  ['Willow trees are nice.', undefined],
  ['Thank you.', undefined],
  ['', undefined],
  ['Hey hey hey Wilson', undefined],
];

describe('parseWake', () => {
  it.each(CASES)('%j -> %j', (input, expected) => {
    expect(parseWake(input)).toBe(expected);
  });

  it('withoutName drops a leading name and keeps any other question as it was', () => {
    expect(withoutName('Wilson, where is lunch?')).toBe('Where is lunch?');
    expect(withoutName('  where is lunch?  ')).toBe('where is lunch?');
    expect(withoutName('Hey Wilson')).toBe('');
  });
});

describe('isDismissal', () => {
  it.each([
    'Thanks, Wilson.',
    'Thank you so much!',
    'Thanks for the help, Wilson',
    "That's all.",
    "OK, that's all for now.",
    "No, that's it.",
    'No thanks.',
    'Nothing else.',
    'Never mind.',
    'Bye!',
    'Okay.',
    'Perfect, thanks.',
    'Gracias.',
  ])('%j ends the exchange', text => {
    expect(isDismissal(text)).toBe(true);
  });

  it.each([
    'Thanks, and where can I eat?',
    'No, what about lunch?',
    'Is the cathedral open?',
    "What's all this about?",
    'Wilson',
    '',
    'Stop by the market on the way?',
  ])('%j does not', text => {
    expect(isDismissal(text)).toBe(false);
  });
});

describe('LevelFeed', () => {
  it('pushes clamped levels to subscribers until they unsubscribe, skipping repeats', () => {
    const feed = new LevelFeed();
    const seen: string[] = [];
    const off = feed.subscribe(l => seen.push(`${l.mic}/${l.voice}`));
    feed.push('mic', 0.5);
    feed.push('mic', 0.5);
    feed.push('voice', 3);
    feed.push('voice', Number.NaN);
    off();
    feed.push('mic', 0.2);
    expect(seen).toEqual(['0.5/0', '0.5/1', '0.5/0']);
    expect(feed.get()).toEqual({ mic: 0.2, voice: 0 });
  });

  it('keeps going when a subscriber throws', () => {
    const feed = new LevelFeed();
    const got: number[] = [];
    feed.subscribe(() => {
      throw new Error('boom');
    });
    feed.subscribe(l => got.push(l.voice));
    feed.push('voice', 0.4);
    expect(got).toEqual([0.4]);
  });
});
