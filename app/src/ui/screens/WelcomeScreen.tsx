import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { Glass, GlassButton, OfflineChip } from '../dusk/Glass';
import { useReduceMotion } from '../dusk/motion';
import { HeroPhoto, PhotoFade } from '../dusk/Photos';
import { dusk, font, white } from '../dusk/tokens';
import type { WelcomeProps } from './types';
import { useScreenSize } from '../dusk/Screen';

// AntWelcome: the city at dusk, a welcome, and the on-device models getting ready on clear glass.
// Positions come from the 390 × 844 mockup: horizontal ones scale with the width, and the lower
// block (title, models, button) keeps its distance from the bottom so it fits any phone height.

const W = dusk.layout.phoneWidth;
const H = dusk.layout.phoneHeight;

type Step = WelcomeProps['steps'][number];

export function WelcomeScreen({ city, steps, status, models, ready, onStart }: WelcomeProps) {
  const { width, height } = useScreenSize();
  const sx = width / W;
  // Shift for everything below the photo's middle: positive on taller phones, negative on shorter.
  const dy = height - H;

  return (
    <View style={styles.root}>
      {/* Full-bleed dusk photo, about 700 px tall, with the mockup's dark fades. */}
      <HeroPhoto tod="dusk" style={{ position: 'absolute', left: 0, top: 0, width, height: Math.max(0, 700 + dy) }} />
      <PhotoFade
        stops={[
          [0, 0.35],
          [0.18, 0],
          [0.48, 0],
          [0.66, 0.75],
          [0.82, 1],
          [1, 1],
        ]}
      />

      <View style={[styles.chipRow, { top: 58 }]} pointerEvents="none">
        <OfflineChip />
      </View>

      <View style={{ position: 'absolute', left: 28 * sx, right: 28 * sx, top: 470 + dy, alignItems: 'center' }}>
        <Text accessibilityRole="header" style={styles.title} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.6}>
          {`Welcome\nto ${city}`}
        </Text>
        <Text style={[styles.subtitle, { maxWidth: 300 * sx }]}>
          {`All of ${city} on this phone, and a guide that never needs a signal.`}
        </Text>
      </View>

      <View style={{ position: 'absolute', left: 22 * sx, right: 22 * sx, top: 640 + dy }}>
        <Glass kind="clear" radius={22} style={styles.grid}>
          <View accessible accessibilityLabel={`Getting ready: ${steps.map(describe).join(', ')}`} style={styles.gridInner}>
            {steps.map(s => (
              <View key={s.label} style={styles.cell}>
                <StepDot state={s.state} />
                <Text numberOfLines={1} style={[styles.cellText, s.state === 'off' && { color: dusk.color.text2 }]}>
                  {s.state === 'off' ? `${s.label} (off)` : s.label}
                </Text>
              </View>
            ))}
          </View>
        </Glass>
        {/* While connecting: the latest status. Once ready: every on-device model by name. */}
        {!ready ? (
          <Text numberOfLines={2} style={styles.status} accessibilityLiveRegion="polite">
            {status}
          </Text>
        ) : models && models.length > 0 ? (
          <Text numberOfLines={2} style={styles.status} accessibilityLabel={`On this phone: ${models.join(', ')}`}>
            {/* "(Argmax)" once at the end rather than after every audio model, so the line fits. */}
            {models.map(m => m.replace(/\s*\(Argmax\)$/, '')).join(' · ')}
            {models.some(m => /\(Argmax\)$/.test(m)) ? ' · Argmax' : ''}
          </Text>
        ) : null}
      </View>

      <View style={[styles.buttonRow, { bottom: 34 }]}>
        <GlassButton
          label="Get started"
          onPress={onStart}
          disabled={!ready}
          accessibilityLabel={ready ? 'Get started' : 'Get started, available once the models are ready'}
          style={{ width: 230 }}
          textStyle={{ fontSize: 16 }}
        />
      </View>
    </View>
  );
}

function describe(s: Step): string {
  return `${s.label} ${s.state === 'ready' ? 'ready' : s.state === 'loading' ? 'loading' : 'off'}`;
}

/** Ready: a solid glowing white dot. Loading: a ring that pulses. Off: a hollow, dim ring. */
function StepDot({ state }: { state: Step['state'] }) {
  const reduce = useReduceMotion();
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (state !== 'loading' || reduce) {
      pulse.stopAnimation();
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [state, reduce, pulse]);

  if (state === 'ready') return <View style={styles.dotReady} />;
  if (state === 'off') return <View style={[styles.ring, { borderColor: white(0.35) }]} />;
  const scale = pulse.interpolate({ inputRange: [0.35, 1], outputRange: [0.8, 1] });
  return <Animated.View style={[styles.ring, { opacity: pulse, transform: [{ scale }] }]} />;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: dusk.color.ground, overflow: 'hidden' },
  chipRow: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  title: {
    ...font('300'),
    fontSize: dusk.font.welcome.size,
    letterSpacing: dusk.font.welcome.letterSpacing,
    lineHeight: dusk.font.welcome.size,
    color: dusk.color.text,
    textAlign: 'center',
  },
  subtitle: {
    ...font('500'),
    marginTop: 14,
    fontSize: 15,
    lineHeight: 22,
    color: dusk.color.textSoft,
    textAlign: 'center',
  },
  grid: { paddingVertical: 12, paddingHorizontal: 16 },
  gridInner: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 8, columnGap: 14 },
  // Two columns: half the row minus half the 14 px column gap.
  cell: { width: '47%', flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 16 },
  cellText: { ...font('600'), fontSize: 12, color: dusk.color.text, flexShrink: 1 },
  dotReady: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: dusk.color.white,
    shadowColor: dusk.color.white,
    shadowOpacity: 0.6,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 0 },
  },
  ring: { width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: white(0.7) },
  status: { ...font('500'), marginTop: 8, fontSize: 11, lineHeight: 15, color: dusk.color.text2, textAlign: 'center' },
  buttonRow: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
});
