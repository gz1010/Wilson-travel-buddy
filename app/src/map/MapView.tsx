import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { GeoPoint } from '../core/types';
import { buildMapHtml } from './mapHtml';

export interface MapPin {
  id: string;
  name: string;
  lat: number;
  lon: number;
  kind: 'place' | 'stop' | 'rec';
  badge?: string;
  focus?: boolean;
}

interface Props {
  bounds: [number, number, number, number];
  pins: MapPin[];
  you?: GeoPoint;
  /** Changing this moves the map to the pin. */
  focusId?: string;
  onPress?: (point: GeoPoint) => void;
  onSelect?: (id: string) => void;
}

/** MapLibre GL JS in a web view, fully offline. See mapHtml.ts. */
export function MapView({ bounds, pins, you, focusId, onPress, onSelect }: Props) {
  // react-native-webview types default P to undefined, which makes WebViewProps & P never; pass {}.
  const ref = useRef<WebView<{}>>(null);
  const [ready, setReady] = useState(false);
  const lastFocus = useRef<string | undefined>(undefined);
  const html = useMemo(() => buildMapHtml(bounds), [bounds]);

  useEffect(() => {
    if (!ready) return;
    const focusPin = focusId ? pins.find(p => p.id === focusId) : undefined;
    const flyTo = focusPin && focusId !== lastFocus.current ? { lat: focusPin.lat, lon: focusPin.lon } : undefined;
    lastFocus.current = focusId;
    const state = { pins: pins.map(p => ({ ...p, focus: p.id === focusId })), you, flyTo };
    ref.current?.injectJavaScript(`window.buddyUpdate(${JSON.stringify(state)}); true;`);
  }, [ready, pins, you, focusId]);

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
    else if (m.type === 'log') console.warn('[map]', m.message);
  };

  return (
    <View style={styles.wrap}>
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
  wrap: { flex: 1, borderRadius: 12, overflow: 'hidden', backgroundColor: '#efe9df' },
  web: { flex: 1, backgroundColor: 'transparent' },
});
