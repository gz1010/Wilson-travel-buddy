import { Guide } from './guide';
import { routeIntent } from './intent';
import type { PackIndex } from './pack';
import { NOT_IN_GUIDE } from './prompts';
import { Recommender, spokenSummary } from './recommend';
import { Translator } from './translate';
import { TripPlanner, summarizeTrip } from './trip';
import type { Companion, CompanionEvent, LLMClient, Situation, Trip } from './types';

export interface CompanionContext {
  trip(): Trip | undefined;
  situation(): Situation;
  saveTrip(trip: Trip): Promise<void>;
}

/**
 * Takes what the traveller said or typed and does the right thing: set up
 * the trip, edit it, recommend, answer from the guide, or switch to the
 * translator. Voice and text come through the same door.
 */
export class DefaultCompanion implements Companion {
  readonly planner: TripPlanner;
  readonly recommender: Recommender;
  readonly guide: Guide;
  readonly translator: Translator;

  constructor(private llm: LLMClient, private index: PackIndex, private ctx: CompanionContext) {
    this.planner = new TripPlanner(llm, index);
    this.recommender = new Recommender(llm, index);
    this.guide = new Guide(llm, index);
    this.translator = new Translator(llm, index.pack.phrases, 'en', index.destination.language);
  }

  async handle(text: string, emit: (e: CompanionEvent) => void): Promise<void> {
    const trip = this.ctx.trip();
    const sit = this.ctx.situation();
    const intent = routeIntent(text, !!trip);
    try {
      switch (intent) {
        case 'translator': {
          emit({ type: 'translator' });
          emit({ type: 'done', text: 'Opening the translator.' });
          return;
        }
        case 'trip.setup': {
          emit({ type: 'status', text: 'Reading your plans…' });
          const next = await this.planner.extract(text, sit.clock.date);
          await this.ctx.saveTrip(next);
          emit({ type: 'trip', trip: next });
          emit({ type: 'done', text: confirmTrip(next) });
          return;
        }
        case 'trip.edit': {
          emit({ type: 'status', text: 'Updating your plans…' });
          const next = await this.planner.revise(trip!, text, sit.clock.date);
          await this.ctx.saveTrip(next);
          emit({ type: 'trip', trip: next });
          emit({ type: 'done', text: 'Done. ' + summarizeTrip(next, this.index).split('\n').slice(-2).join(' ') });
          return;
        }
        case 'recommend': {
          emit({ type: 'recommendations', items: this.recommender.quick(trip, sit) });
          emit({ type: 'status', text: 'Thinking about what fits right now…' });
          const recs = await this.recommender.refine(trip, sit);
          emit({ type: 'recommendations', items: recs });
          if (recs[0]) emit({ type: 'focus', placeId: recs[0].placeId });
          emit({ type: 'done', text: spokenSummary(recs) });
          return;
        }
        case 'phrase': {
          const what = text.replace(/.*how (do|would) (i|you) say\s*/i, '').replace(/\s+in spanish\??$/i, '').replace(/[?"]/g, '').trim();
          const lang = this.index.destination.language;
          const out = await this.translator.translate(what, 'en', lang, t => emit({ type: 'token', text: t, lang }));
          emit({ type: 'done', text: out, lang });
          return;
        }
        case 'guide':
        default: {
          const { text: answer, places } = await this.guide.answer(text, sit, trip, t => emit({ type: 'token', text: t }));
          if (places[0]) emit({ type: 'focus', placeId: places[0].id });
          emit({ type: 'done', text: answer || NOT_IN_GUIDE });
          return;
        }
      }
    } catch (e) {
      emit({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  }
}

function confirmTrip(trip: Trip): string {
  const booked = trip.stops.filter(s => s.fixed);
  const parts = [`Got it: ${trip.days} day${trip.days > 1 ? 's' : ''}`];
  if (trip.base) parts.push(`staying near ${trip.base.name}`);
  if (trip.interests.length) parts.push(`into ${trip.interests.slice(0, 3).join(', ')}`);
  let s = parts.join(', ') + '.';
  if (booked.length) s += ` I'll plan around ${booked.map(b => b.title).join(' and ')}.`;
  return s + ' Check the plan on screen and tell me anything to fix.';
}
