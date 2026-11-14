// The WebSocket protocol between the app and buddy-audio, the Argmax helper
// (audio-helper/ in this repo). JSON text messages, one per frame, on
// ws://127.0.0.1:8765. audio-helper/Sources/BuddyAudio/Protocol.swift must match.

import type { Lang } from '../../core/types';

export const AUDIO_HELPER_URL = 'ws://127.0.0.1:8765';
export const PROTOCOL_VERSION = 1;

export type AppToHelper =
  | { type: 'hello'; version: number }
  /** Voice loop: listen for one utterance. The helper ends it on ~0.8 s of silence or listen.stop. */
  | { type: 'listen.start'; language?: Lang }
  | { type: 'listen.stop' }
  /** Translator: listen continuously and label speakers. */
  | { type: 'conversation.start'; languages: Lang[] }
  | { type: 'conversation.stop' }
  /** Drop microphone audio while the app's own voice is playing. */
  | { type: 'mute'; muted: boolean }
  | { type: 'speak'; id: string; text: string; language: Lang }
  | { type: 'speak.stop' };

export type HelperToApp =
  | {
      type: 'ready';
      version: number;
      /** e.g. ["Whisper large-v3 (Argmax Pro)", "Qwen3-TTS 0.6B (Argmax)", "Sortformer (Argmax Pro)"] */
      models: string[];
      /** True when diarization labels speakers while they talk (Pro, Sortformer). */
      liveSpeakers: boolean;
    }
  | { type: 'status'; message: string }
  | { type: 'level'; value: number }
  | { type: 'partial'; text: string; speaker?: number }
  | { type: 'final'; text: string; language?: Lang; speaker?: number }
  | { type: 'listen.done' }
  | { type: 'speak.done'; id: string }
  | { type: 'error'; message: string };
