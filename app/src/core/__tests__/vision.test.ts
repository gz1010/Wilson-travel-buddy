import { seville } from '../../pack/seville';
import { buildBody, wireMessage } from '../../services/llm/llamaClient';
import { FixtureLLM } from '../../services/llm/fixtureLLM';
import { PackIndex } from '../pack';
import type { ChatRequest, LLMClient } from '../types';
import { LOOK_MAX_TOKENS, Looker, NO_VISION, plainText } from '../vision';

const index = new PackIndex(seville);
const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U'; // a base64 JPEG header
const lookerWith = (answer: string) => {
  const llm = new FixtureLLM({ look: answer }, 0);
  return { llm, looker: new Looker(llm, index) };
};

describe('Looker.describe', () => {
  test('sends the photo with the question, under the look prompt', async () => {
    const { llm, looker } = lookerWith('This is a No Parking sign.');
    await looker.describe(JPEG, '  Can I park here? ', () => {});
    expect(llm.calls).toHaveLength(1);
    const { req } = llm.calls[0];
    expect(req.tag).toBe('look');
    expect(req.maxTokens).toBe(LOOK_MAX_TOKENS);
    expect(LOOK_MAX_TOKENS).toBeLessThanOrEqual(240);
    const [system, user] = req.messages;
    expect(system.role).toBe('system');
    expect(system.images).toBeUndefined();
    expect(user).toEqual({ role: 'user', content: 'Can I park here?', images: [JPEG] });
  });

  test('without a question it asks what the photo shows', async () => {
    const { llm, looker } = lookerWith('A plate of fried fish.');
    await looker.describe(JPEG, undefined, () => {});
    expect(llm.calls[0].req.messages[1]).toEqual({ role: 'user', content: 'What am I looking at?', images: [JPEG] });
  });

  test('the prompt names the city, the rules and the recognisable guide places', async () => {
    const { llm, looker } = lookerWith('A sign.');
    await looker.describe(JPEG, undefined, () => {});
    const system = llm.calls[0].req.messages[0].content;
    expect(system).toContain(index.destination.name);
    for (const words of ['dish', 'sign', 'road marking', 'building', 'menu', 'Translate', 'English', 'tip', 'At most 4 short sentences']) {
      expect(system).toContain(words);
    }
    const names = looker.placeNames();
    expect(names).toContain(index.place('plaza-espana')!.name);
    expect(names).toContain(index.place('catedral')!.name);
    // A bar looks like any other bar: never offered to the model as a match.
    expect(names).not.toContain(index.place('las-teresas')!.name);
    for (const n of names) expect(system).toContain(n);
  });

  test("the prompt lists the pack's local dishes, and leaves the line out without them", async () => {
    const { llm, looker } = lookerWith('Salmorejo.');
    await looker.describe(JPEG, undefined, () => {});
    const system = llm.calls[0].req.messages[0].content;
    const dishes = index.destination.dishes ?? [];
    expect(dishes.some(d => d.startsWith('salmorejo'))).toBe(true);
    for (const d of dishes) expect(system).toContain(d);
    expect(system).toContain('not another place to go');

    const bare = new PackIndex({ ...seville, destination: { ...seville.destination, dishes: undefined } });
    const llm2 = new FixtureLLM({ look: 'A sign.' }, 0);
    await new Looker(llm2, bare).describe(JPEG, undefined, () => {});
    expect(llm2.calls[0].req.messages[0].content).not.toContain('Dishes often eaten here');
  });

  test('streams tokens as they come and returns the whole answer', async () => {
    const answer = 'This is a No Parking sign. It means you cannot park here except to load and unload from 8 to 11.';
    const { looker } = lookerWith(answer);
    const tokens: string[] = [];
    const result = await looker.describe(JPEG, undefined, t => tokens.push(t));
    expect(tokens.length).toBeGreaterThan(5);
    expect(tokens.join('')).toBe(answer);
    expect(result.text).toBe(answer);
    expect(result.place).toBeUndefined();
  });

  test('a guide place named in the answer is returned for the screen', async () => {
    const { looker } = lookerWith('It is the Plaza de España, built for the 1929 fair. Go early for the light.');
    const result = await looker.describe(JPEG, undefined, () => {});
    expect(result.place?.id).toBe('plaza-espana');
  });

  test('a restaurant whose name the model read on its sign is matched too', async () => {
    // What Bonsai-2 4B said about the pack's freiduria photo.
    const { looker } = lookerWith('You are looking at a colorful tile mural. The text reads "FREIDURIA PUERTA DE LA CARNE" and "Fundada en 1976".');
    const result = await looker.describe(JPEG, undefined, () => {});
    expect(result.place?.id).toBe('freiduria-puerta-carne');
  });

  test('markdown in the answer is dropped', async () => {
    const { looker } = lookerWith('**Espinacas con garbanzos**\n\n- Spinach with chickpeas.\n- A classic tapa.');
    const result = await looker.describe(JPEG, undefined, () => {});
    expect(result.text).toBe('Espinacas con garbanzos Spinach with chickpeas. A classic tapa.');
  });

  test('a server without the vision projector gets a clear message', async () => {
    const noVision: LLMClient = {
      name: 'Bonsai-2 4B',
      stream: () => Promise.reject(new Error('llama-server 500: {"error":{"message":"image input is not supported - hint: if this is unexpected, you may need to provide the mmproj"}}')),
      json: () => Promise.reject(new Error('unused')),
    };
    await expect(new Looker(noVision, index).describe(JPEG, undefined, () => {})).rejects.toThrow(NO_VISION);
  });

  test('other errors pass through unchanged', async () => {
    const down: LLMClient = {
      name: 'Bonsai-2 4B',
      stream: () => Promise.reject(new Error('Cannot reach llama-server on 127.0.0.1:8080')),
      json: () => Promise.reject(new Error('unused')),
    };
    await expect(new Looker(down, index).describe(JPEG, undefined, () => {})).rejects.toThrow('Cannot reach llama-server');
  });
});

describe('plainText', () => {
  test('keeps plain sentences as they are', () => {
    expect(plainText(' This is a sign.  It says "Exit". ')).toBe('This is a sign. It says "Exit".');
  });
  test('drops italics (Bonsai-2 wrote "*azulejos*")', () => {
    expect(plainText('A classic example of Seville tiles known as *azulejos*.')).toBe('A classic example of Seville tiles known as azulejos.');
  });
  test('drops headings and joins lines', () => {
    expect(plainText('## Menu\nTortilla: potato omelette.\nSalmorejo: cold tomato soup.')).toBe('Menu Tortilla: potato omelette. Salmorejo: cold tomato soup.');
  });
});

describe('LlamaClient image content', () => {
  const req = (images?: string[]): ChatRequest => ({
    tag: 'look',
    messages: [
      { role: 'system', content: 'You are Travel Buddy.' },
      { role: 'user', content: 'What is this?', ...(images ? { images } : {}) },
    ],
  });

  test('a message with images becomes text and image_url parts with a JPEG data URI', () => {
    const body = buildBody(req([JPEG]));
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are Travel Buddy.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${JPEG}` } },
        ],
      },
    ]);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  test('messages without images stay plain strings', () => {
    expect(buildBody(req()).messages).toEqual(req().messages);
    expect(wireMessage({ role: 'user', content: 'Hi', images: [] })).toEqual({ role: 'user', content: 'Hi' });
  });

  test('a data URI is passed as it is', () => {
    const uri = `data:image/png;base64,${JPEG}`;
    expect(wireMessage({ role: 'user', content: 'x', images: [uri] }).content).toEqual([
      { type: 'text', text: 'x' },
      { type: 'image_url', image_url: { url: uri } },
    ]);
  });
});
