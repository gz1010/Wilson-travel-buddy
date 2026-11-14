import { fold } from './pack';
import { prompts } from './prompts';
import { LANG_NAMES, type Lang, type LLMClient, type Phrase, type Side } from './types';

/** Text translation with Bonsai-2; exact phrasebook matches skip the model. */
export class Translator {
  private readonly phrasebook = new Map<string, string>();

  constructor(private llm: LLMClient, phrases: Phrase[], private home: Lang, private local: Lang) {
    for (const p of phrases) {
      this.phrasebook.set(`${home}:${normalize(p.en)}`, p.local);
      this.phrasebook.set(`${local}:${normalize(p.local)}`, p.en);
    }
  }

  async translate(text: string, from: Lang, to: Lang, onToken?: (t: string) => void): Promise<string> {
    if (from === to) return text;
    const hit = this.phrasebook.get(`${from}:${normalize(text)}`);
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
 * Decides who said each sentence in the translator: the traveller (home
 * language) or the local. Argmax gives speaker numbers (0, 1, …) but not who
 * they are; the first time a speaker is heard in a known language decides
 * their side. With no speaker number (push-to-talk or no diarization), the
 * detected language decides.
 */
export class SideAssigner {
  private readonly sides = new Map<number, Side>();

  constructor(private home: Lang, private local: Lang) {}

  assign(speaker: number | undefined, language: Lang | undefined): Side {
    const byLanguage: Side | undefined =
      language === this.home ? 'traveler' : language === this.local ? 'local' : undefined;
    if (speaker === undefined) return byLanguage ?? 'traveler';
    const known = this.sides.get(speaker);
    if (known) {
      // With only two voice prints, both can land on one side. If this speaker's language says
      // the other side and nobody holds it yet, the map is wrong: move them.
      if (byLanguage && byLanguage !== known && ![...this.sides.values()].includes(byLanguage)) {
        this.sides.set(speaker, byLanguage);
        return byLanguage;
      }
      return known;
    }
    // A new speaker: language first, otherwise whichever side is still free.
    const taken = new Set(this.sides.values());
    const side = byLanguage ?? (taken.has('traveler') ? 'local' : 'traveler');
    this.sides.set(speaker, side);
    return side;
  }

  /** Languages to translate between for an utterance on this side. */
  direction(side: Side, detected?: Lang): { from: Lang; to: Lang } {
    if (detected === this.home) return { from: this.home, to: this.local };
    if (detected === this.local) return { from: this.local, to: this.home };
    return side === 'traveler' ? { from: this.home, to: this.local } : { from: this.local, to: this.home };
  }

  reset() {
    this.sides.clear();
  }
}
