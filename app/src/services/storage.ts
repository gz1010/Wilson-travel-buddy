import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Trip } from '../core/types';

const TRIP_KEY = 'travelbuddy.trip.v1';
const VISITED_KEY = 'travelbuddy.visited.v1';

export async function loadTrip(): Promise<Trip | undefined> {
  const raw = await AsyncStorage.getItem(TRIP_KEY);
  return raw ? (JSON.parse(raw) as Trip) : undefined;
}

export async function saveTrip(trip: Trip | undefined): Promise<void> {
  if (trip) await AsyncStorage.setItem(TRIP_KEY, JSON.stringify(trip));
  else await AsyncStorage.removeItem(TRIP_KEY);
}

export async function loadVisited(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(VISITED_KEY);
  return raw ? (JSON.parse(raw) as string[]) : [];
}

export async function saveVisited(ids: string[]): Promise<void> {
  await AsyncStorage.setItem(VISITED_KEY, JSON.stringify(ids));
}
