import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { colors } from './theme';

export function Loading({ status }: { status: string }) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Travel Buddy</Text>
      <Text style={styles.sub}>Your offline travel companion</Text>
      <ActivityIndicator style={{ marginTop: 24 }} />
      <Text style={styles.status}>{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  title: { fontSize: 32, fontWeight: '800', color: colors.ink },
  sub: { fontSize: 15, color: colors.muted, marginTop: 4 },
  status: { marginTop: 12, fontSize: 13, color: colors.muted },
});
