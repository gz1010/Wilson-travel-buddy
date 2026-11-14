import type { AudioClient, AudioInfo, Heard, Lang, TurnEvent } from '../../core/types';
import { AUDIO_HELPER_URL, PROTOCOL_VERSION, type AppToHelper, type HelperToApp } from './protocol';

/**
 * AudioClient backed by buddy-audio, the Argmax helper, over a local
 * WebSocket. Only one listen, one conversation and one queue of speech run
 * at a time.
 */
export class HelperAudioClient implements AudioClient {
  info: AudioInfo = { hasMicrophone: true, models: [], liveSpeakers: false };
  onStatus?: (message: string) => void;
  onLevel?: (value: number) => void;
  onDisconnect?: () => void;

  private ws?: WebSocket;
  private listener?: (m: HelperToApp) => void;
  private speakWaiters = new Map<string, () => void>();
  private startWaiters = new Map<string, () => void>();
  private conversationHandler?: (e: TurnEvent) => void;
  private counter = 0;

  /** Connects and waits for "ready" (the helper may still be loading models). */
  connect(url = AUDIO_HELPER_URL, timeoutMs = 2000, readyTimeoutMs = 120_000): Promise<boolean> {
    return new Promise(resolve => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        return finish(false);
      }
      this.ws = ws;
      const openTimer = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.close();
          finish(false);
        }
      }, timeoutMs);
      const readyTimer = setTimeout(() => {
        ws.close();
        finish(false);
      }, readyTimeoutMs);
      ws.onopen = () => {
        clearTimeout(openTimer);
        this.send({ type: 'hello', version: PROTOCOL_VERSION });
      };
      ws.onerror = () => finish(false);
      ws.onclose = () => {
        clearTimeout(openTimer);
        clearTimeout(readyTimer);
        finish(false);
        // Release everything waiting on the helper, so the mic button and the voice queue never hang.
        this.listener?.({ type: 'error', message: 'Audio helper disconnected' });
        this.listener = undefined;
        for (const done of this.speakWaiters.values()) done();
        this.speakWaiters.clear();
        this.conversationHandler = undefined;
        this.onDisconnect?.();
      };
      ws.onmessage = ev => {
        let m: HelperToApp;
        try {
          m = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        this.dispatch(m);
        if (m.type === 'error' && !settled) {
          // The helper could not load its models: give up now instead of waiting for the timeout.
          clearTimeout(readyTimer);
          ws.close();
          finish(false);
        }
        if (m.type === 'ready') {
          clearTimeout(readyTimer);
          this.info = { hasMicrophone: true, models: m.models, liveSpeakers: m.liveSpeakers };
          finish(true);
        }
      };
    });
  }

  private send(m: AppToHelper) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private dispatch(m: HelperToApp) {
    switch (m.type) {
      case 'status':
        this.onStatus?.(m.message);
        break;
      case 'level':
        this.onLevel?.(m.value);
        this.conversationHandler?.({ type: 'level', value: m.value });
        break;
      case 'speak.started': {
        const started = this.startWaiters.get(m.id);
        this.startWaiters.delete(m.id);
        started?.();
        break;
      }
      case 'speak.done': {
        const done = this.speakWaiters.get(m.id);
        this.speakWaiters.delete(m.id);
        this.startWaiters.delete(m.id);
        done?.();
        break;
      }
      case 'partial':
      case 'final':
        if (this.conversationHandler) {
          this.conversationHandler(
            m.type === 'partial'
              ? { type: 'partial', text: m.text, speaker: m.speaker }
              : { type: 'final', text: m.text, language: m.language, speaker: m.speaker },
          );
        }
        break;
      case 'error':
        this.onStatus?.(`Audio helper: ${m.message}`);
        break;
    }
    this.listener?.(m);
  }

  listen(onPartial: (text: string) => void, language?: Lang): Promise<Heard> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return reject(new Error('Audio helper not connected'));
      let heard: Heard = { text: '' };
      this.listener = m => {
        if (m.type === 'partial') onPartial(m.text);
        else if (m.type === 'final') heard = { text: m.text, language: m.language };
        else if (m.type === 'listen.done') {
          this.listener = undefined;
          resolve(heard);
        } else if (m.type === 'error') {
          this.listener = undefined;
          reject(new Error(m.message));
        }
      };
      this.send({ type: 'listen.start', language });
    });
  }

  stopListening() {
    this.send({ type: 'listen.stop' });
  }

  speak(text: string, language: Lang, onStart?: () => void): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve();
    const id = `s${++this.counter}`;
    return new Promise(resolve => {
      this.speakWaiters.set(id, resolve);
      if (onStart) this.startWaiters.set(id, onStart);
      this.send({ type: 'speak', id, text, language });
    });
  }

  stopSpeaking() {
    this.send({ type: 'speak.stop' });
    for (const done of this.speakWaiters.values()) done();
    this.speakWaiters.clear();
    this.startWaiters.clear();
  }

  conversation(languages: Lang[], onEvent: (e: TurnEvent) => void, options?: { pushToTalk?: boolean }): () => void {
    this.conversationHandler = onEvent;
    this.send({ type: 'conversation.start', languages, pushToTalk: options?.pushToTalk });
    return () => {
      this.conversationHandler = undefined;
      this.send({ type: 'conversation.stop' });
    };
  }

  turnStart() {
    this.send({ type: 'turn.start' });
  }

  turnEnd() {
    this.send({ type: 'turn.end' });
  }

  setMuted(muted: boolean) {
    this.send({ type: 'mute', muted });
  }
}
