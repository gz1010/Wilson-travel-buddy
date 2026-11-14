import type { ChatRequest, JSONSchema, LLMClient } from '../../core/types';

export type FixtureAnswer = string | ((req: ChatRequest, schema?: JSONSchema) => string);

/**
 * Recorded answers, used when no llama-server is running (B's machine, or
 * tests). Keyed by ChatRequest.tag; a tag ending in "*" matches a prefix.
 * Answers for JSON requests must be JSON text.
 */
export class FixtureLLM implements LLMClient {
  name = 'Recorded answers (no model running)';
  readonly calls: { req: ChatRequest; schema?: JSONSchema }[] = [];

  constructor(private answers: Record<string, FixtureAnswer>, private delayMs = 15) {}

  private answer(req: ChatRequest, schema?: JSONSchema): string {
    this.calls.push({ req, schema });
    const key =
      req.tag in this.answers
        ? req.tag
        : Object.keys(this.answers).find(k => k.endsWith('*') && req.tag.startsWith(k.slice(0, -1)));
    if (!key) throw new Error(`No recorded answer for "${req.tag}"`);
    const a = this.answers[key];
    return typeof a === 'function' ? a(req, schema) : a;
  }

  async stream(req: ChatRequest, onToken: (t: string) => void): Promise<string> {
    const text = this.answer(req);
    for (const word of text.match(/\S+\s*/g) ?? []) {
      if (this.delayMs) await new Promise<void>(r => setTimeout(r, this.delayMs));
      onToken(word);
    }
    return text;
  }

  async json<T>(req: ChatRequest, schema: JSONSchema): Promise<T> {
    return JSON.parse(this.answer(req, schema)) as T;
  }
}
