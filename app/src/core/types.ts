// Shared types and contracts for Travel Buddy.
//
// Everything in src/core is plain TypeScript with no React or React Native
// imports, so `npm test` runs it in Node on any machine. Change these types
// only at a sync, and say so first: both halves of the team build against them.

// ---------------------------------------------------------------------------
// Basics

/** Languages the Argmax voice (TTSKit) can speak. Codes match Whisper's. */
export type Lang = 'en' | 'es' | 'fr' | 'de' | 'it' | 'pt' | 'ja' | 'ko' | 'zh' | 'ru';

export const LANG_NAMES: Record<Lang, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  ru: 'Russian',
};

export interface GeoPoint {
  lat: number;
  lon: number;
}

/**
 * Wall-clock time at the destination. We never use the Mac's own time zone:
 * the demo sets the clock by hand, and Hermes' time zone support is limited.
 */
export interface Clock {
  /** YYYY-MM-DD at the destination. */
  date: string;
  /** Minutes since local midnight, 0–1439. */
  minute: number;
}

// ---------------------------------------------------------------------------
// The destination pack (src/pack/<id>/*.json)

/** Interest tags. Places, facts and the user's interests all use this list. */
export const INTERESTS = [
  'food',
  'tapas',
  'markets',
  'architecture',
  'history',
  'art',
  'museums',
  'religion',
  'nature',
  'views',
  'nightlife',
  'flamenco',
  'music',
  'shopping',
  'local-life',
  'quiet',
  'family',
] as const;
export type Interest = (typeof INTERESTS)[number];

export type PlaceCategory =
  | 'landmark'
  | 'museum'
  | 'church'
  | 'park'
  | 'viewpoint'
  | 'market'
  | 'restaurant'
  | 'tapas-bar'
  | 'cafe'
  | 'bar'
  | 'flamenco'
  | 'shop'
  | 'neighborhood'
  | 'hotel';

/**
 * Opening hours. Keys are `mon`…`sun`, or `daily` for every day. Values are
 * comma-separated ranges ("10:00-14:00,17:00-20:00"), "24h", or "closed".
 * A range ending after midnight is written with an end before its start
 * ("20:00-02:00").
 */
export type OpeningHours = Partial<Record<'daily' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', string>>;

export interface Place {
  id: string;
  name: string;
  /** Name in the local language, if different. */
  localName?: string;
  category: PlaceCategory;
  point: GeoPoint;
  neighborhood?: string;
  tags: Interest[];
  indoor: boolean;
  /** Typical visit length in minutes. */
  visitMinutes: number;
  hours: OpeningHours;
  /** 0 = free … 3 = expensive. */
  price?: 0 | 1 | 2 | 3;
  /** One or two sentences, used in search and as model context. */
  summary: string;
}

export interface Fact {
  id: string;
  placeId?: string;
  title: string;
  body: string;
  tags: Interest[];
}

export interface Phrase {
  id: string;
  en: string;
  local: string;
  /** How to say it, for the screen. */
  pronunciation?: string;
  category: string;
}

export interface ForecastHour {
  /** Destination local time, "YYYY-MM-DDTHH:00". */
  time: string;
  temperatureC: number;
  precipitationChance: number; // 0–100
  /** WMO weather code, if known. */
  code?: number;
}

export interface Forecast {
  /** When the forecast was saved, ISO 8601 with offset. Shown as its age. */
  savedAt: string;
  source: string;
  hours: ForecastHour[];
}

export interface Destination {
  id: string;
  name: string;
  country: string;
  /** The local language: what the translator translates to and from. */
  language: Lang;
  center: GeoPoint;
  /** Minutes east of UTC for the trip dates (e.g. 60 for Seville in winter). */
  utcOffsetMinutes: number;
  /** Map bounds: [west, south, east, north]. */
  bounds: [number, number, number, number];
}

export interface Pack {
  destination: Destination;
  places: Place[];
  facts: Fact[];
  phrases: Phrase[];
  forecast: Forecast;
}

// ---------------------------------------------------------------------------
// The trip

export interface Stop {
  id: string;
  title: string;
  placeId?: string;
  /** 1-based day of the trip. */
  day: number;
  /** "HH:MM", if the stop has a time. */
  start?: string;
  durationMinutes?: number;
  /** A booking or ticket: recommendations work around it. */
  fixed: boolean;
  note?: string;
}

export interface Trip {
  /** YYYY-MM-DD of day 1. */
  startDate: string;
  days: number;
  /** Where the traveller is staying. */
  base?: { name: string; placeId?: string; point?: GeoPoint };
  interests: Interest[];
  stops: Stop[];
  /** What the traveller said, kept for corrections. */
  description: string;
}

// ---------------------------------------------------------------------------
// The situation the companion is reasoning about

export interface Situation {
  clock: Clock;
  location: GeoPoint;
  locationLabel: string;
  /** Place IDs already visited or dismissed. */
  visited: string[];
}

export interface Candidate {
  place: Place;
  score: number;
  walkMinutes: number;
  /** Closing time today as "HH:MM", if it closes. */
  closesAt?: string;
  matchedInterests: Interest[];
  /** Short facts computed in code for the model to quote, e.g. "8 min walk". */
  notes: string[];
}

export interface Recommendation {
  placeId: string;
  reason: string;
  candidate: Candidate;
  /** True when the reason came from the model, false when written by code. */
  fromModel: boolean;
}

// ---------------------------------------------------------------------------
// The language model

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Names the kind of request; FixtureLLM uses it to pick a recorded answer. */
  tag: string;
}

export type JSONSchema = Record<string, unknown>;

export interface LLMClient {
  readonly name: string;
  /** Streams the reply; resolves with the full text. */
  stream(req: ChatRequest, onToken: (token: string) => void): Promise<string>;
  /** Returns JSON matching the schema; the server enforces it with a grammar. */
  json<T>(req: ChatRequest, schema: JSONSchema): Promise<T>;
}

// ---------------------------------------------------------------------------
// Audio (Argmax, through the audio helper)

export interface Heard {
  text: string;
  language?: Lang;
}

export type Side = 'traveler' | 'local';

export type TurnEvent =
  | { type: 'partial'; text: string; speaker?: number }
  | { type: 'final'; text: string; language?: Lang; speaker?: number }
  | { type: 'level'; value: number };

export interface AudioInfo {
  /** False for the typed stand-in: the UI shows a text box instead of a microphone. */
  hasMicrophone: boolean;
  /** Model names for the on-screen badge. */
  models: string[];
  /** True when speakers are labelled live (Argmax Pro). */
  liveSpeakers: boolean;
}

export interface AudioClient {
  readonly info: AudioInfo;
  /** Listens for one utterance; resolves when the speaker stops. */
  listen(onPartial: (text: string) => void, language?: Lang): Promise<Heard>;
  /** Ends the current listen early; the pending listen resolves with what was heard. */
  stopListening(): void;
  /** Speaks and resolves when finished. */
  speak(text: string, language: Lang): Promise<void>;
  stopSpeaking(): void;
  /** Translator mode: continuous listening with speaker labels. Returns stop(). */
  conversation(languages: Lang[], onEvent: (e: TurnEvent) => void): () => void;
  /** Ignore the microphone while our own voice is playing. */
  setMuted(muted: boolean): void;
}

// ---------------------------------------------------------------------------
// The companion: the seam between the two halves of the team

export type CompanionEvent =
  | { type: 'status'; text: string }
  | { type: 'token'; text: string }
  | { type: 'done'; text: string }
  | { type: 'focus'; placeId: string }
  | { type: 'recommendations'; items: Recommendation[] }
  | { type: 'trip'; trip: Trip }
  | { type: 'translator' }
  | { type: 'error'; text: string };

export interface Companion {
  handle(text: string, onEvent: (e: CompanionEvent) => void): Promise<void>;
}
