// Routing by rules rather than by the model: it is instant, never wrong in
// surprising ways, and easy to extend. Order matters; first match wins.

export type Intent = 'recommend' | 'translator' | 'phrase' | 'trip.setup' | 'trip.edit' | 'guide';

const RULES: [Intent, RegExp][] = [
  ['translator', /\b(translat(e|or|ion)|talk to (a|the|this) (local|person|waiter|driver)|interpret)\b/i],
  ['phrase', /\bhow (do|would) (i|you) say\b|\bwhat'?s .+ in spanish\b/i],
  ['recommend', /\b(what should (i|we) do|what('?s| is) (good|worth)|recommend|suggest|where should (i|we) go|what now|anything (good|fun)|i'?m (bored|hungry)|what to do)\b/i],
  ['trip.edit', /\b(move|reschedule|cancel|remove|delete|add|swap|push|change)\b.*\b(to|from|on|my|the|trip|plan|itinerary|tomorrow|today|day)\b/i],
  ['trip.setup', /\b(i'?m (here|staying|in .+ for)|my trip|i (also )?(have|got) (a|tickets?)|i('?m| am) (visiting|arriving)|(\d+|two|three|four|five) (days|nights))\b/i],
];

const QUESTION = /^\s*(what|where|when|why|how|which|who|is|are|can|could|do|does|will|should)\b/i;
const CORRECTION = /^\s*(actually|no\b|wait|sorry|correction|i also|also)\b/i;

export function routeIntent(text: string, hasTrip: boolean): Intent {
  for (const [intent, re] of RULES) {
    if (!re.test(text)) continue;
    if (intent === 'trip.edit') return hasTrip ? 'trip.edit' : 'trip.setup';
    if (intent === 'trip.setup') {
      if (QUESTION.test(text)) continue; // "What is there to see in three days?" is a question, not a plan
      if (!hasTrip) return 'trip.setup';
      // A long description replaces the trip; a short remark ("I'm here four days") edits it.
      return text.split(/\s+/).length > 15 ? 'trip.setup' : 'trip.edit';
    }
    return intent;
  }
  if (hasTrip && CORRECTION.test(text)) return 'trip.edit';
  // Questions never create or overwrite a trip; the guide works without one.
  return 'guide';
}
