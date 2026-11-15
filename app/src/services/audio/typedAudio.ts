import type { AudioClient, AudioInfo, Heard, Lang, TurnEvent } from '../../core/types';

export interface ScriptedLine {
  speaker: number;
  language: Lang;
  text: string;
}

/**
 * Stand-in for the Argmax helper, used when it is not running (always on
 * B's machine). There is no microphone: the UI shows a text box instead,
 * speech is only shown as text, and the translator replays a script.
 */
export class TypedAudio implements AudioClient {
  readonly info: AudioInfo = { hasMicrophone: false, models: ['No audio helper: typed input'], liveSpeakers: false };

  constructor(private script: ScriptedLine[], private lineDelayMs = 2500) {}

  listen(): Promise<Heard> {
    return Promise.reject(new Error('No microphone: type instead'));
  }

  stopListening() {}

  async speak(_text: string, _language: Lang, onStart?: () => void): Promise<void> {
    onStart?.();
  }

  turnStart(_turn: string, _language?: Lang) {}

  turnEnd(_turn: string) {}

  stopSpeaking() {}

  setMuted() {}

  /** Replays the script word by word, as the real helper would stream it. */
  conversation(_languages: Lang[], onEvent: (e: TurnEvent) => void): () => void {
    let stopped = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let at = 600;
    for (const line of this.script) {
      const words = line.text.split(' ');
      words.forEach((_, i) => {
        timers.push(
          setTimeout(() => {
            if (!stopped) onEvent({ type: 'partial', text: words.slice(0, i + 1).join(' '), speaker: line.speaker });
          }, at + i * 120),
        );
      });
      at += words.length * 120 + 300;
      timers.push(
        setTimeout(() => {
          if (!stopped) onEvent({ type: 'final', text: line.text, language: line.language, speaker: line.speaker });
        }, at),
      );
      at += this.lineDelayMs;
    }
    return () => {
      stopped = true;
      timers.forEach(clearTimeout);
    };
  }
}
