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
  | { type: 'conversation.start'; languages: Lang[]; pushToTalk?: boolean }
  /**
   * Push-to-talk only: someone pressed / released their button. `turn` is an id the helper
   * echoes on that turn's final; `language` is the button's language, so Whisper doesn't guess.
   */
  | { type: 'turn.start'; turn: string; language?: Lang }
  | { type: 'turn.end'; turn: string }
  | { type: 'conversation.stop' }
  /** Drop microphone audio while the app's own voice is playing. */
  | { type: 'mute'; muted: boolean }
  | { type: 'speak'; id: string; text: string; language: Lang }
  | { type: 'speak.stop' }
  /**
   * Camera (the helper owns it, as it owns the microphone). camera.start begins the preview
   * frames; camera.snap asks for one sharper still, answered by camera.snapped with the same id.
   */
  | { type: 'camera.start' }
  | { type: 'camera.snap'; id: string }
  | { type: 'camera.stop' }
  /** Sent every few seconds while the preview shows; without any message for 15 s the helper turns the camera off. */
  | { type: 'camera.alive' };

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
  /** turn: the push-to-talk turn this answers. Every release gets exactly one final, maybe empty. */
  | { type: 'final'; text: string; language?: Lang; speaker?: number; turn?: string }
  /** sinceEndMs: how long ago the person stopped speaking (latency readout). */
  | { type: 'listen.done'; sinceEndMs?: number }
  /** The first audio of this request is ready to play (for latency measurement). */
  | { type: 'speak.started'; id: string }
  | { type: 'speak.done'; id: string }
  | { type: 'error'; message: string }
  /** A live preview frame: base64 JPEG, ~480 px wide, at most 6 a second. */
  | { type: 'camera.frame'; jpeg: string }
  /** The answer to camera.snap: base64 JPEG, ~1024 px wide; no jpeg when the camera is not running. */
  | { type: 'camera.snapped'; id: string; jpeg?: string }
  /** No camera, permission refused, or the session failed. The camera is off after this. */
  | { type: 'camera.error'; message: string };
