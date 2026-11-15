import { ThinkFilter } from '../llamaClient';

const run = (tokens: string[]) => {
  const f = new ThinkFilter();
  return tokens.map(t => f.push(t)).join('');
};

describe('ThinkFilter', () => {
  test('drops the empty think block Bonsai-2 opens with, as it streams in pieces', () => {
    expect(run(['<think>', '\n\n', '</think>', '\n\n', 'Hola', ', ¿qué tal?'])).toBe('Hola, ¿qué tal?');
    expect(run(['<th', 'ink>\n\n</th', 'ink>\n\n{"city"', ': "Seville"}'])).toBe('{"city": "Seville"}');
  });

  test('drops a non-empty think block too', () => {
    expect(run(['<think>let me see</think>', 'Answer.'])).toBe('Answer.');
  });

  test('passes ordinary replies through untouched, including later mentions of <think>', () => {
    expect(run(['The ', 'Giralda.'])).toBe('The Giralda.');
    expect(run(['<b>', 'bold'])).toBe('<b>bold');
    expect(run(['Use ', '<think>', ' tags'])).toBe('Use <think> tags');
  });

  test('the first visible token arrives with the reply, not with the tags', () => {
    const f = new ThinkFilter();
    expect(f.push('<think>')).toBe('');
    expect(f.push('\n\n</think>\n\n')).toBe('');
    expect(f.push('Sí')).toBe('Sí');
    expect(f.push('.')).toBe('.');
  });
});
