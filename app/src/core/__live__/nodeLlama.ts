import { buildBody, ThinkFilter } from '../../services/llm/llamaClient';
import type { ChatRequest, JSONSchema, LLMClient } from '../types';

/**
 * The app's LlamaClient for Node: the same request body (buildBody), sent
 * with fetch instead of XMLHttpRequest, which Node lacks. Records timings.
 */
export class NodeLlama implements LLMClient {
  name = 'Bonsai-2 (live)';
  readonly log: { tag: string; ms: number; firstTokenMs: number; text: string; leakedThink: boolean; tokensPerSec?: number }[] = [];

  constructor(readonly baseUrl = process.env.LLM_URL ?? 'http://127.0.0.1:8080') {}

  async ready(): Promise<boolean> {
    try {
      return (await fetch(`${this.baseUrl}/health`)).ok;
    } catch {
      return false;
    }
  }

  stream(req: ChatRequest, onToken: (t: string) => void): Promise<string> {
    return this.post(req, undefined, onToken);
  }

  async json<T>(req: ChatRequest, schema: JSONSchema): Promise<T> {
    return JSON.parse(await this.post(req, schema, () => {})) as T;
  }

  private async post(req: ChatRequest, schema: JSONSchema | undefined, onToken: (t: string) => void): Promise<string> {
    const start = Date.now();
    let first = 0;
    let tokensPerSec: number | undefined;
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...buildBody(req, schema), stream_options: { include_usage: true } }),
    });
    if (!res.ok || !res.body) throw new Error(`llama-server ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let text = '';
    let rawText = '';
    const think = new ThinkFilter();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const j = JSON.parse(data);
        const raw: string | undefined = j.choices?.[0]?.delta?.content;
        if (raw) rawText += raw;
        const delta = raw ? think.push(raw) : '';
        if (delta) {
          if (!first) first = Date.now() - start;
          text += delta;
          onToken(delta);
        }
        if (j.timings?.predicted_per_second) tokensPerSec = j.timings.predicted_per_second;
      }
    }
    this.log.push({ tag: req.tag, ms: Date.now() - start, firstTokenMs: first, text, leakedThink: rawText.trimStart().startsWith('<think>'), tokensPerSec });
    return text;
  }
}
