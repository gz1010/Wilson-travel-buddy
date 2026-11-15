import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useBox } from './Gradient';
import { liquidGlassPage, type LiquidGlassLine } from './liquidGlassPage';
import { dusk } from './tokens';

export type { LiquidGlassLine };

/** The font the glass letters are cut from, as a bundled asset (required lazily: tests can't load a .ttf). */
function fontAsset(): number {
  return require('../../../assets/fonts/Manrope_800ExtraBold.ttf');
}

/** Jest has no web view, fetch or font assets: keep the fallback there. */
function inTests(): boolean {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NODE_ENV === 'test';
}

const dataUris = new Map<number, Promise<string>>();

/**
 * A bundled asset as a data: URI, for the glass page (it has no file access). Local only: in a
 * debug build the asset comes from Metro on this Mac, in a release build from the app bundle.
 */
function assetDataUri(asset: number): Promise<string> {
  let p = dataUris.get(asset);
  if (!p) {
    const uri = Image.resolveAssetSource(asset)?.uri;
    p = uri
      ? fetch(uri)
          .then(r => r.blob())
          .then(
            blob =>
              new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(new Error('read'));
                reader.readAsDataURL(blob);
              }),
          )
      : Promise.reject(new Error('no asset'));
    p.catch(() => dataUris.delete(asset));
    dataUris.set(asset, p);
  }
  return p;
}

/**
 * A photo with words in 3D liquid glass over it (liquidGlassPage.ts: refraction, dispersion,
 * frost, rim light, an extruded side and a shadow), in a small offline web view. Fills its box.
 * `fallback` (the same photo and words drawn natively) shows until the glass has rendered, and
 * stays if it can't (no photo, no WebGL, tests). The web view never takes clicks unless
 * `interactive`, in which case the light follows the pointer.
 */
export function LiquidGlass({
  photo,
  lines,
  align = 'center',
  inset = 0,
  fade,
  interactive = false,
  fallback,
  style,
}: {
  photo: number | undefined;
  lines: LiquidGlassLine[];
  align?: 'center' | 'left';
  inset?: number;
  fade: [number, number][];
  interactive?: boolean;
  fallback?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const box = useBox();
  const [assets, setAssets] = useState<{ photo: string; font: string } | null>(null);
  const [ready, setReady] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (photo === undefined || inTests()) return;
    let live = true;
    try {
      Promise.all([assetDataUri(photo), assetDataUri(fontAsset())])
        .then(([p, f]) => live && setAssets({ photo: p, font: f }))
        .catch(() => {});
    } catch {
      // No glass: the fallback stays.
    }
    return () => {
      live = false;
    };
  }, [photo]);

  // Rebuilt only when what it draws changes, not on every render of the screen around it.
  const linesKey = JSON.stringify(lines);
  const fadeKey = JSON.stringify(fade);
  const html = useMemo(
    () =>
      box.size && assets
        ? liquidGlassPage({
            width: box.size.width,
            height: box.size.height,
            photo: assets.photo,
            font: assets.font,
            lines: JSON.parse(linesKey),
            align,
            inset,
            tracking: dusk.font.placeName.tracking,
            fade: JSON.parse(fadeKey),
          })
        : null,
    [box.size, assets, linesKey, fadeKey, align, inset],
  );

  useEffect(() => {
    setReady(false);
    opacity.setValue(0);
  }, [html, opacity]);

  const onMessage = (e: WebViewMessageEvent) => {
    const m = e.nativeEvent.data;
    if (m === 'ready') {
      Animated.timing(opacity, { toValue: 1, duration: 260, useNativeDriver: true }).start(() => setReady(true));
    } else if (m.startsWith('error:')) {
      console.warn('[liquid glass]', m.slice(6));
    }
  };

  return (
    <View pointerEvents={interactive ? 'box-none' : 'none'} style={[StyleSheet.absoluteFill, style]} onLayout={box.onLayout}>
      {!ready ? fallback : null}
      {html ? (
        <Animated.View pointerEvents={interactive ? 'auto' : 'none'} style={[StyleSheet.absoluteFill, { opacity }]}>
          <WebView<{}>
            key={box.key}
            originWhitelist={['*']}
            source={{ html, baseUrl: 'about:blank' }}
            onMessage={onMessage}
            javaScriptEnabled
            scrollEnabled={false}
            style={styles.web}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: dusk.color.ground },
});
