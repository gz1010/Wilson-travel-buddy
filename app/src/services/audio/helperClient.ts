import type { AudioClient, AudioInfo, Heard, Lang, LocationFix, TurnEvent } from '../../core/types';
import { AUDIO_HELPER_URL, PROTOCOL_VERSION, type AppToHelper, type HelperToApp } from './protocol';

/**
 * AudioClient backed by buddy-audio, the Argmax helper, over a local
 * WebSocket. Only one listen, one conversation, one queue of speech and one
 * camera preview run at a time. The helper also owns the camera.
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
  /** The running camera preview, if any. A new startCamera replaces it. */
  private camera?: { onFrame: (jpeg: string) => void; onError?: (message: string) => void; alive: ReturnType<typeof setInterval> };
  private snapWaiters = new Map<string, (jpeg: string | undefined) => void>();
  /** locate() calls waiting for the helper's location / location.error, by id. */
  private locateWaiters = new Map<string, (fix: LocationFix | undefined, error?: string) => void>();

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
        this.endCamera('Audio helper disconnected');
        for (const done of [...this.locateWaiters.values()]) done(undefined, 'The audio helper disconnected.');
        this.locateWaiters.clear();
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
              ? { type: 'partial', text: m.text, speaker: m.speaker, language: m.language }
              : { type: 'final', text: m.text, language: m.language, speaker: m.speaker, turn: m.turn },
          );
        }
        break;
      case 'error':
        this.onStatus?.(`Audio helper: ${m.message}`);
        break;
      case 'camera.frame':
        this.camera?.onFrame(m.jpeg);
        return; // up to 6 a second: nothing else wants them
      case 'camera.snapped': {
        const done = this.snapWaiters.get(m.id);
        this.snapWaiters.delete(m.id);
        done?.(m.jpeg || undefined);
        return;
      }
      case 'camera.error':
        this.endCamera(m.message); // the helper has already turned the camera off
        return;
      case 'location': {
        const usable = Number.isFinite(m.lat) && Number.isFinite(m.lon) && Math.abs(m.lat) <= 90 && Math.abs(m.lon) <= 180;
        this.locateWaiters.get(m.id)?.(
          usable
            ? {
                lat: m.lat,
                lon: m.lon,
                accuracy: typeof m.accuracy === 'number' && Number.isFinite(m.accuracy) && m.accuracy >= 0 ? m.accuracy : undefined,
                at: Number.isFinite(m.at) ? m.at : Date.now(),
              }
            : undefined,
          usable ? undefined : 'macOS sent a position the app cannot use.',
        );
        return;
      }
      case 'location.error':
        this.locateWaiters.get(m.id)?.(undefined, m.message);
        return;
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
          resolve(m.sinceEndMs != null ? { ...heard, endedAt: Date.now() - m.sinceEndMs } : heard);
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

  turnStart(turn: string, language?: Lang) {
    this.send({ type: 'turn.start', turn, language });
  }

  turnEnd(turn: string) {
    this.send({ type: 'turn.end', turn });
  }

  setMuted(muted: boolean) {
    this.send({ type: 'mute', muted });
  }

  startCamera(onFrame: (jpeg: string) => void, onError?: (message: string) => void, aliveMs = 4000): () => void {
    this.endCamera(); // one preview at a time: a new one replaces the old
    if (this.ws?.readyState !== WebSocket.OPEN) {
      onError?.('Audio helper not connected');
      return () => {};
    }
    // The helper turns the camera off when it hears nothing from us for 15 s (the app quit).
    const alive = setInterval(() => this.send({ type: 'camera.alive' }), aliveMs);
    const camera = { onFrame, onError, alive };
    this.camera = camera;
    this.send({ type: 'camera.start' });
    return () => {
      if (this.camera !== camera) return; // already stopped or replaced
      this.endCamera();
      this.send({ type: 'camera.stop' });
    };
  }

  snap(timeoutMs = 5000): Promise<string | undefined> {
    if (this.ws?.readyState !== WebSocket.OPEN || !this.camera) return Promise.resolve(undefined);
    const id = `c${++this.counter}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.snapWaiters.delete(id);
        resolve(undefined);
      }, timeoutMs);
      this.snapWaiters.set(id, jpeg => {
        clearTimeout(timer);
        resolve(jpeg);
      });
      this.send({ type: 'camera.snap', id });
    });
  }

  /**
   * Asks the helper where macOS says the Mac is. The helper gives up after ~8 s (a permission
   * prompt nobody answered, or no Wi-Fi), so timeoutMs is a little longer: running out means the
   * helper never answered (a build from before location.get ignores it).
   */
  locate(onError?: (message: string) => void, timeoutMs = 10_000): Promise<LocationFix | undefined> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      onError?.('The audio helper is not connected, so macOS Location is not available.');
      return Promise.resolve(undefined);
    }
    const id = `g${++this.counter}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => finish(undefined, 'The audio helper did not answer. An older build has no Location: rebuild and restart it.'), timeoutMs);
      const finish = (fix: LocationFix | undefined, error?: string) => {
        clearTimeout(timer);
        this.locateWaiters.delete(id);
        if (!fix) onError?.(error ?? 'macOS could not locate this Mac.');
        resolve(fix);
      };
      this.locateWaiters.set(id, finish);
      this.send({ type: 'location.get', id });
    });
  }

  /** Forgets the preview's callbacks and releases waiting snaps; reports `error` to the preview, if given. */
  private endCamera(error?: string) {
    const camera = this.camera;
    this.camera = undefined;
    if (camera) clearInterval(camera.alive);
    for (const done of this.snapWaiters.values()) done(undefined);
    this.snapWaiters.clear();
    if (camera && error) camera.onError?.(error);
  }
}
