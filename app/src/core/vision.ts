import type { PackIndex } from './pack';
import { prompts } from './prompts';
import type { LLMClient, Place, PlaceCategory } from './types';

// Look: the traveller points the camera at something unfamiliar (a dish, a road sign or
// marking, a menu, a building) and Bonsai-2 says what it is. The photo comes from the camera,
// chosen by the person: the model never fetches or chooses images.

/** Places the model is told it may recognise by sight. Bars and restaurants look like any other. */
const RECOGNISABLE: ReadonlySet<PlaceCategory> = new Set<PlaceCategory>([
  'landmark',
  'church',
  'museum',
  'park',
  'viewpoint',
  'market',
  'neighborhood',
]);

export interface LookResult {
  /** The answer as plain text (no markdown), at most a few short sentences. */
  text: string;
  /** The guide place the answer names, if any, so the screen can offer to open it. */
  place?: Place;
}

export const LOOK_MAX_TOKENS = 220;

/** Shown when llama-server has no vision projector loaded (started without --mmproj). */
export const NO_VISION =
  'Bonsai-2 was started without its vision projector, so it cannot see photos. Restart it with scripts/start.sh (it passes the *mmproj*.gguf file).';

/** Describes camera photos with Bonsai-2's vision (thinking off: LlamaClient never turns it on). */
export class Looker {
  constructor(private llm: LLMClient, private index: PackIndex) {}

  /** The guide places the model may name in a photo, as written in the pack. */
  placeNames(): string[] {
    return this.index.pack.places.filter(p => RECOGNISABLE.has(p.category)).map(p => p.name);
  }

  /**
   * Streams what the photo shows. `image` is a base64 JPEG (a data: URI also works);
   * `question` is what the person asked about it, if anything.
   */
  async describe(image: string, question: string | undefined, onToken: (token: string) => void): Promise<LookResult> {
    const q = question?.trim();
    let raw: string;
    try {
      raw = await this.llm.stream(
        {
          tag: 'look',
          maxTokens: LOOK_MAX_TOKENS,
          temperature: 0.4,
          messages: [
            { role: 'system', content: prompts.look(this.index.destination.name, this.placeNames(), this.index.destination.dishes) },
            { role: 'user', content: q || 'What am I looking at?', images: [image] },
          ],
        },
        onToken,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // llama-server answers "image input is not supported … provide the mmproj" without a projector.
      if (/mmproj|image input is not supported|multimodal/i.test(message)) throw new Error(NO_VISION);
      throw e;
    }
    const text = plainText(raw);
    // Any guide place the answer names counts, a restaurant too: its name is often written on
    // the sign in the photo ("FREIDURIA PUERTA DE LA CARNE").
    const place = this.index.placesMentionedIn(text)[0];
    return { text, place };
  }
}

/** Drops markdown the model sometimes adds anyway (bold, italics, headings, bullets), for the card and the voice. */
export function plainText(s: string): string {
  return s
    .replace(/\*+|__|`/g, '')
    .replace(/^\s*#+\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/[ \t]*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
