import type { Heard } from '../core/types';
import { isDismissal, parseWake } from '../services/audio/wake';

/**
 * Call and response: after Wilson has spoken his answer to a voice question (a tap, or "Wilson,
 * …"), he keeps listening for a follow-up for a few seconds without another tap. Speech is the
 * next question; silence, or "Thanks, Wilson" / "That's all", ends the exchange and he goes
 * back to idle (and the wake word listens again). A tap, a typed message or stopping his voice
 * cancels it. Kept free of React so it can be tested with fakes (see __tests__/voiceLoop.test.ts).
 */
export interface VoiceLoopDeps {
  /**
   * Sends a question to the companion and resolves once its spoken answer has finished playing.
   * spoke: false when nothing was said aloud (an error, Translate opened, the voice was stopped).
   */
  ask(text: string, heardAt?: number): Promise<{ spoke: boolean }>;
  /** Listens for one sentence; quietMs: give up if nobody starts talking within this long. */
  listen(quietMs?: number): Promise<Heard>;
  /** Says a short line ("Yes?") and resolves once it has played. */
  say(text: string): Promise<void>;
  /** Follow-up listening started (true) or ended (false), for the screens. */
  onFollowUp?(on: boolean): void;
  /** Whether Wilson may listen for a follow-up now (there is a microphone; not on Translate). */
  canListen?(): boolean;
}

export interface VoiceLoopOptions {
  /** How long Wilson waits for a follow-up to start. */
  followUpMs: number;
  /** At most this many questions in one exchange, so it can never run away. */
  maxTurns: number;
}

export const VOICE_LOOP_DEFAULTS: VoiceLoopOptions = { followUpMs: 6000, maxTurns: 8 };

/** What Wilson says when he hears only his name. */
export const SUMMONED_REPLY = 'Yes?';

export class VoiceLoop {
  private gen = 0;
  private running = 0;

  constructor(private deps: VoiceLoopDeps, private options: VoiceLoopOptions = VOICE_LOOP_DEFAULTS) {}

  /** True while an exchange is in progress (asking, answering, or waiting for a follow-up). */
  get active(): boolean {
    return this.running > 0;
  }

  /** Ends the exchange: an answer already playing is left alone, but no follow-up starts. */
  cancel(): void {
    this.gen++;
  }

  /** A tap on Wilson (or the microphone button): listen, then answer, then follow-ups. */
  async listenFirst(): Promise<void> {
    const gen = ++this.gen;
    this.running++;
    try {
      const heard = await this.safeListen();
      if (gen !== this.gen) return;
      // A spoken question is timed from when the person stopped talking (the latency readout).
      await this.exchange(gen, heard.text, heard.endedAt ?? Date.now(), false);
    } finally {
      this.running--;
    }
  }

  /**
   * A sentence that began with "Wilson" (the wake word). rest: the words after the name; '' for
   * the name alone, which gets "Yes?" and a listen.
   */
  async wake(rest: string, heardAt?: number): Promise<void> {
    const gen = ++this.gen;
    this.running++;
    try {
      await this.exchange(gen, rest, heardAt, true);
    } finally {
      this.running--;
    }
  }

  private async exchange(gen: number, first: string, firstAt: number | undefined, named: boolean): Promise<void> {
    let text = first;
    let at = firstAt;
    let saidName = named;
    for (let turn = 0; turn < this.options.maxTurns; turn++) {
      // "Wilson, …" is optional at the start of any question, and never part of it.
      const afterName = saidName ? text : parseWake(text);
      if (afterName !== undefined) saidName = true;
      const question = (afterName ?? text).trim();
      if (!question) {
        if (!saidName) return; // silence: back to idle
        await this.deps.say(SUMMONED_REPLY).catch(() => {});
        if (gen !== this.gen) return;
      } else {
        // "Thanks, Wilson" after an answer ends it; as a first sentence it still gets a reply.
        if (turn > 0 && isDismissal(question)) return;
        const { spoke } = await this.deps.ask(question, at).catch(() => ({ spoke: false }));
        if (gen !== this.gen || !spoke) return;
      }
      if (this.deps.canListen && !this.deps.canListen()) return;
      this.deps.onFollowUp?.(true);
      let heard: Heard;
      try {
        heard = await this.safeListen(this.options.followUpMs);
      } finally {
        this.deps.onFollowUp?.(false);
      }
      if (gen !== this.gen) return;
      text = heard.text;
      at = heard.endedAt ?? Date.now();
      saidName = false;
      if (!text.trim()) return; // nobody followed up
    }
  }

  private async safeListen(quietMs?: number): Promise<Heard> {
    try {
      return await this.deps.listen(quietMs);
    } catch {
      return { text: '' };
    }
  }
}
