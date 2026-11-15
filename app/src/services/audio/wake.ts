// "Wilson, …": the companion's name at the start of a sentence, the phrases that end a spoken
// exchange ("Thanks, Wilson"), and the level feed behind Wilson's rings and mouth. Pure functions:
// the helper does the listening (Argmax Whisper); the app only reads the words.

import type { LevelKind } from '../../core/types';

const NAME = 'wilson';
/** Words allowed before the name: "Hey Wilson", "OK so Wilson". At most two. */
const LEADS = new Set([
  'hey', 'hi', 'hello', 'hallo', 'hola', 'ok', 'okay', 'oh', 'ah', 'a', 'um', 'uh', 'hmm', 'so', 'yo', 'alright', 'right', 'well',
]);

interface Word {
  key: string;
  start: number;
  end: number;
}

/** Plain lowercase letters: accents and case dropped ("Wilsón" -> "wilson"). */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const isDigit = (c: string) => c >= '0' && c <= '9';
/** A letter in any cased script (Latin, Greek, Cyrillic), or a digit. No \p{L}: not every JS engine has it. */
const isWordChar = (c: string) => isDigit(c) || c.toLowerCase() !== c.toUpperCase();

/** Words (letters and digits, with apostrophes inside them) and where they are in `text`. */
export function words(text: string): Word[] {
  const out: Word[] = [];
  let start = -1;
  const close = (end: number) => {
    if (start >= 0) {
      const key = fold(text.slice(start, end)).split('').filter(isWordChar).join('');
      if (key) out.push({ key, start, end });
    }
    start = -1;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (isWordChar(c) || (start >= 0 && (c === "'" || c === '’'))) {
      if (start < 0) start = i;
    } else {
      close(i);
    }
  }
  close(text.length);
  return out;
}

/** Levenshtein distance. */
export function distance(a: string, b: string): number {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** The name, give or take one letter ("Willson", "Wilsen", "Wilton", "Wilson's"). */
export function isName(key: string): boolean {
  return key.length >= 5 && key.length <= 8 && distance(key, NAME) <= 1;
}

/**
 * The words after the wake word (trimmed, first letter capitalised; '' for "Wilson" alone), or
 * undefined when the sentence does not start with it. Same rules as WakeWord.parse in the helper
 * (audio-helper/Sources/BuddyAudio/Wake.swift): change both together.
 */
export function parseWake(text: string): string | undefined {
  const ws = words(text);
  let i = 0;
  while (i < Math.min(2, ws.length) && LEADS.has(ws[i].key)) i++;
  if (i >= ws.length) return undefined;
  let end: number;
  if (isName(ws[i].key)) end = ws[i].end;
  else if (i + 1 < ws.length && isName(ws[i].key + ws[i + 1].key)) end = ws[i + 1].end; // "Will son"
  else return undefined;
  let rest = text.slice(end);
  let k = 0;
  while (k < rest.length && !isWordChar(rest[k])) k++;
  rest = rest.slice(k).trim();
  return rest ? rest[0].toUpperCase() + rest.slice(1) : '';
}

/** The question without a leading "Wilson," (saying the name is optional when you tap him). */
export function withoutName(text: string): string {
  const rest = parseWake(text);
  return rest === undefined ? text.trim() : rest;
}

// --- Ending a spoken exchange.

/** Whole replies that mean "that's all" (folded, apostrophes and punctuation dropped). */
const DISMISSALS = new Set([
  'thanks', 'thank you', 'thank u', 'thx', 'cheers', 'ta', 'gracias', 'merci', 'danke',
  'thats all', 'that is all', 'thats it', 'that is it', 'thats everything', 'that is everything', 'thatll be all', 'that will be all',
  'nothing', 'nothing else', 'nope', 'no', 'no thanks', 'no thank you', 'not now', 'no more',
  'never mind', 'nevermind', 'forget it', 'bye', 'bye bye', 'goodbye', 'good bye', 'see you', 'see ya', 'later',
  'stop', 'im good', 'i am good', 'all good', 'were good', 'we are good', 'im done', 'i am done', 'done', 'enough',
  'got it', 'gotcha', 'understood', 'sounds good', 'all right', 'will do',
]);
/** Said around a dismissal without changing it: "OK, that's all for now". */
const FILLERS_BEFORE = new Set(['ok', 'okay', 'alright', 'great', 'perfect', 'cool', 'nice', 'oh', 'ah', 'um', 'uh', 'well', 'right', 'sure', 'hey', 'and']);
const FILLERS_AFTER = new Set(['then', 'now', 'for', 'today', 'buddy', 'mate', 'again', 'please']);
/** What can follow "thanks" in a dismissal: "thanks so much for the help". */
const THANKS_TAIL = new Set(['you', 'so', 'very', 'much', 'a', 'lot', 'again', 'for', 'that', 'the', 'this', 'help', 'everything', 'all', 'buddy', 'mate', 'anyway']);

/**
 * True when a follow-up means the exchange is over ("Thanks, Wilson", "That's all", "No thanks"),
 * so Wilson goes back to idle instead of answering. "Thanks, and where can I eat?" is a question.
 */
export function isDismissal(text: string): boolean {
  const ws = words(text)
    .map(w => w.key)
    .filter(k => !isName(k));
  if (!ws.length) return false; // silence, or the name alone: the caller decides
  while (ws.length && FILLERS_BEFORE.has(ws[0])) ws.shift();
  while (ws.length > 1 && FILLERS_AFTER.has(ws[ws.length - 1])) ws.pop();
  if (!ws.length) return true; // only "OK" / "Great" / "Perfect": an acknowledgement
  const phrase = ws.join(' ');
  if (DISMISSALS.has(phrase)) return true;
  // "no, thanks", "no that's all"
  if (ws[0] === 'no' && DISMISSALS.has(ws.slice(1).join(' '))) return true;
  if (/^thank/.test(ws[0])) return ws.slice(1).every(w => THANKS_TAIL.has(w));
  return false;
}

// --- Levels.

export interface Levels {
  /** The microphone, 0-1, while Wilson listens (0 otherwise). */
  mic: number;
  /** Wilson's voice, 0-1, while he speaks (0 otherwise). */
  voice: number;
}

/**
 * The latest microphone and voice levels, pushed to subscribers as they arrive (about ten a
 * second for the microphone, twenty for the voice) without any React state, so the tree never
 * re-renders on a level. b.levels is one of these.
 */
export class LevelFeed {
  private current: Levels = { mic: 0, voice: 0 };
  private listeners = new Set<(l: Levels) => void>();

  /** cb gets the levels on every change (get() has the latest); returns unsubscribe. */
  subscribe = (cb: (l: Levels) => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  get = (): Levels => this.current;

  push(kind: LevelKind, value: number) {
    const v = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    if (this.current[kind] === v) return;
    this.current = { ...this.current, [kind]: v };
    const l = this.current;
    this.listeners.forEach(fn => {
      try {
        fn(l);
      } catch {
        // one subscriber's error never stops the others
      }
    });
  }
}
