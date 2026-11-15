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
}
