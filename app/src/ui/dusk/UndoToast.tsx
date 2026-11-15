import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { axPress, Glass, onGlass } from './Glass';
import { dusk, font, ground } from './tokens';

/** What the last change to the plan was, and how to take it back. */
export interface UndoNote {
  text: string;
  undo?: () => void;
  /** What the change left (the trip): if `current` stops being this, the note goes. */
  after?: unknown;
}

/**
 * A short "Added Plaza Nueva to Mon 16 · Undo" message after a change to the plan: show() puts it
 * up for 6 s (a newer one replaces it), hide() takes it down.
 */
export function useUndo(current?: unknown) {
  const [note, setNote] = useState<UndoNote | undefined>();
  const noteRef = useRef(note);
  noteRef.current = note;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setNote(undefined);
  }, []);
  const show = useCallback((text: string, undo?: () => void, after?: unknown) => {
    if (timer.current) clearTimeout(timer.current);
    setNote({ text, undo, after });
    timer.current = setTimeout(() => setNote(undefined), 6000);
  }, []);
  // Changed since by voice, Chat or an import: undoing would throw that away, so the offer goes.
  useEffect(() => {
    const n = noteRef.current;
    if (n?.after !== undefined && current !== n.after) hide();
  }, [current, hide]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return { note, show, hide };
}

/** The message, floating `bottom` px above the window's foot (over the tab bar's reserve). */
export function UndoToast({ undo, bottom }: { undo: ReturnType<typeof useUndo>; bottom: number }) {
  const { note, hide } = undo;
  if (!note) return null;
  const takeBack = () => {
    note.undo?.();
    hide();
  };
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom }]}>
      <Glass kind="clear" radius={999} wash={ground(0.78)} style={styles.toast}>
        <Text style={[onGlass, font('600'), styles.text]} numberOfLines={1} accessibilityLiveRegion="polite">
          {note.text}
        </Text>
        {note.undo ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Undo" onPress={takeBack} {...axPress(takeBack)} hitSlop={12} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
            <Text style={[styles.undo, font('800')]}>Undo</Text>
          </Pressable>
        ) : null}
      </Glass>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  toast: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingLeft: 18, paddingRight: 16, height: 44, maxWidth: 380 },
  text: { fontSize: 13.5, flexShrink: 1 },
  undo: { fontSize: 13.5, color: dusk.color.white, textDecorationLine: 'underline' },
});
