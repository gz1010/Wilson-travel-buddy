import { StyleSheet } from 'react-native';

export const colors = {
  bg: '#f6f2ea',
  panel: '#ffffff',
  ink: '#1f1d1a',
  muted: '#7a7268',
  line: '#e7e0d4',
  accent: '#e4572e', // recommendations
  green: '#2d6a4f', // itinerary
  blue: '#1d7cf2', // you
  soft: '#f1ebe0',
  danger: '#b42318',
};

export const ui = StyleSheet.create({
  panel: { backgroundColor: colors.panel, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: colors.line },
  h2: { fontSize: 13, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 },
  body: { fontSize: 14, color: colors.ink, lineHeight: 20 },
  small: { fontSize: 12, color: colors.muted },
  row: { flexDirection: 'row', alignItems: 'center' },
  chip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: colors.soft, marginRight: 6, marginBottom: 6 },
  chipText: { fontSize: 12, color: colors.ink, fontWeight: '600' },
  button: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, backgroundColor: colors.ink },
  buttonText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  ghost: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: colors.line },
  ghostText: { color: colors.ink, fontSize: 12, fontWeight: '600' },
});
