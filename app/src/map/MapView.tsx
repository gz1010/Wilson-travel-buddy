import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { GeoPoint } from '../core/types';
import { aerial, buildMapHtml, hasAerial, MAP_PALETTES, type MapLayer, type MapTheme } from './mapHtml';

export interface MapPin {
  id: string;
  name: string;
  lat: number;
  lon: number;
  kind: 'place' | 'stop' | 'rec';
  badge?: string;
  focus?: boolean;
}

/** Room in pixels for the glass over each edge of the map; fits keep what they show inside it. */
export interface MapPadding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface Props {
  bounds: [number, number, number, number];
  pins: MapPin[];
  you?: GeoPoint;
  /** How sure the position is, in metres: drawn as a soft ring around you. Leave out for a point you set. */
  youAccuracy?: number;
  /** Changing this moves the map to the pin. */
  focusId?: string;
  /** Changing this (any new number) recentres the map on you. */
  recenterKey?: number;
  /** 'dusk': dark map, glass pins, and a dashed line from you to the chosen place. */
  theme?: MapTheme;
  /** Dusk only: the base map. Aerial needs scripts/build-aerial.mjs (hasAerial); without it, dark. */
  layer?: MapLayer;
  padding?: MapPadding;
  onPress?: (point: GeoPoint) => void;
  onSelect?: (id: string) => void;
}

/** MapLibre GL JS in a web view, fully offline. See mapHtml.ts. */
export function MapView({ bounds, pins, you, youAccuracy, focusId, recenterKey, theme = 'classic', layer = 'dark', padding, onPress, onSelect }: Props) {
  // react-native-webview types default P to undefined, which makes WebViewProps & P never; pass {}.
  const ref = useRef<WebView<{}>>(null);
  const [ready, setReady] = useState(false);
  const lastFocus = useRef<string | undefined>(undefined);
  const lastRecenter = useRef(recenterKey);
  // The page starts on the layer chosen when it was built; later changes go through buddyLayer, so
  // switching layers never reloads the page (or loses where the map is looking).
  const firstLayer = useRef(layer).current;
  const html = useMemo(() => buildMapHtml(bounds, theme, { layer: firstLayer }), [bounds, theme, firstLayer]);

  useEffect(() => {
    if (!ready) return;
    const focusPin = focusId ? pins.find(p => p.id === focusId) : undefined;
    const flyTo = focusPin && focusId !== lastFocus.current ? { lat: focusPin.lat, lon: focusPin.lon } : undefined;
    lastFocus.current = focusId;
    const recenter = recenterKey !== lastRecenter.current;
    lastRecenter.current = recenterKey;
    const route = theme === 'dusk' && you && focusPin ? [[you.lon, you.lat], [focusPin.lon, focusPin.lat]] : undefined;
    const accuracy = you && youAccuracy && youAccuracy > 0 ? Math.round(youAccuracy) : undefined;
    const state = { pins: pins.map(p => ({ ...p, focus: p.id === focusId })), you, accuracy, flyTo, route, recenter, padding };
    ref.current?.injectJavaScript(`window.buddyUpdate(${JSON.stringify(state)}); true;`);
  }, [ready, pins, you, youAccuracy, focusId, recenterKey, theme, padding]);

  useEffect(() => {
    if (ready && theme === 'dusk') ref.current?.injectJavaScript(`window.buddyLayer(${JSON.stringify(layer)}); true;`);
  }, [ready, theme, layer]);

  const onMessage = (e: WebViewMessageEvent) => {
    let m: any;
    try {
      m = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (m.type === 'ready') setReady(true);
    else if (m.type === 'press') onPress?.({ lat: m.lat, lon: m.lon });
    else if (m.type === 'select') onSelect?.(m.id);
    else if (m.type === 'aerial') {
      // One aerial photo tile, as MapLibre asks for it (base64 is safe inside a JS string).
      const b64 = typeof m.key === 'string' ? aerial.tiles?.[m.key] : undefined;
      ref.current?.injectJavaScript(`window.buddyAerialTile(${Number(m.id)}, ${typeof b64 === 'string' ? `"${b64}"` : 'null'}); true;`);
    } else if (m.type === 'log') console.warn('[map]', m.message);
  };

  return (
    <View style={[styles.wrap, { backgroundColor: theme === 'dusk' ? MAP_PALETTES[layer === 'aerial' && !hasAerial ? 'dark' : layer].bg : MAP_PALETTES.classic.bg }]}>
      <WebView<{}>
        ref={ref}
        originWhitelist={['*']}
        source={{ html, baseUrl: 'about:blank' }}
        onMessage={onMessage}
        javaScriptEnabled
        style={styles.web}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, borderRadius: 12, overflow: 'hidden' },
  web: { flex: 1, backgroundColor: 'transparent' },
});
