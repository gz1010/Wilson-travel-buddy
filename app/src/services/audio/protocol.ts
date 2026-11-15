// The WebSocket protocol between the app and buddy-audio, the Argmax helper
// (audio-helper/ in this repo). JSON text messages, one per frame, on
// ws://127.0.0.1:8765. audio-helper/Sources/BuddyAudio/Protocol.swift must match.

import type { Lang } from '../../core/types';

export const AUDIO_HELPER_URL = 'ws://127.0.0.1:8765';
export const PROTOCOL_VERSION = 1;

export type AppToHelper =
  | { type: 'hello'; version: number }
  /**
   * Voice loop: listen for one utterance. The helper ends it on ~1 s of silence or listen.stop.
   * quietMs: end it if nobody starts speaking within this long (Wilson's follow-up); default 8 s.
   * listen.stop also ends the sentence after a wake word (wake.heard) early.
   */
  | { type: 'listen.start'; language?: Lang; quietMs?: number }
  | { type: 'listen.stop' }
  /**
   * Wake word ("Wilson, …" / "Hey Wilson"): listen for the name whenever the microphone is free
   * (no listen, no conversation; audio is dropped while muted or speaking). Send it again every
   * few seconds as a keepalive: after 20 s without any message the helper turns the microphone off.
   */
  | { type: 'wake.start' }
  | { type: 'wake.stop' }
  /**
   * Translator: listen continuously and label speakers. Each sentence is heard in one of
   * `languages` (the traveller's first); a known speaker keeps their language unless Whisper is
   * sure of another. Empty: all ten languages the voice speaks.
   */
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
  | { type: 'camera.alive' }
  /**
   * macOS Location (the helper asks CoreLocation, which locates a Mac from nearby Wi-Fi networks).
   * Answered by location or location.error with the same id, within about 8 s.
   */
  | { type: 'location.get'; id: string };

export type HelperToApp =
  | {
      type: 'ready';
      version: number;
      /** e.g. ["Whisper large-v3 (Argmax Pro)", "Qwen3-TTS 0.6B (Argmax)", "Sortformer (Argmax Pro)"] */
      models: string[];
      /** True when diarization labels speakers while they talk (Pro, Sortformer). */
      liveSpeakers: boolean;
      /** True when this helper build serves camera.* (older builds don't say, and have no camera). */
      camera?: boolean;
      /** True when this helper build has the wake word (wake.*) and speak.level. */
      wake?: boolean;
    }
  | { type: 'status'; message: string }
  | { type: 'level'; value: number }
  /** language: in a conversation, what Whisper hears so far, when it is one of the conversation's languages. */
  | { type: 'partial'; text: string; speaker?: number; language?: Lang }
  /** turn: the push-to-talk turn this answers. Every release gets exactly one final, maybe empty. */
  | { type: 'final'; text: string; language?: Lang; speaker?: number; turn?: string }
  /** sinceEndMs: how long ago the person stopped speaking (latency readout). */
  | { type: 'listen.done'; sinceEndMs?: number }
  /** The first audio of this request is ready to play (for latency measurement). */
  | { type: 'speak.started'; id: string }
  | { type: 'speak.done'; id: string }
  /** How loud the speech playing now is, 0-1, about 20 a second while it plays; 0 when it stops. */
  | { type: 'speak.level'; value: number }
  /** The wake word started (true) or stopped (false: stopped, microphone in use, or the voice is playing). */
  | { type: 'wake.state'; listening: boolean }
  /** "Wilson" began a sentence that is still going on; text: what follows so far. */
  | { type: 'wake.heard'; text: string }
  /**
   * A sentence that began with the wake word. text: the words after it ('' for "Wilson" alone);
   * heard: the whole sentence as Whisper read it; sinceEndMs: how long ago it ended.
   */
  | { type: 'wake'; text: string; heard: string; sinceEndMs?: number }
  | { type: 'error'; message: string }
  /** A live preview frame: base64 JPEG, ~1000 px wide (quality 0.75), at most 6 a second, fewer when frames are big. */
  | { type: 'camera.frame'; jpeg: string }
  /** The answer to camera.snap: base64 JPEG, ~1600 px wide (quality 0.85); no jpeg when the camera is not running. */
  | { type: 'camera.snapped'; id: string; jpeg?: string }
  /** No camera, permission refused, or the session failed. The camera is off after this. */
  | { type: 'camera.error'; message: string }
  /** The answer to location.get. accuracy: metres, when macOS gives one; at: when macOS made the fix, ms since 1970. */
  | { type: 'location'; id: string; lat: number; lon: number; accuracy?: number; at: number }
  /** macOS could not locate the Mac (Wi-Fi off, Location Services off, permission refused or not given yet). */
  | { type: 'location.error'; id: string; message: string };
