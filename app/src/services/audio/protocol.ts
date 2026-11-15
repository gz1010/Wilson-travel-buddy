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
   * Camera (the Look screen). The helper owns the camera as it owns the microphone. camera.start
   * begins a preview stream of camera.frame messages (~480 px wide, JPEG quality 0.5, at most
   * 6 per second); camera.snap asks for one sharper still (~1024 px, quality 0.8), answered by
   * camera.snapped with the same id; camera.stop ends the preview. Order follows the inbox.
   */
  | { type: 'camera.start' }
  | { type: 'camera.snap'; id: string }
  | { type: 'camera.stop' };

export type HelperToApp =
  | {
      type: 'ready';
      version: number;
      /** e.g. ["Whisper large-v3 (Argmax Pro)", "Qwen3-TTS 0.6B (Argmax)", "Sortformer (Argmax Pro)"] */
      models: string[];
      /** True when diarization labels speakers while they talk (Pro, Sortformer). */
      liveSpeakers: boolean;
      /** True when this helper build handles the camera.* messages. Older builds leave it out. */
      camera?: boolean;
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
  /** jpeg: base64 JPEG data, no "data:" prefix. */
  | { type: 'camera.frame'; jpeg: string }
  | { type: 'camera.snapped'; id: string; jpeg: string }
  /** No camera, access refused, or a snap that failed (then with its id). */
  | { type: 'camera.error'; message: string; id?: string }
  | { type: 'error'; message: string };
