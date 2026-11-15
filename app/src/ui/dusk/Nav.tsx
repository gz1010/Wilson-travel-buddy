import React from 'react';
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Glass, onGlass } from './Glass';
import { MicIcon } from './Icons';
import { dusk, font, white } from './tokens';

export type ScreenName = 'welcome' | 'setup' | 'now' | 'place' | 'map' | 'talk';

export interface Nav {
  screen: ScreenName;
  go(screen: ScreenName): void;
  /** Opens the Place screen for a pack place. */
  openPlace(placeId: string): void;
  placeId?: string;
}

/** The mic orb: tap to talk, tap again to stop. Shows live bars while listening. */
export function MicOrb({ listening, onPress, size = dusk.size.orb, style }: { listening: boolean; onPress: () => void; size?: number; style?: StyleProp<ViewStyle> }) {
  const bar = (h: number) => <View style={{ width: Math.max(3, size / 16), height: h, borderRadius: 3, backgroundColor: '#fff' }} />;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={listening ? 'Stop listening' : 'Ask your buddy'} onPress={onPress} style={style}>
      <Glass
        kind="orb"
        radius={size / 2}
        style={[
          { width: size, height: size, alignItems: 'center', justifyContent: 'center' },
          listening && { shadowColor: '#fff', shadowOpacity: 0.25, shadowRadius: size / 3 },
        ]}>
        {listening ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            {bar(size * 0.19)}
            {bar(size * 0.35)}
            {bar(size * 0.25)}
            {bar(size * 0.13)}
          </View>
        ) : (
          <MicIcon size={size * 0.43} />
        )}
      </Glass>
    </Pressable>
  );
}

const TABS: { screen: ScreenName; label: string }[] = [
  { screen: 'now', label: 'Now' },
  { screen: 'map', label: 'Map' },
  { screen: 'setup', label: 'Plan' },
  { screen: 'talk', label: 'Talk' },
];

/** The floating glass tab bar: Now · Map · Plan · Talk, and the mic orb. */
export function TabBar({ nav, listening, onMic, style }: { nav: Nav; listening: boolean; onMic: () => void; style?: StyleProp<ViewStyle> }) {
  return (
    <View pointerEvents="box-none" style={[{ position: 'absolute', left: 0, right: 0, bottom: 26, alignItems: 'center' }, style]}>
      <Glass kind="clear" radius={999} style={{ flexDirection: 'row', alignItems: 'center', padding: 6, gap: 2 }}>
        {TABS.map(t => {
          const on = nav.screen === t.screen;
          return (
            <Pressable
              key={t.screen}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              onPress={() => nav.go(t.screen)}
              style={{ minHeight: dusk.size.touch, justifyContent: 'center', paddingHorizontal: on ? 16 : 14, borderRadius: 999, backgroundColor: on ? white(0.18) : 'transparent', borderTopWidth: on ? 1 : 0, borderTopColor: white(0.55) }}>
              <Text style={[on ? onGlass : { color: dusk.color.textSoft }, font(on ? '700' : '600'), { fontSize: 13 }]}>{t.label}</Text>
            </Pressable>
          );
        })}
        <MicOrb listening={listening} onPress={onMic} />
      </Glass>
    </View>
  );
}
