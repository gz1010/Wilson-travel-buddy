// The on-device models' names, tidied for a caption. The helper reports names such as
// "Whisper large-v3-v20240930_626MB (Argmax)": the build date and download size are noise on
// screen, and "(Argmax)" after every one of them repeats itself.

const ARGMAX = /\s*\(Argmax\)\s*$/i;

/** "Whisper large-v3-v20240930_626MB (Argmax)" → "Whisper large-v3 (Argmax)". */
export function tidyModel(name: string): string {
  return name
    .replace(/[-_]v?\d{8}(?=[_\s(]|$)/i, '') // a build date: -v20240930
    .replace(/[-_]\d+(\.\d+)?\s?[MG]B(?=[\s(]|$)/i, '') // a download size: _626MB
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Every model by name in one line: "Bonsai-2 4B · Argmax: Whisper large-v3, Qwen3-TTS 0.6B,
 * Pyannote speakers". Names the helper doesn't mark as Argmax's are listed as they are.
 */
export function modelLine(llm: string | undefined, audio: readonly string[]): string {
  const tidy = audio.filter(Boolean).map(tidyModel);
  const argmax = tidy.filter(m => ARGMAX.test(m)).map(m => keep(m.replace(ARGMAX, '')));
  const others = tidy.filter(m => !ARGMAX.test(m)).map(keep);
  return [llm && keep(llm), ...others, argmax.length ? `Argmax: ${argmax.join(', ')}` : ''].filter(Boolean).join(' · ');
}

/** A name on one line: no break at its spaces or hyphens ("Qwen3-TTS 0.6B" stays whole). */
const keep = (name: string) => name.replace(/ /g, '\u00A0').replace(/-/g, '\u2011');
