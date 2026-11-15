import React from 'react';
import { Text, View } from 'react-native';
import type { WelcomeProps } from './types';

// Placeholder: replaced by the Dusk Welcome screen.
export function WelcomeScreen({ city, onStart }: WelcomeProps) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0E0F14' }}>
      <Text style={{ color: '#F4EFE8' }} onPress={onStart}>Welcome to {city}</Text>
    </View>
  );
}
