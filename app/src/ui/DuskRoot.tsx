import React, { useEffect, useMemo, useState } from 'react';
import { StatusBar } from 'react-native';
import type { PackIndex } from '../core/pack';
import { connectRuntime, type Runtime } from '../services/runtime';
import { TabBar, type Nav, type ScreenName } from './dusk/Nav';
import { ScreenSizeProvider } from './dusk/Screen';
import { dusk } from './dusk/tokens';
import { LookScreen } from './screens/LookScreen';
import { MapScreen } from './screens/MapScreen';
import { NowScreen } from './screens/NowScreen';
import { PlaceScreen } from './screens/PlaceScreen';
import { SetupScreen } from './screens/SetupScreen';
import { TalkScreen } from './screens/TalkScreen';
import type { PreparedPack, WelcomeProps } from './screens/types';
import { WelcomeScreen } from './screens/WelcomeScreen';
import { useBuddy } from './useBuddy';

// What scripts/prepare-pack.mjs downloaded for the pack while online (Welcome shows it).
const prepared = require('../pack/seville/prepared.json') as PreparedPack;

/**
 * The Dusk · liquid glass app (iOS). Welcome connects to Bonsai-2 and the Argmax helper while it
 * shows; the main screens switch with a small state machine, no navigation library.
 */
export function DuskRoot({ index }: { index: PackIndex }) {
  const [runtime, setRuntime] = useState<Runtime>();
  const [status, setStatus] = useState('Starting…');
  const [started, setStarted] = useState(false);

  useEffect(() => {
    connectRuntime(setStatus).then(setRuntime);
  }, []);

  if (!runtime || !started) {
    const steps: WelcomeProps['steps'] = [
      { label: `${index.destination.name} guide`, state: 'ready' },
      { label: runtime ? runtime.llm.name : 'Bonsai-2', state: !runtime ? 'loading' : runtime.live.llm ? 'ready' : 'off' },
      { label: 'Listening', state: !runtime ? 'loading' : runtime.live.audio ? 'ready' : 'off' },
      { label: 'Voices', state: !runtime ? 'loading' : runtime.live.audio ? 'ready' : 'off' },
    ];
    return (
      <ScreenSizeProvider style={{ backgroundColor: dusk.color.ground }}>
        <StatusBar barStyle="light-content" />
        <WelcomeScreen
          city={index.destination.name}
          steps={steps}
          status={status}
          models={runtime ? [runtime.llm.name, ...runtime.audio.info.models] : undefined}
          ready={!!runtime}
          onStart={() => setStarted(true)}
          prepared={prepared}
        />
      </ScreenSizeProvider>
    );
  }
  return <DuskApp runtime={runtime} index={index} />;
}

const TAB_BAR_SCREENS: ScreenName[] = ['now', 'map', 'talk', 'look'];

function DuskApp({ runtime, index }: { runtime: Runtime; index: PackIndex }) {
  const b = useBuddy(runtime, index);
  const [screen, setScreen] = useState<ScreenName>('setup');
  const [placeId, setPlaceId] = useState<string>();
  const [decided, setDecided] = useState(false);

  // First screen, once the saved trip has been read: the plan if there is none, otherwise Now.
  useEffect(() => {
    if (decided || !b.tripLoaded) return;
    setScreen(b.trip ? 'now' : 'setup');
    setDecided(true);
  }, [b.trip, b.tripLoaded, decided]);

  // "Translate for me" by voice opens Translate (the talk screen).
  useEffect(() => {
    if (b.mode === 'translator') {
      setScreen('talk');
      b.setMode('home');
    }
  }, [b, b.mode]);

  const nav: Nav = useMemo(
    () => ({
      screen,
      placeId,
      go: s => setScreen(s),
      openPlace: id => {
        setPlaceId(id);
        b.setFocusId(id);
        setScreen('place');
      },
    }),
    [screen, placeId, b],
  );

  return (
    <ScreenSizeProvider style={{ backgroundColor: dusk.color.ground }}>
      <StatusBar barStyle="light-content" />
      {screen === 'setup' && <SetupScreen b={b} nav={nav} />}
      {screen === 'now' && <NowScreen b={b} nav={nav} />}
      {screen === 'place' && <PlaceScreen b={b} nav={nav} />}
      {screen === 'map' && <MapScreen b={b} nav={nav} />}
      {screen === 'talk' && <TalkScreen b={b} nav={nav} />}
      {screen === 'look' && <LookScreen b={b} nav={nav} />}
      {/* No mic orb on Translate: the conversation already has the microphone. */}
      {TAB_BAR_SCREENS.includes(screen) && <TabBar nav={nav} listening={b.listening} onMic={b.talk} showMic={screen !== 'talk'} />}
    </ScreenSizeProvider>
  );
}
