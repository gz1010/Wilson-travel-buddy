import type { Buddy } from '../useBuddy';
import type { Nav } from '../dusk/Nav';

/** Every main Dusk screen gets the app state (useBuddy) and navigation. */
export interface ScreenProps {
  b: Buddy;
  nav: Nav;
}

export interface WelcomeProps {
  city: string;
  /** Loading steps shown on glass: the guide, Bonsai-2, listening, voices. */
  steps: { label: string; state: 'ready' | 'loading' | 'off' }[];
  /** The latest status line from connecting to the helpers. */
  status: string;
  /** The on-device model names once connected (Bonsai-2 and the Argmax models), shown once ready. */
  models?: string[];
  ready: boolean;
  onStart: () => void;
  /** What the online preparation put in the pack (prepared.json), shown as one line under the welcome. */
  prepared?: PackPrepared;
}

/**
 * The summary scripts/prepare-pack.mjs writes to src/pack/<city>/prepared.json after fetching facts,
 * photos, the forecast and the map tiles online. The app only reads it; nothing here is fetched.
 */
export interface PackPrepared {
  /** When the pack was prepared (ISO 8601 with the preparer's offset), or null if it never was. */
  preparedAt: string | null;
  /** Places in the pack. */
  places: number;
  /** All facts in the pack, hand-written and from Wikipedia. */
  facts: number;
  /** The facts that came from Wikipedia. */
  wikiFacts?: number;
  /** Places with a bundled photo. */
  photos: number;
  /** Time-of-day city photos (up to four). */
  heroes?: number;
  /** Baked map tiles (gitignored, so 0 on a fresh clone until build-tiles runs). */
  tiles?: number;
  /** First and last hour of the saved forecast ("YYYY-MM-DDTHH:00", destination time). */
  forecastFrom?: string | null;
  forecastTo?: string | null;
}
