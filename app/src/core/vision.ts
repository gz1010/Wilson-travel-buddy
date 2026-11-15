import type { PackIndex } from './pack';
import { prompts } from './prompts';
import type { GeoPoint, LLMClient, Place } from './types';

// The Look screen's brain: a photo from the helper's camera goes to Bonsai-2's vision projector
// with a short prompt, and the answer streams back to be shown and spoken. Code, not the model,
// decides which pack place (if any) the answer is about.

/** How many nearby place names the prompt offers the model to match against. */
const NEARBY = 12;

export interface LookResult {
  text: string;
  /** The pack place the answer names, if any. */
  place?: Place;
}

export class Looker {
  constructor(private llm: LLMClient, private index: PackIndex) {}

  /**
   * Describes a photo for the traveller. image: base64 JPEG (or a data URI). question: what they
   * asked about it, if they asked. near: where they are, so the closest places are offered.
   */
  async describe(image: string, question: string | undefined, onToken: (t: string) => void, near?: GeoPoint): Promise<LookResult> {
    const from = near ?? this.index.destination.center;
    const nearby = this.index
      .nearest(from, NEARBY)
      .map(n => n.place.name)
      .join('; ');
    const ask = question?.trim() ? question.trim() : 'What am I looking at?';
    const text = (
      await this.llm.stream(
        {
          tag: 'look',
          maxTokens: 220,
          temperature: 0.4,
          messages: [
            { role: 'system', content: prompts.look(this.index.destination.name, nearby) },
            { role: 'user', content: ask, images: [image] },
          ],
        },
        onToken,
      )
    ).trim();
    const place = this.index.placesMentionedIn(text)[0];
    return { text, place };
  }
}
