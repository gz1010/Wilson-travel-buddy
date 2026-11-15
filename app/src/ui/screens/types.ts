import type { Buddy } from '../useBuddy';
import type { Nav } from '../dusk/Nav';

/** Every main Dusk screen gets the app state (useBuddy) and navigation. */
export interface ScreenProps {
  b: Buddy;
  nav: Nav;
}

/**
 * The home (WelcomeScreen): Wilson, the cities he knows stacked as photo cards, and "Plan your next
 * journey" with an input and the itinerary import. It shows from launch, while the on-device models
 * are still loading (no `b` yet: Wilson is waking), and again whenever someone leaves a city's guide.
 */
export interface WelcomeProps {
  /** The cities Wilson knows: packs prepared online once, stacked as cards, first on top. */
  cities: KnownCity[];
  /** Opens a city's guide (Now). Waits for Wilson to wake up if the models are still loading. */
  onOpenCity: (cityId: string) => void;
  /** The city being opened while Wilson is still waking up, if one was tapped. */
  opening?: string;
  /** The latest status line from connecting to the on-device models. */
  status: string;
  /** The on-device model names once connected (Bonsai-2 and the Argmax models). */
  models?: string[];
  /** The app state once the models are connected; undefined while they load (Wilson is waking). */
  b?: Buddy;
}

/**
 * A city Wilson has learned: a pack prepared once while online (scripts/prepare-pack.mjs) and used
 * offline from then on. The home stacks one card per city; this round only Seville is prepared.
 */
export interface KnownCity {
  /** The pack's id (its destination id and folder under src/pack), e.g. 'seville'. */
  id: string;
  /** The city as the guide names it: "Seville". */
  name: string;
  /** The city's own name, small on its card: "Sevilla". */
  localName?: string;
  country: string;
  /** The card's photo (a bundled asset); a drawn dusk sky without one. */
  photo?: number;
  /** What the preparation put in the pack (prepared.json, with the pack's own counts). */
  prepared: PackPrepared;
  /** Other names someone might type for it: "Sevilla", "Séville". */
  aliases?: string[];
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
