import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, NativeModules, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import * as itineraryImport from '../../core/itineraryImport';
import type { PackIndex } from '../../core/pack';
import { addDays, weekday, WEEKDAY_NAMES } from '../../core/time';
import type { Interest, LLMClient, Trip } from '../../core/types';
import type { Buddy } from '../useBuddy';
import { axPress, Glass, GlassButton, GlassIconButton, onGlass } from './Glass';
import { CloseIcon } from './Icons';
import { useScreenSize } from './Screen';
import { dusk, font, ground, white } from './tokens';

// Import an itinerary on Chat: paste it, open a file (.ics or text) or drop one on the screen.
// A calendar file is read in plain code, text goes through the trip planner a day at a time
// (core/itineraryImport.ts does both). The sheet shows what it found (days, stops, the names the
// guide doesn't know yet) before Apply makes it the trip. Opening and reading a file is native
// (BuddyFiles in AppDelegate.mm): React Native for macOS has no file picker. Nothing goes online.

// --- The importer (core/itineraryImport.ts), imported statically so tsc checks it against the API
// the sheet uses (the Importer interface below).

/** What the importers return. */
export interface ImportResult {
  trip: Trip;
  /** Place names the guide doesn't have yet (scripts/prepare-pack.mjs --itinerary adds them). */
  unmatched: string[];
  warnings: string[];
}

type Kind = 'ics' | 'text';

/** Its API, as the sheet uses it (the same shapes as IcsImportOptions and TextImportDeps there). */
interface Importer {
  detect(text: string): Kind;
  importIcs(text: string, index: PackIndex, opts?: { today?: string; interests?: Interest[]; fileName?: string }): ImportResult;
  importText(
    text: string,
    deps: {
      llm: LLMClient;
      index: PackIndex;
      today: string;
      /** Before the first model call and after each one. */
      onProgress?: (done: number, total: number) => void;
      /** Checked between model calls: Cancel sets it. */
      signal?: { readonly aborted: boolean };
    },
  ): Promise<ImportResult>;
}

/** Checked by tsc: the module's exports must fit Importer. */
const IMPORTER: Importer = itineraryImport;

function importer(): Importer | undefined {
  return typeof IMPORTER.importIcs === 'function' && typeof IMPORTER.importText === 'function' ? IMPORTER : undefined;
}

/** A calendar file or text (the importer's own detect() when it has one). */
function detectKind(text: string, api?: Importer): Kind {
  try {
    if (api && typeof api.detect === 'function') return api.detect(text) === 'ics' ? 'ics' : 'text';
  } catch {
    // fall through to the plain check
  }
  return /BEGIN:(VCALENDAR|VEVENT)\b/i.test(text) ? 'ics' : 'text';
}

// --- Files: the native module (AppDelegate.mm).

export interface PickedFile {
  name: string;
  text: string;
}

interface BuddyFilesModule {
  /** The open panel. Resolves the file's name and text, or null when cancelled. */
  pickText(types: string[]): Promise<PickedFile | null>;
  /** A file dropped on the window, by its path. */
  readText?(path: string, types: string[]): Promise<PickedFile>;
}

/** The kinds of file the panel offers and a drop accepts. */
export const FILE_TYPES = ['ics', 'ical', 'txt', 'text', 'md'];

/** The native module, or undefined (tests, an app built before it). Read at call time so tests can mock it. */
function buddyFiles(): BuddyFilesModule | undefined {
  const m = (NativeModules as { BuddyFiles?: BuddyFilesModule }).BuddyFiles;
  return m && typeof m.pickText === 'function' ? m : undefined;
}

/** A file dropped on Chat. */
export interface DroppedFile {
  path: string;
  name: string;
}

const extensionOf = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();

/** A file the sheet can read (.ics, .txt…), by its name. */
export const isItineraryFile = (name: string) => FILE_TYPES.includes(extensionOf(name));

/**
 * The first itinerary file in a drop event's dataTransfer (react-native-macos). Failing that, the
 * first file of another kind (a PDF, a photo), so the sheet can say it can't read it rather than
 * the drop doing nothing. Undefined when no file was dropped.
 */
export function droppedFile(event: unknown): DroppedFile | undefined {
  const files = (event as { nativeEvent?: { dataTransfer?: { files?: { name?: string; uri?: string }[] } } })?.nativeEvent?.dataTransfer?.files;
  if (!Array.isArray(files)) return undefined;
  let other: DroppedFile | undefined;
  for (const f of files) {
    const path = typeof f?.uri === 'string' ? f.uri : '';
    const name = typeof f?.name === 'string' && f.name ? f.name : path.split('/').pop() ?? '';
    if (!path || !name || path.startsWith('data:')) continue;
    if (isItineraryFile(name)) return { path, name };
    other ??= { path, name };
  }
  return other;
}

/**
 * Props that make a react-native-macos View a drop target for files (the iOS typings don't know
 * them). Spread on the screen's root view.
 */
export function fileDropProps(onFile: (file: DroppedFile | undefined) => void, onHover?: (over: boolean) => void): object {
  return {
    draggedTypes: ['fileUrl'],
    onDragEnter: () => onHover?.(true),
    onDragLeave: () => onHover?.(false),
    onDrop: (e: unknown) => {
      onHover?.(false);
      onFile(droppedFile(e));
    },
  };
}

// --- Words.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** What to run while online to add the missing places to the guide. */
export const PREPARE_COMMAND = 'node scripts/prepare-pack.mjs --itinerary <file>';
// react-native-macos draws a rectangular focus ring around a focused field; the iOS typings don't know the prop.
const NO_FOCUS_RING: object = { enableFocusRing: false };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "Thu 3 Dec" */
const dayLabel = (date: string) => `${WEEKDAY_NAMES[weekday(date)].slice(0, 3)} ${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1] ?? ''}`;

/** "4 days · Thu 3 – Sun 6 Dec · 9 stops" */
export function importSummary(trip: Trip): string {
  const end = addDays(trip.startDate, Math.max(1, trip.days) - 1);
  const sameMonth = trip.startDate.slice(0, 7) === end.slice(0, 7);
  // "Thu 3 – Fri 4 Dec" within a month, "Mon 30 Nov – Wed 2 Dec" across two.
  const first = sameMonth ? dayLabel(trip.startDate).replace(/ \S+$/, '') : dayLabel(trip.startDate);
  const range = trip.days <= 1 ? dayLabel(trip.startDate) : `${first} – ${dayLabel(end)}`;
  return [plural(trip.days, 'day'), range, plural(trip.stops.length, 'stop')].join(' · ');
}

function messageOf(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : (e as { message?: unknown })?.message;
  return typeof m === 'string' && m.trim() ? m.trim() : 'Something went wrong.';
}

/** "Bonsai-2 is reading part 2 of 4…" while a text import goes a day (or a block) at a time. */
function progressText(done: number, total: number, llm: string): string | undefined {
  if (!(total > 1) || !(done >= 0)) return undefined;
  return done >= total ? 'Putting your days together…' : `${llm} is reading part ${done + 1} of ${total}…`;
}

/** The result with its lists cleaned up (whatever the importer returned). */
function tidy(r: ImportResult): ImportResult {
  const strings = (xs: unknown) => (Array.isArray(xs) ? xs.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(x => x.trim()) : []);
  return { trip: r.trip, unmatched: [...new Set(strings(r.unmatched))], warnings: strings(r.warnings) };
}

// --- Icons (decorative: the button carries the label).

/** Import: an arrow down into a tray. */
export const ImportIcon = ({ size = 16, color = dusk.color.white, strokeWidth = 2.2 }: { size?: number; color?: string; strokeWidth?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5M4.5 15v3a2.5 2.5 0 0 0 2.5 2.5h10a2.5 2.5 0 0 0 2.5-2.5v-3" />
  </Svg>
);

const FileIcon = ({ size = 16, color = dusk.color.white }: { size?: number; color?: string }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4" />
  </Svg>
);

// --- The sheet.

type Phase =
  | { kind: 'edit'; error?: string }
  | { kind: 'working'; what: string }
  | { kind: 'preview'; result: ImportResult; source: Kind; error?: string };

export interface ImportSheetProps {
  b: Buddy;
  /** A file dropped on Chat: read and imported as soon as the sheet opens. */
  dropped?: DroppedFile;
  onClose: () => void;
  /** Room to leave above the sheet and below it (the tab bar), and at the sides. */
  top: number;
  bottom: number;
  side: number;
}

/** The sheet's widest, on a wide window. */
const MAX_WIDTH = 560;

export function ImportSheet({ b, dropped, onClose, top, bottom, side }: ImportSheetProps) {
  const { width } = useScreenSize();
  const llm = b.runtime.llm.name;
  const city = b.index.destination.name;
  const [text, setText] = useState('');
  const [name, setName] = useState<string>();
  const [phase, setPhase] = useState<Phase>({ kind: 'edit' });
  const [picking, setPicking] = useState(false);
  const [applying, setApplying] = useState(false);
  const mounted = useRef(true);
  /** Goes up on every import, Cancel and close, so a late answer from an older one is dropped. */
  const job = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = async (raw: string, from?: string) => {
    const t = raw.trim();
    if (!t) return;
    const api = importer();
    if (!api) {
      setPhase({ kind: 'edit', error: "This build can't read itineraries yet (core/itineraryImport.ts is missing)." });
      return;
    }
    const kind = detectKind(t, api);
    const mine = ++job.current;
    const live = () => mounted.current && mine === job.current;
    // A text import stops between model calls once this import is cancelled, closed or replaced.
    const signal = {
      get aborted() {
        return !live();
      },
    };
    setPhase({ kind: 'working', what: kind === 'ics' ? 'Reading the calendar…' : `${llm} is reading your itinerary, a day at a time…` });
    try {
      const today = b.situation.clock.date;
      const result =
        kind === 'ics'
          ? // A calendar says nothing about interests: keep the ones the trip has.
            api.importIcs(t, b.index, { today, fileName: from, interests: b.trip?.interests })
          : await api.importText(t, {
              llm: b.runtime.llm,
              index: b.index,
              today,
              signal,
              onProgress: (done, total) => {
                const what = progressText(done, total, llm);
                if (what && live()) setPhase({ kind: 'working', what });
              },
            });
      if (!live()) return;
      if (!result || !result.trip || !Array.isArray(result.trip.stops)) throw new Error('No trip came out of that. Check the text and try again.');
      setPhase({ kind: 'preview', result: tidy(result), source: kind });
    } catch (e) {
      if (live()) setPhase({ kind: 'edit', error: messageOf(e) });
    }
  };

  const load = (file: PickedFile) => {
    setText(file.text);
    setName(file.name);
    run(file.text, file.name);
  };

  const openFile = async () => {
    const files = buddyFiles();
    if (!files) {
      setPhase({ kind: 'edit', error: 'Opening a file needs the Mac app’s file panel, which this build lacks. Paste the text instead.' });
      return;
    }
    setPicking(true);
    try {
      const picked = await files.pickText(FILE_TYPES);
      if (mounted.current && picked && typeof picked.text === 'string') load(picked);
    } catch (e) {
      if (mounted.current) setPhase({ kind: 'edit', error: messageOf(e) });
    } finally {
      if (mounted.current) setPicking(false);
    }
  };

  // A dropped file: read it (natively) and import it straight away.
  const droppedPath = dropped?.path;
  useEffect(() => {
    if (!dropped) return;
    if (!isItineraryFile(dropped.name)) {
      setPhase({ kind: 'edit', error: `Can't import ${dropped.name}: drop a calendar file (.ics) or a text file, or paste the itinerary's text.` });
      return;
    }
    const files = buddyFiles();
    if (!files?.readText) {
      setPhase({ kind: 'edit', error: `Can't read ${dropped.name} here: this build has no file reader. Paste the text instead.` });
      return;
    }
    setName(dropped.name);
    setPhase({ kind: 'working', what: `Opening ${dropped.name}…` });
    // Cancel (or closing) while it reads moves job on, and the file is then left alone.
    const mine = job.current;
    const live = () => mounted.current && mine === job.current;
    files
      .readText(dropped.path, FILE_TYPES)
      .then(file => live() && load({ name: file?.name || dropped.name, text: String(file?.text ?? '') }))
      .catch(e => live() && setPhase({ kind: 'edit', error: messageOf(e) }));
    // Once per dropped file (the sheet is keyed on it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droppedPath]);

  const apply = async () => {
    if (phase.kind !== 'preview' || applying) return;
    setApplying(true);
    try {
      await b.importTrip(phase.result.trip);
      onClose();
    } catch (e) {
      if (mounted.current) setPhase({ ...phase, error: messageOf(e) });
    } finally {
      if (mounted.current) setApplying(false);
    }
  };

  const close = () => {
    job.current++;
    onClose();
  };
  /** Stops an import (a model call already sent finishes unseen, then no more) and goes back to the text. */
  const cancel = () => {
    job.current++;
    setPhase({ kind: 'edit' });
  };
  const working = phase.kind === 'working';
  const sheetWidth = Math.min(MAX_WIDTH, width - side * 2);
  const kind = text.trim() ? detectKind(text) : undefined;
  const [p1, p2] = b.index.pack.places.slice(1, 3).map(p => p.name);
  const placeholder = `Paste your itinerary or calendar here…\n\nDay 1: ${p1 ?? 'the old town'} at 10:00, lunch nearby\nDay 2: ${p2 ?? 'a museum'}, dinner at 20:30`;

  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable accessible={false} onPress={working ? undefined : close} style={[StyleSheet.absoluteFill, styles.scrim]} />
      <Glass
        kind="clear"
        radius={dusk.radius.sheet}
        // Darker than the map's cards: Chat's own words sit right behind the sheet's text.
        wash={ground(0.9)}
        style={[styles.sheet, { top, bottom, left: (width - sheetWidth) / 2, width: sheetWidth }]}>
        <View style={styles.head}>
          <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
            {phase.kind === 'preview' ? 'Your imported trip' : 'Import an itinerary'}
          </Text>
          <GlassIconButton accessibilityLabel="Close import" onPress={close} size={34} kind="clear" blur={false}>
            <CloseIcon size={12} />
          </GlassIconButton>
        </View>

        {phase.kind === 'preview' ? (
          <Preview
            result={phase.result}
            index={b.index}
            name={name}
            source={phase.source}
            replacing={b.trip}
            error={phase.error}
            applying={applying}
            onEdit={() => setPhase({ kind: 'edit' })}
            onApply={apply}
          />
        ) : working ? (
          <View style={styles.working} accessibilityLiveRegion="polite">
            <ActivityIndicator size="small" color={dusk.color.white} />
            <Text style={styles.workingText}>{phase.what}</Text>
            <GlassButton label="Cancel" kind="clear" height={dusk.size.touch} onPress={cancel} />
          </View>
        ) : (
          <>
            <Text style={styles.intro}>{`Paste it below, or open a calendar file (.ics) or a text file. You can also drop a file on Chat. Nothing goes online.`}</Text>
            <View style={styles.sourceRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open a file"
                accessibilityHint="A calendar file (.ics) or a text file"
                accessibilityState={{ disabled: picking }}
                disabled={picking}
                onPress={openFile}
                {...axPress(openFile, picking)}
                style={({ pressed }) => ({ minHeight: dusk.size.touch, justifyContent: 'center', opacity: picking ? 0.5 : pressed ? 0.85 : 1 })}>
                <Glass kind="clear" radius={dusk.radius.pill} blur={false} style={styles.sourceButton}>
                  <FileIcon />
                  <Text style={[onGlass, styles.sourceText]}>Open a file…</Text>
                </Glass>
              </Pressable>
              {name ? (
                <Text style={styles.fileName} numberOfLines={1}>
                  {name}
                </Text>
              ) : null}
            </View>
            <Glass kind="clear" radius={18} blur={false} style={styles.field}>
              <TextInput
                accessibilityLabel="Itinerary text"
                autoFocus
                value={text}
                onChangeText={t => {
                  setText(t);
                  if (phase.kind === 'edit' && phase.error) setPhase({ kind: 'edit' });
                }}
                multiline
                placeholder={placeholder}
                placeholderTextColor={dusk.color.pending}
                selectionColor={white(0.3)}
                cursorColor={dusk.color.white}
                autoCorrect={false}
                spellCheck={false}
                textAlignVertical="top"
                {...NO_FOCUS_RING}
                style={styles.input}
              />
            </Glass>
            <Text style={[styles.note, phase.error ? styles.error : null]} numberOfLines={3} accessibilityLiveRegion="polite">
              {phase.error ??
                (kind === 'ics'
                  ? `A calendar: read on this Mac in plain code, no model needed.`
                  : kind === 'text'
                    ? `Text: ${llm} reads it a day at a time, on this Mac.`
                    : `Places are matched to your ${city} guide.`)}
            </Text>
            <GlassButton label="Import" accessibilityLabel="Import" disabled={!text.trim()} onPress={() => run(text, name)} />
          </>
        )}
      </Glass>
    </View>
  );
}

/** What the import found: the days and their stops, the names the guide lacks, any notes. */
function Preview({
  result,
  index,
  name,
  source,
  replacing,
  error,
  applying,
  onEdit,
  onApply,
}: {
  result: ImportResult;
  index: PackIndex;
  name?: string;
  source: Kind;
  replacing?: Trip;
  error?: string;
  applying: boolean;
  onEdit: () => void;
  onApply: () => void;
}) {
  const { trip, unmatched, warnings } = result;
  const city = index.destination.name;
  const days = Array.from({ length: Math.max(1, Math.min(trip.days, 14)) }, (_, i) => i + 1);
  const known = trip.stops.filter(s => s.placeId && index.place(s.placeId)).length;
  const from = name ? `From ${name}` : source === 'ics' ? 'From a pasted calendar' : 'From your pasted itinerary';
  // Where they stay and what they like, when the itinerary said.
  const about = [trip.base?.name ? `Staying at ${trip.base.name.replace(/^(near|by|in|at)\s+/i, '')}` : '', trip.interests.length ? `likes ${trip.interests.map(i => i.replace(/-/g, ' ')).join(', ')}` : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <Text style={styles.summary} accessibilityLabel={`Imported: ${importSummary(trip)}`}>
        {importSummary(trip)}
      </Text>
      <Text style={styles.sub} numberOfLines={2}>
        {`${from} · ${known} of ${plural(trip.stops.length, 'stop')} in your ${city} guide`}
      </Text>
      {about ? (
        <Text style={styles.sub} numberOfLines={2}>
          {about.charAt(0).toUpperCase() + about.slice(1)}
        </Text>
      ) : null}
      <ScrollView style={styles.previewScroll} contentContainerStyle={styles.previewContent} showsVerticalScrollIndicator={false}>
        {days.map(day => {
          const date = addDays(trip.startDate, day - 1);
          const stops = trip.stops.filter(s => s.day === day);
          return (
            <View key={day} style={styles.day}>
              <Text style={styles.label}>{`DAY ${day} · ${dayLabel(date).toUpperCase()}`}</Text>
              {stops.length ? (
                stops.map(s => {
                  const place = s.placeId ? index.place(s.placeId) : undefined;
                  // A stop the guide doesn't know: where the itinerary put it (the calendar's location), and so.
                  const where = place ? (place.name !== s.title ? place.name : undefined) : s.note ? `${s.note.split('\n')[0]} · not in the guide yet` : 'Not in the guide yet';
                  return (
                    <View key={s.id} style={styles.stop} accessible accessibilityLabel={`${s.start ? `${s.start}, ` : ''}${s.title}${where ? `, ${where}` : ''}`}>
                      <Text style={styles.time}>{s.start ?? '·'}</Text>
                      <View style={styles.stopText}>
                        <Text style={styles.stopTitle} numberOfLines={2}>
                          {s.title}
                        </Text>
                        {where ? (
                          <Text style={[styles.stopWhere, !place && styles.pendingText]} numberOfLines={1}>
                            {where}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                  );
                })
              ) : (
                <Text style={styles.free}>Free</Text>
              )}
            </View>
          );
        })}
        {unmatched.length ? (
          <View style={styles.section}>
            <Text style={styles.label}>{`NOT IN YOUR ${city.toUpperCase()} GUIDE YET`}</Text>
            <Text style={styles.names}>{unmatched.join(' · ')}</Text>
            <Text style={styles.hint} selectable>
              {`Add them while online: ${PREPARE_COMMAND}`}
            </Text>
          </View>
        ) : null}
        {warnings.length ? (
          <View style={styles.section}>
            <Text style={styles.label}>NOTES</Text>
            {warnings.map((w, i) => (
              <Text key={i} style={styles.warning}>
                {w}
              </Text>
            ))}
          </View>
        ) : null}
      </ScrollView>
      {error || replacing ? (
        <Text style={[styles.note, error ? styles.error : null]} numberOfLines={2}>
          {error ?? `Apply replaces your current trip (${importSummary(replacing!).split(' · ').slice(0, 2).join(', ')}).`}
        </Text>
      ) : null}
      <View style={styles.buttons}>
        <GlassButton label="Edit" kind="clear" onPress={onEdit} style={styles.half} disabled={applying} />
        <GlassButton label="Apply" accessibilityLabel="Apply the imported trip" onPress={onApply} style={styles.half} disabled={applying} />
      </View>
    </>
  );
}

const sheetPad = 18;

const styles = StyleSheet.create({
  // Dark enough that the conversation behind doesn't read through the paste box (seen on the Mac).
  scrim: { backgroundColor: ground(0.7) },
  sheet: { position: 'absolute', paddingHorizontal: sheetPad, paddingTop: 14, paddingBottom: sheetPad, gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: dusk.size.touch },
  title: { ...font('700'), flexShrink: 1, fontSize: 20, lineHeight: 25, letterSpacing: -0.3, color: dusk.color.text },
  intro: { ...font('500'), fontSize: 13, lineHeight: 18, color: dusk.color.text2 },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sourceButton: { height: 36, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 14 },
  sourceText: { ...font('700'), fontSize: 13.5 },
  fileName: { ...font('600'), flexShrink: 1, fontSize: 13, color: dusk.color.textSoft },
  field: { flex: 1, minHeight: 120 },
  input: { ...font('400'), flex: 1, fontSize: 14, lineHeight: 19, color: dusk.color.white, paddingVertical: 12, paddingHorizontal: 14 },
  note: { ...font('500'), fontSize: 12, lineHeight: 16, color: dusk.color.text2 },
  error: { color: dusk.color.text, ...font('600') },
  working: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 12 },
  workingText: { ...font('500'), fontSize: 15, lineHeight: 21, color: dusk.color.textSoft, textAlign: 'center' },

  summary: { ...font('700'), fontSize: 16, lineHeight: 21, color: dusk.color.text },
  sub: { ...font('500'), fontSize: 12.5, lineHeight: 17, color: dusk.color.text2, marginTop: -6 },
  previewScroll: { flex: 1, marginHorizontal: -sheetPad },
  previewContent: { paddingHorizontal: sheetPad, paddingBottom: 6, gap: 14 },
  day: { gap: 6 },
  label: { ...font(dusk.font.label.weight), fontSize: dusk.font.label.size, letterSpacing: dusk.font.label.letterSpacing, color: dusk.color.text2 },
  stop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  time: { ...font('600'), width: 44, fontSize: 13.5, lineHeight: 19, color: dusk.color.textSoft, fontVariant: ['tabular-nums'] },
  stopText: { flex: 1, minWidth: 0 },
  stopTitle: { ...font('600'), fontSize: 14.5, lineHeight: 19, color: dusk.color.text },
  stopWhere: { ...font('500'), fontSize: 12, lineHeight: 16, color: dusk.color.text2 },
  pendingText: { color: dusk.color.pending },
  free: { ...font('500'), fontSize: 13.5, lineHeight: 19, color: dusk.color.pending, marginLeft: 54 },
  section: { gap: 6, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: white(0.16) },
  names: { ...font('600'), fontSize: 14, lineHeight: 19, color: dusk.color.text },
  hint: { ...font('500'), fontSize: 12.5, lineHeight: 17, color: dusk.color.textSoft },
  warning: { ...font('500'), fontSize: 12.5, lineHeight: 17, color: dusk.color.text2 },
  buttons: { flexDirection: 'row', gap: 10 },
  half: { flex: 1 },
});
