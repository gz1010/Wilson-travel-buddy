/**
 * What the home's input does with what was typed (CityCard's readHomeInput): a prepared city opens,
 * a city Wilson knows of by name is one to learn, a question goes to Wilson, a wish gets the note.
 */
import { PackIndex } from '../../../core/pack';
import { seville } from '../../../pack/seville';
import type { KnownCity } from '../../screens/types';
import { cityFromPack, readHomeInput } from '../CityCard';

jest.mock('react-native-webview', () => {
  const { View } = require('react-native');
  return { WebView: View, default: View };
});

const index = new PackIndex(seville);
const cities: KnownCity[] = [cityFromPack(index, { preparedAt: '2026-11-15T01:10:11-05:00', photos: 51, heroes: 4 }, { localName: 'Sevilla', aliases: ['Sevilla', 'Séville'] })];

it('opens a prepared city, by any of its names or in a short phrase', () => {
  for (const t of ['sevilla', 'Seville, Spain', 'trip to Seville', 'Take me to Seville please', '  Séville ']) {
    expect(readHomeInput(t, cities)).toMatchObject({ kind: 'city', city: { id: 'seville' } });
  }
});

it('takes a city Wilson knows of as one to learn, also inside a sentence', () => {
  expect(readHomeInput('paris', cities)).toEqual({ kind: 'learn', name: 'Paris' });
  expect(readHomeInput("xi'an", cities)).toEqual({ kind: 'learn', name: "Xi'an" });
  expect(readHomeInput("I'd love to see Lisbon next spring", cities)).toEqual({ kind: 'learn', name: 'Lisbon' });
  expect(readHomeInput('lyon', cities)).toEqual({ kind: 'learn', name: 'Lyon' });
  expect(readHomeInput('San Sebastián', cities)).toEqual({ kind: 'learn', name: 'San Sebastián' });
});

it('hands a question or a sentence to Wilson instead of taking it for a city', () => {
  for (const t of [
    'Tell me the story of the Seville Cathedral',
    'Why is the Giralda called that?',
    "what's open tonight",
    'Is the Alcázar worth it',
    'the best tapas near the river for dinner tonight',
  ]) {
    expect(readHomeInput(t, cities)).toEqual({ kind: 'ask', text: t });
  }
});

it('reads a wish as a wish, and nothing as nothing', () => {
  expect(readHomeInput('somewhere warm', cities)).toEqual({ kind: 'vague' });
  expect(readHomeInput('Anywhere sunny', cities)).toEqual({ kind: 'vague' });
  expect(readHomeInput('   ', cities)).toBeUndefined();
});
