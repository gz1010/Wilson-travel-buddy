import { seville } from '../../pack/seville';
import { FixtureLLM } from '../../services/llm/fixtureLLM';
import { buildBody } from '../../services/llm/llamaClient';
import { PackIndex } from '../pack';
import { Looker } from '../vision';

const index = new PackIndex(seville);
const JPEG = '/9j/4AAQSkZJRgABAQ'; // the start of a JPEG, base64

describe('Looker', () => {
  it('sends the photo with the question and streams the answer', async () => {
    const llm = new FixtureLLM({ look: 'This is a menu. "Espinacas con garbanzos" is spinach with chickpeas. Ask for a half portion to try more.' }, 0);
    const tokens: string[] = [];
    const out = await new Looker(llm, index).describe(JPEG, 'What is this dish?', t => tokens.push(t));
    expect(tokens.join('')).toContain('spinach with chickpeas');
    expect(out.place).toBeUndefined();
    const { req } = llm.calls[0];
    expect(req.tag).toBe('look');
    expect(req.maxTokens).toBe(220);
    const user = req.messages.find(m => m.role === 'user')!;
    expect(user.content).toBe('What is this dish?');
    expect(user.images).toEqual([JPEG]);
    // The system prompt names the city and offers nearby pack places.
    expect(req.messages[0].content).toContain('Seville');
    expect(req.messages[0].content).toContain('Seville Cathedral');
  });

  it('asks a default question when none was asked', async () => {
    const llm = new FixtureLLM({ look: 'A street sign.' }, 0);
    await new Looker(llm, index).describe(JPEG, '  ', () => {});
    expect(llm.calls[0].req.messages[1].content).toBe('What am I looking at?');
  });

  it('names the pack place the answer is about, decided in code', async () => {
    const llm = new FixtureLLM({ look: 'That is the Torre del Oro, a 13th-century watchtower by the river.' }, 0);
    const out = await new Looker(llm, index).describe(JPEG, undefined, () => {});
    expect(out.place?.id).toBe('torre-oro');
  });

  it('offers the places nearest to the traveller', async () => {
    const llm = new FixtureLLM({ look: 'A tower.' }, 0);
    const torre = index.place('torre-oro')!;
    await new Looker(llm, index).describe(JPEG, undefined, () => {}, torre.point);
    expect(llm.calls[0].req.messages[0].content).toContain('Torre del Oro');
  });
});

describe('llama-server request with images', () => {
  it('turns images into OpenAI-style content parts with data URIs', () => {
    const body = buildBody({ tag: 'look', messages: [{ role: 'user', content: 'What is it?', images: [JPEG, 'data:image/jpeg;base64,AAA'] }] });
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is it?' },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${JPEG}` } },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } },
        ],
      },
    ]);
  });

  it('leaves text-only messages as plain strings', () => {
    const body = buildBody({ tag: 'guide', messages: [{ role: 'user', content: 'Hi' }] });
    expect(body.messages).toEqual([{ role: 'user', content: 'Hi' }]);
  });
});
