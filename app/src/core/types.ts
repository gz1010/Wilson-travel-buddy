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

/**
 * A photo shipped in the pack (scripts/build-photos.mjs). The image file itself is bundled through
 * src/pack/<city>/photos/index.ts; this is its record, kept for the credits screen.
 */
export interface PhotoRef {
  /** File name under src/pack/<city>/photos/. */
  file: string;
  /** Author, as Wikimedia Commons gives it. */
  credit: string;
  /** e.g. "CC BY-SA 4.0". */
  license: string;
  /** The Commons file page. */
  source: string;
}

export type TimeOfDay = 'midday' | 'afternoon' | 'dusk' | 'night';

export interface Place {
  id: string;
  name: string;
  /** Name in the local language, if different. */
  localName?: string;
  /** Other names people use for it ("old town"). Used to match what the traveller says. */
  aliases?: string[];
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
  /** Pack photo; places without one get a drawn scene tile. */
  photo?: PhotoRef;
}

export interface Fact {
  id: string;
  placeId?: string;
  title: string;
  body: string;
  tags: Interest[];
  /** Where the text comes from, e.g. the Wikipedia article URL (scripts/fetch-facts.mjs). Hand-written facts have none. */
  source?: string;
  /** The text's licence when it is not ours, e.g. "CC BY-SA 4.0". */
  license?: string;
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
  /** City photos for the Now screen, one per time of day. */
  heroes?: Partial<Record<TimeOfDay, PhotoRef>>;
  /**
   * Local dishes Look may name from a photo: "local name (what it looks like)". Without these
   * Bonsai-2 4B calls salmorejo or espinacas con garbanzos "gazpacho".
   */
  dishes?: string[];
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
  /**
   * Base64 JPEGs (no data: prefix) shown to the model with this message. Bonsai-2 4B reads them
   * through llama-server's vision projector; FixtureLLM ignores them. Code picks the images,
   * never the model.
   */
  images?: string[];
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
  /** Date.now() when the person stopped speaking, if the helper reported it. */
  endedAt?: number;
}

export type Side = 'traveler' | 'local';

export type TurnEvent =
  /** language: what Argmax hears so far (one of the conversation's languages), when it can tell. */
  | { type: 'partial'; text: string; speaker?: number; language?: Lang }
  | { type: 'final'; text: string; language?: Lang; speaker?: number; turn?: string }
  | { type: 'level'; value: number };

export interface AudioInfo {
  /** False for the typed stand-in: the UI shows a text box instead of a microphone. */
  hasMicrophone: boolean;
  /** Model names for the on-screen badge. */
  models: string[];
  /** True when speakers are labelled live (Argmax Pro). */
  liveSpeakers: boolean;
  /** True when the helper says it serves the camera; undefined for older helper builds. */
  camera?: boolean;
}

export interface AudioClient {
  readonly info: AudioInfo;
  /** Listens for one utterance; resolves when the speaker stops. */
  listen(onPartial: (text: string) => void, language?: Lang): Promise<Heard>;
  /** Ends the current listen early; the pending listen resolves with what was heard. */
  stopListening(): void;
  /** Speaks and resolves when finished. onStart fires when its first audio is ready. */
  speak(text: string, language: Lang, onStart?: () => void): Promise<void>;
  stopSpeaking(): void;
  /**
   * Translator mode: listening with speaker labels. Returns stop(). With pushToTalk, nothing is
   * recorded except between turnStart() and turnEnd() (one button per person); Argmax still labels
   * the speaker of every sentence.
   */
  conversation(languages: Lang[], onEvent: (e: TurnEvent) => void, options?: { pushToTalk?: boolean }): () => void;
  /** Push-to-talk: a button was pressed. turn is echoed on its final; language is the button's. */
  turnStart(turn: string, language?: Lang): void;
  turnEnd(turn: string): void;
  /** Ignore the microphone while our own voice is playing. */
  setMuted(muted: boolean): void;
  /**
   * Starts the camera preview: onFrame gets each frame as a base64 JPEG (~480 px wide, at most
   * 6 a second). onError gets why there is no camera (none, permission refused, it failed); the
   * camera is off after that. Returns stop().
   */
  startCamera(onFrame: (jpeg: string) => void, onError?: (message: string) => void): () => void;
  /** A sharper still (base64 JPEG, ~1024 px) from the running camera; undefined if there is none. */
  snap(): Promise<string | undefined>;
  /**
   * Where macOS says this Mac is (CoreLocation, through the helper: it locates a Mac from nearby
   * Wi-Fi networks, so it fails with Wi-Fi off). Resolves undefined when it can't, after at most
   * about 10 s; onError, if given, gets the helper's reason.
   */
  locate(onError?: (message: string) => void): Promise<LocationFix | undefined>;
}

/** A position fix from macOS Location (or the last one saved). */
export interface LocationFix {
  lat: number;
  lon: number;
  /** Radius in metres, when known. */
  accuracy?: number;
  /** When the fix was made, ms since 1970 (Date.now()). */
  at: number;
}

// ---------------------------------------------------------------------------
// The companion: the seam between the two halves of the team

export type CompanionEvent =
  | { type: 'status'; text: string }
  /** lang: the language to speak this in, when it isn't English (phrase answers). */
  | { type: 'token'; text: string; lang?: Lang }
  /** cited: the guide facts behind a guide answer, for the screens to show. */
  | { type: 'done'; text: string; lang?: Lang; cited?: Cited }
  | { type: 'focus'; placeId: string }
  | { type: 'recommendations'; items: Recommendation[] }
  | { type: 'trip'; trip: Trip }
  | { type: 'translator' }
  | { type: 'error'; text: string };

/**
 * The facts behind the latest answer (b.cited): those the model cited first, then the rest of
 * the place's, on the question's topic first. Code picks them; the model only numbers sources.
 */
export interface Cited {
  /** The place the answer is about, when there is one. */
  placeId?: string;
  facts: Fact[];
}

export interface Companion {
  handle(text: string, onEvent: (e: CompanionEvent) => void): Promise<void>;
}
