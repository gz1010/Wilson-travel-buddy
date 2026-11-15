import { fold } from './pack';
import { prompts } from './prompts';
import { LANG_NAMES, type Lang, type LLMClient, type Phrase, type Side } from './types';

/** Every language the translator hears and speaks: Argmax's voice (Qwen3-TTS) speaks these ten. */
export const LANGS = Object.keys(LANG_NAMES) as Lang[];

/** Each language's name in itself, for the language chips (the local reads theirs). */
export const LANG_NATIVE: Record<Lang, string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  pt: 'Português',
  ja: '日本語',
  ko: '한국어',
  zh: '中文',
  ru: 'Русский',
};

/** True for one of the ten codes (the helper may send any of Whisper's ~100). */
export function isLang(code: unknown): code is Lang {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(LANG_NAMES, code);
}

/**
 * The languages to send the helper for a conversation: the traveller's first, then the local's
 * pinned language, or every other language when the local's is detected.
 */
export function conversationLanguages(home: Lang, pinnedLocal?: Lang): Lang[] {
  if (pinnedLocal && pinnedLocal !== home) return [home, pinnedLocal];
  return [home, ...LANGS.filter(l => l !== home)];
}

/**
 * Text translation with Bonsai-2, between any two of the ten languages; exact phrasebook matches
 * skip the model. The phrasebook is the pack's (English and the destination's language), so it
 * only answers for that pair, in either direction.
 */
export class Translator {
  private readonly phrasebook = new Map<string, string>();

  /** home is the phrasebook's English side; local is the pack's language (Spanish for Seville). */
  constructor(private llm: LLMClient, phrases: Phrase[], home: Lang, local: Lang) {
    for (const p of phrases) {
      this.phrasebook.set(`${home}>${local}:${normalize(p.en)}`, p.local);
      this.phrasebook.set(`${local}>${home}:${normalize(p.local)}`, p.en);
    }
  }

  async translate(text: string, from: Lang, to: Lang, onToken?: (t: string) => void): Promise<string> {
    if (from === to) return text;
    const hit = this.phrasebook.get(`${from}>${to}:${normalize(text)}`);
    if (hit) {
      onToken?.(hit);
      return hit;
    }
    const out = await this.llm.stream(
      {
        tag: `translate.${from}-${to}`,
        maxTokens: 200,
        temperature: 0.2,
        messages: [
          { role: 'system', content: prompts.translate(LANG_NAMES[from], LANG_NAMES[to]) },
          { role: 'user', content: text },
        ],
      },
      onToken ?? (() => {}),
    );
    return out.trim().replace(/^["“]|["”]$/g, '');
  }
}

function normalize(s: string): string {
  return fold(s).replace(/[¿?¡!.,;:"'“”]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Decides who said each sentence in the translator, and in which languages to translate it. The
 * traveller speaks the home language; the local speaks whatever language Argmax hears from them
 * (any of the ten, not only the destination's), until someone pins one.
 *
 * Sides: the detected language decides when it is known (home: the traveller; any other: the
 * local), because Whisper's language detection is more reliable than voice prints on short
 * sentences. Argmax's speaker numbers decide when the language is unknown, and are remembered per
 * speaker for that purpose.
 */
export class SideAssigner {
  private readonly sides = new Map<number, Side>();
  /** The language last heard from the local (kept while a pin is on, for when it is cleared). */
  private heard?: Lang;
  private pinned?: Lang;

  /** expected: the destination's language, the local's until one is heard or pinned. */
  constructor(private home: Lang, private expected: Lang) {}

  /** The traveller's language. */
  get homeLanguage(): Lang {
    return this.home;
  }

  /**
   * The local's language now: the pinned one, else the last one heard from them, else the
   * destination's. Never the traveller's own: a traveller who speaks the destination's language
   * is taken to be talking with someone who speaks English (Spanish if that is theirs) until the
   * local is heard.
   */
  get localLanguage(): Lang {
    const lang = this.pinned ?? this.heard ?? this.expected;
    return lang !== this.home ? lang : this.home === 'en' ? 'es' : 'en';
  }

  /** How the local's language was found: pinned by a tap, detected by Argmax, or still the destination's. */
  get localSource(): 'pinned' | 'detected' | 'expected' {
    return this.pinned ? 'pinned' : this.heard ? 'detected' : 'expected';
  }

  /** The local's pinned language, if any. */
  get localPin(): Lang | undefined {
    return this.pinned;
  }

  /** Pins the local's language (undefined: detect it again). */
  pinLocal(lang?: Lang) {
    this.pinned = lang;
  }

  /** Changes the traveller's language; a pin or a language heard from the local that is now the traveller's is dropped. */
  setHome(lang: Lang) {
    this.home = lang;
    if (this.pinned === lang) this.pinned = undefined;
    if (this.heard === lang) this.heard = undefined;
  }

  assign(speaker: number | undefined, language: Lang | undefined): Side {
    const byLanguage = this.sideOf(language);
    if (speaker === undefined) return byLanguage ?? 'traveler';
    if (byLanguage) {
      this.sides.set(speaker, byLanguage);
      return byLanguage;
    }
    const known = this.sides.get(speaker);
    if (known) return known;
    // A new speaker: whichever side is still free.
    const side: Side = new Set(this.sides.values()).has('traveler') ? 'local' : 'traveler';
    this.sides.set(speaker, side);
    return side;
  }

  /** The side a language belongs to: home is the traveller's, any other the local's. */
  sideOf(language: Lang | undefined): Side | undefined {
    if (!language) return undefined;
    return language === this.home ? 'traveler' : 'local';
  }

  /** A sentence on this side was heard in this language: on the local's side, that is now their language. */
  hear(side: Side, language: Lang | undefined) {
    if (side === 'local' && language && language !== this.home) this.heard = language;
  }

  /** Languages to translate between for an utterance on this side (automatic mode). */
  direction(side: Side, detected?: Lang): { from: Lang; to: Lang } {
    if (detected === this.home) return { from: this.home, to: this.localLanguage };
    if (detected) return { from: detected, to: this.home };
    return side === 'traveler' ? { from: this.home, to: this.localLanguage } : { from: this.localLanguage, to: this.home };
  }

  /** Push-to-talk: the pressed button decides the direction; the language heard only says which one the local spoke. */
  pressedDirection(side: Side, detected?: Lang): { from: Lang; to: Lang } {
    if (side === 'traveler') return { from: this.home, to: this.localLanguage };
    return { from: detected && detected !== this.home ? detected : this.localLanguage, to: this.home };
  }

  /** Forgets the speakers; with `all` (the default), also the language heard from the local. Pins stay. */
  reset(all = true) {
    this.sides.clear();
    if (all) this.heard = undefined;
  }
}
