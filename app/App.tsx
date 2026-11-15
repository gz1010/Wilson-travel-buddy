import React, { useEffect, useMemo, useState } from 'react';
import { PackIndex } from './src/core/pack';
import { seville } from './src/pack/seville';
import { connectRuntime, type Runtime } from './src/services/runtime';
import { Home } from './src/ui/Home';
import { Loading } from './src/ui/Loading';
import { useBuddy } from './src/ui/useBuddy';
import { DuskRoot } from './src/ui/DuskRoot';
import { UI_DESIGN } from './src/config';

export default function App() {
  const index = useMemo(() => new PackIndex(seville), []);
  const [runtime, setRuntime] = useState<Runtime>();
  const [status, setStatus] = useState('Starting…');

  useEffect(() => {
    if (UI_DESIGN === 'classic') connectRuntime(setStatus).then(setRuntime);
  }, []);

  // The Dusk liquid-glass design (iOS). It connects to the helpers itself, from its Welcome screen.
  if (UI_DESIGN === 'dusk') return <DuskRoot index={index} />;

  if (!runtime) return <Loading status={status} />;
  return <Ready runtime={runtime} index={index} />;
}

function Ready({ runtime, index }: { runtime: Runtime; index: PackIndex }) {
  const b = useBuddy(runtime, index);
  return <Home b={b} />;
}
