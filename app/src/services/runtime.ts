import scriptedConversation from '../fixtures/conversation_es_en.json';
import { llmAnswers } from '../fixtures/llmAnswers';
import type { AudioClient, LLMClient } from '../core/types';
import { HelperAudioClient } from './audio/helperClient';
import { TypedAudio, type ScriptedLine } from './audio/typedAudio';
import { FixtureLLM } from './llm/fixtureLLM';
import { LlamaClient } from './llm/llamaClient';
import { AUDIO_HELPER_URL, LLM_URL } from '../config';

export interface Runtime {
  llm: LLMClient;
  audio: AudioClient;
  /** True when the real model and the real audio helper are both connected. */
  live: { llm: boolean; audio: boolean };
}

/**
 * Connects to llama-server and the Argmax helper on 127.0.0.1. Either one
 * missing falls back to a stand-in, so the app always opens.
 */
export async function connectRuntime(onStatus: (s: string) => void): Promise<Runtime> {
  onStatus('Connecting to Bonsai-2…');
  const llama = new LlamaClient(LLM_URL);
  const llmOk = await waitFor(() => llama.connect(), 4);

  onStatus('Connecting to the Argmax audio helper…');
  const helper = new HelperAudioClient();
  helper.onStatus = onStatus;
  const audioOk = await helper.connect(AUDIO_HELPER_URL);

  return {
    llm: llmOk ? llama : new FixtureLLM(llmAnswers),
    audio: audioOk ? helper : new TypedAudio(scriptedConversation as ScriptedLine[]),
    live: { llm: llmOk, audio: audioOk },
  };
}

/** llama-server answers /health with 503 while the model loads; give it a few tries. */
async function waitFor(check: () => Promise<boolean>, tries: number): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await check()) return true;
    await new Promise<void>(r => setTimeout(r, 1000));
  }
  return false;
}
