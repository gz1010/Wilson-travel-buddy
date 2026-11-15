import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { StatusBar } from 'react-native';
import type { PackIndex } from '../core/pack';
import packPrepared from '../pack/seville/prepared.json';
import { heroPhotos } from '../pack/seville/photos';
import { connectRuntime, type Runtime } from '../services/runtime';
import { FloatingBuddy } from './dusk/Buddy';
import { cityFromPack } from './dusk/CityCard';
import { HOME, TabBar, type Nav, type ScreenName } from './dusk/Nav';
import { ScreenSizeProvider } from './dusk/Screen';
import { dusk } from './dusk/tokens';
import { MapScreen } from './screens/MapScreen';
import { NowScreen } from './screens/NowScreen';
import { PlaceScreen } from './screens/PlaceScreen';
import { SetupScreen } from './screens/SetupScreen';
import { LookScreen } from './screens/LookScreen';
import { TalkScreen } from './screens/TalkScreen';
import type { KnownCity } from './screens/types';
import { WelcomeScreen } from './screens/WelcomeScreen';
import { noteTouch } from './touches';
import { useBuddy, type Buddy } from './useBuddy';

/**
 * The Dusk · liquid glass app (macOS). It opens on the home (WelcomeScreen: Wilson, the cities he
 * knows, Plan your next journey) while it connects to Bonsai-2 and the Argmax helper; a city's card
 * opens its guide (Now), and the city's name in Now's header leads back home. The screens switch
 * with a small state machine, no navigation library.
 */
export function DuskRoot({ index }: { index: PackIndex }) {
  const [runtime, setRuntime] = useState<Runtime>();
  const [status, setStatus] = useState('Starting…');
  /** The app state, once the runtime is connected (BuddyHost hands it up). */
  const [b, setB] = useState<Buddy>();
  const [screen, setScreen] = useState<ScreenName>(HOME);
  const [placeId, setPlaceId] = useState<string>();
  /** A city tapped before Wilson was awake (or before the saved trip was read): opened as soon as he is. */
  const [opening, setOpening] = useState<string>();

  useEffect(() => {
    connectRuntime(setStatus).then(setRuntime);
  }, []);

  // The cities Wilson knows: the pack this build runs (Seville). More packs add cards here.
  const cities = useMemo<KnownCity[]>(() => [cityFromPack(index, packPrepared, CITY_EXTRAS[index.destination.id])], [index]);

  // Open the city once Wilson is awake and the saved trip has been read (Now would show without it first).
  const tripLoaded = !!b?.tripLoaded;
  useEffect(() => {
    if (!opening || !tripLoaded) return;
    setOpening(undefined);
    setScreen('now');
  }, [opening, tripLoaded]);

  const openCity = useCallback(
    (id: string) => {
      // Only the pack this build runs has a guide to open.
      if (id === index.destination.id) setOpening(id);
    },
    [index],
  );

  // "Translate for me" by voice opens Translate.
  useEffect(() => {
    if (b?.mode === 'translator') {
      setScreen('talk');
      b.setMode('home');
    }
  }, [b, b?.mode]);

  const nav: Nav = useMemo(
    () => ({
      screen,
      placeId,
      go: s => setScreen(s),
      openPlace: id => {
        setPlaceId(id);
        b?.setFocusId(id);
        setScreen('place');
      },
    }),
    [screen, placeId, b],
  );

  return (
    // noteTouch: where touches start, so the map can tell its own taps from clicks on controls over it (ui/touches.ts).
    <ScreenSizeProvider style={{ backgroundColor: dusk.color.ground }} onStartShouldSetResponderCapture={noteTouch}>
      <StatusBar barStyle="light-content" />
      {runtime ? <BuddyHost runtime={runtime} index={index} onBuddy={setB} /> : null}
      {/* The home keeps its place in the tree from launch, through Wilson waking up, until a city opens. */}
      {screen === HOME || !b ? (
        <WelcomeScreen
          cities={cities}
          onOpenCity={openCity}
          opening={opening}
          status={status}
          models={runtime ? [runtime.llm.name, ...runtime.audio.info.models] : undefined}
          b={b}
        />
      ) : (
        <CityScreens b={b} nav={nav} screen={screen} />
      )}
      {/* Over everything, on every screen of a city's guide; it hides itself on Chat and Translate, and on the home (Wilson is on it). */}
      {b ? (
        <FloatingBuddy
          b={b}
          visible={screen !== HOME && !NO_BUDDY_SCREENS.includes(screen)}
          yieldMicrophone={screen === 'talk'}
          keepClear={screen === 'map' ? MAP_KEEP_CLEAR : 0}
        />
      ) : null}
    </ScreenSizeProvider>
  );
}

/**
 * What a pack's destination.json doesn't say about its city, by pack id: its own name, the card's
 * photo, other spellings. The card's photo is the city's postcard, a wide one (the card is wide):
 * Seville's is the Plaza de España under a blue sky (the dusk photo is a tall tower, and the card
 * cropped it to grey sky).
 */
const CITY_EXTRAS: Record<string, Pick<KnownCity, 'localName' | 'photo' | 'aliases'>> = {
  seville: { localName: 'Sevilla', photo: heroPhotos.midday ?? heroPhotos.dusk, aliases: ['Sevilla', 'Séville', 'Sevilha', 'Siviglia'] },
};

/**
 * Runs useBuddy once the runtime is connected and hands each new state up to DuskRoot, so the home
 * stays the same mounted screen from before the models are ready to after (what was typed, the
 * photo and the glass letters don't reload when Wilson wakes up). Memo'd with stable props, so a
 * DuskRoot render alone never re-renders it and handing the state up can't loop.
 */
const BuddyHost = React.memo(function BuddyHost({ runtime, index, onBuddy }: { runtime: Runtime; index: PackIndex; onBuddy: (b: Buddy) => void }) {
  const b = useBuddy(runtime, index);
  useLayoutEffect(() => onBuddy(b), [b, onBuddy]);
  return null;
});

/**
 * Screens that show the floating tab bar (Now · Map · Chat · Translate · Scan); each leaves its
 * bottom ~100 px free for it. Place is a detail screen with its own close button.
 */
const TAB_BAR_SCREENS: ScreenName[] = ['now', 'map', 'setup', 'talk', 'look'];

/**
 * Screens without the floating buddy: Chat ('setup') is the whole conversation already, and
 * Translate ('talk') runs its own Argmax conversation, which needs the microphone to itself.
 * Place has its own mic orb in its footer, whose answer lands in the place's guide card; a second
 * orb floating over its photo only competed with it. On Now Wilson rides the timeline's "now"
 * line himself (NowScreen), so there is only one of him.
 */
const NO_BUDDY_SCREENS: ScreenName[] = ['setup', 'talk', 'place', 'now'];

/**
 * On the Map the floating Wilson rests above the place card and the Locate row over it (the card
 * sits 104 px up and is about 262 px tall, the row 12 + 40 above it; he normally rests down to 96
 * px up): lower, he covered the card's photo, or its About button from his home spot.
 */
const MAP_KEEP_CLEAR = 330;

/** A city's guide: its screens and the tab bar between them. */
function CityScreens({ b, nav, screen }: { b: Buddy; nav: Nav; screen: ScreenName }) {
  return (
    <>
      {screen === 'setup' && <SetupScreen b={b} nav={nav} />}
      {screen === 'now' && <NowScreen b={b} nav={nav} />}
      {screen === 'place' && <PlaceScreen b={b} nav={nav} />}
      {screen === 'map' && <MapScreen b={b} nav={nav} />}
      {screen === 'talk' && <TalkScreen b={b} nav={nav} />}
      {screen === 'look' && <LookScreen b={b} nav={nav} />}
      {/* Stays mounted from tab to tab (same place in the tree), so its glass lens can slide. */}
      {TAB_BAR_SCREENS.includes(screen) && <TabBar nav={nav} />}
    </>
  );
}
