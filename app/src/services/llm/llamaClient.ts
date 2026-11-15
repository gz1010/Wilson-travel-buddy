import type { ChatMessage, ChatRequest, JSONSchema, LLMClient } from '../../core/types';
import { SSEParser } from './sse';

/**
 * Bonsai-2 through PrismML's llama-server (OpenAI-compatible API) on
 * 127.0.0.1. Streaming uses XMLHttpRequest, because React Native's fetch
 * cannot read a response body as it arrives.
 */
export class LlamaClient implements LLMClient {
  name = 'Bonsai-2';

  constructor(readonly baseUrl = 'http://127.0.0.1:8080') {}

  /** Checks the server is up and the model loaded; reads the model file name for the badge. */
  async connect(timeoutMs = 1500): Promise<boolean> {
    try {
      const health = await fetchWithTimeout(`${this.baseUrl}/health`, timeoutMs);
      if (!health.ok) return false;
      const models = await fetchWithTimeout(`${this.baseUrl}/v1/models`, timeoutMs);
      const json = await models.json();
      const id: string | undefined = json?.data?.[0]?.id;
      if (id) this.name = prettyModelName(id);
      return true;
    } catch {
      return false;
    }
  }

  stream(req: ChatRequest, onToken: (t: string) => void): Promise<string> {
    return this.post(req, undefined, onToken);
  }

  async json<T>(req: ChatRequest, schema: JSONSchema): Promise<T> {
    const text = await this.post(req, schema, () => {});
    try {
      return JSON.parse(text) as T;
    } catch {
      // Grammar-constrained output should always parse; if it was cut off by max tokens, say so.
      throw new Error(`Model returned invalid JSON (${text.length} chars). Raise maxTokens for "${req.tag}".`);
    }
  }

  private post(req: ChatRequest, schema: JSONSchema | undefined, onToken: (t: string) => void): Promise<string> {
    const body = buildBody(req, schema);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const parser = new SSEParser();
      const think = new ThinkFilter();
      let text = '';
      const read = () => {
        try {
          for (const raw of parser.feed(xhr.responseText)) {
            const delta = think.push(raw);
            if (!delta) continue;
            text += delta;
            onToken(delta);
          }
        } catch (e) {
          xhr.abort();
          reject(e);
        }
      };
      xhr.open('POST', `${this.baseUrl}/v1/chat/completions`);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onprogress = read;
      xhr.onload = () => {
        read();
        if (xhr.status >= 200 && xhr.status < 300) resolve(text);
        else reject(new Error(`llama-server ${xhr.status}: ${xhr.responseText.slice(0, 200)}`));
      };
      xhr.onerror = () => reject(new Error('Cannot reach llama-server on 127.0.0.1:8080'));
      xhr.ontimeout = () => reject(new Error('llama-server timed out'));
      xhr.timeout = 60_000;
      xhr.send(JSON.stringify(body));
    });
  }
}

/** The request body. Exported for tests. Thinking is always off: it multiplies latency. */
export function buildBody(req: ChatRequest, schema?: JSONSchema): Record<string, unknown> {
  return {
    model: 'bonsai',
    messages: req.messages.map(wireMessage),
    stream: true,
    max_tokens: req.maxTokens ?? 300,
    // Bonsai-2 small-model profile with thinking off (PrismML's SMALL-MODELS.md).
    temperature: req.temperature ?? 0.7,
    top_p: 0.8,
    top_k: 20,
    min_p: 0,
    presence_penalty: schema ? 0 : 1.5,
    chat_template_kwargs: { enable_thinking: false },
    ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: req.tag.replace(/\W/g, '_'), schema, strict: true } } } : {}),
  };
}

/**
 * A message as llama-server takes it. With images, the content becomes OpenAI-style parts (the
 * text, then each image as a data URI), which Bonsai-2 4B reads through its vision projector
 * (--mmproj). Without images it stays a plain string, exactly as before.
 */
export function wireMessage(m: ChatMessage): Record<string, unknown> {
  if (!m.images?.length) return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: [
      { type: 'text', text: m.content },
      ...m.images.map(jpeg => ({ type: 'image_url', image_url: { url: jpeg.startsWith('data:') ? jpeg : `data:image/jpeg;base64,${jpeg}` } })),
    ],
  };
}

/**
 * Drops a leading "<think>…</think>" block from a stream. With thinking off,
 * Bonsai-2's template still opens the reply with an empty one, and a server
 * started with --reasoning-format none passes it through as text, where it
 * would be shown and spoken. PrismML's Bonsai-2 launcher does not use that
 * flag; this guards against any server that does.
 */
export class ThinkFilter {
  private pending = '';
  private passing = false;

  push(delta: string): string {
    if (this.passing) return delta;
    this.pending += delta;
    const s = this.pending.trimStart();
    if (s.startsWith('<think>')) {
      const end = s.indexOf('</think>');
      if (end < 0) return ''; // still inside the block
      const rest = s.slice(end + '</think>'.length).trimStart();
      if (!rest) return ''; // the reply proper has not started yet
      this.passing = true;
      return rest;
    }
    if ('<think>'.startsWith(s)) return ''; // could still become "<think>"
    this.passing = true;
    return this.pending;
  }
}

export function prettyModelName(id: string): string {
  const m = /(\d+(?:\.\d+)?B)/i.exec(id);
  return m ? `Bonsai-2 ${m[1].toUpperCase()}` : 'Bonsai-2';
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}
