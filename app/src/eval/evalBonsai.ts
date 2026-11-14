/* eslint-disable no-console */
// Runs the demo's model calls against a real llama-server and checks them.
//
//   cd app && npm run eval                 # needs llama-server on 127.0.0.1:8080 (scripts/start.sh)
//   LLAMA_URL=http://127.0.0.1:8080 RUNS=5 npm run eval
//
// It uses the app's own code (companion, planner, recommender, guide, translator), prints a report,
// writes it to docs/eval/<model>.md, and saves real answers to src/fixtures/recorded.json, which
// the dev app replays when no model is running.
import { DefaultCompanion } from '../core/companion';
import { PackIndex } from '../core/pack';
import { NOT_IN_GUIDE } from '../core/prompts';
import { stopsOn } from '../core/trip';
import type { ChatRequest, CompanionEvent, JSONSchema, LLMClient, Situation, Trip } from '../core/types';
import { seville } from '../pack/seville';
import { buildBody, prettyModelName } from '../services/llm/llamaClient';
import { SSEParser } from '../services/llm/sse';

declare const process: { env: Record<string, string | undefined>; exit(code: number): never; cwd(): string };
declare function require(name: string): any;
const fs = require('fs');
const path = require('path');

const URL_BASE = process.env.LLAMA_URL ?? 'http://127.0.0.1:8080';
const RUNS = Number(process.env.RUNS ?? 3);
const DAY1 = '2026-11-15'; // Sunday: "Tuesday" is day 3
const SPEC_SENTENCE =
  "I'm here three days, staying near the old town. I love street food and architecture, and Tuesday afternoon I have a ticket for the Museum of Fine Arts.";

// ---------------------------------------------------------------------------
// A Node client for llama-server (the app's client uses XMLHttpRequest, which Node lacks).

interface Call {
  tag: string;
  ms: number;
  firstTokenMs?: number;
  output: string;
}

class NodeLlama implements LLMClient {
  name = 'Bonsai-2';
  calls: Call[] = [];
  recorded: Record<string, string> = {};

  async connect(): Promise<void> {
    const models = await fetch(`${URL_BASE}/v1/models`).then(r => r.json());
    this.name = prettyModelName(models?.data?.[0]?.id ?? '');
  }

  async stream(req: ChatRequest, onToken: (t: string) => void): Promise<string> {
    return this.post(req, undefined, onToken);
  }

  async json<T>(req: ChatRequest, schema: JSONSchema): Promise<T> {
    const text = await this.post(req, schema, () => {});
    return JSON.parse(text) as T;
  }

  private async post(req: ChatRequest, schema: JSONSchema | undefined, onToken: (t: string) => void): Promise<string> {
    const t0 = Date.now();
    let first: number | undefined;
    const res = await fetch(`${URL_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(req, schema)),
    });
    // Node's fetch streams the body; React Native's types don't know that, hence the casts.
    const body = (res as any).body as AsyncIterable<Uint8Array> | undefined;
    if (!res.ok || !body) throw new Error(`llama-server ${res.status}: ${await res.text()}`);
    const parser = new SSEParser();
    const decoder = new (globalThis as any).TextDecoder();
    let raw = '';
    let text = '';
    for await (const chunk of body) {
      raw += decoder.decode(chunk, { stream: true });
      for (const d of parser.feed(raw)) {
        if (first === undefined) first = Date.now() - t0;
        text += d;
        onToken(d);
      }
    }
    this.calls.push({ tag: req.tag, ms: Date.now() - t0, firstTokenMs: first, output: text });
    if (!(req.tag in this.recorded)) this.recorded[req.tag] = text;
    return text;
  }
}

// ---------------------------------------------------------------------------
// Checks

interface Result {
  name: string;
  pass: boolean;
  ms: number;
  detail: string;
}
const results: Result[] = [];
const transcript: string[] = [];

async function check(name: string, fn: () => Promise<{ pass: boolean; detail: string }>) {
  const t0 = Date.now();
  try {
    const r = await fn();
    results.push({ name, ...r, ms: Date.now() - t0 });
  } catch (e) {
    results.push({ name, pass: false, ms: Date.now() - t0, detail: `threw: ${e instanceof Error ? e.message : e}` });
  }
  const last = results[results.length - 1];
  console.log(`${last.pass ? 'PASS' : 'FAIL'}  ${name}  (${(last.ms / 1000).toFixed(1)} s)  ${last.detail}`);
}

const index = new PackIndex(seville);
const at = (minute: number, place = 'santa-cruz'): Situation => ({
  clock: { date: DAY1, minute },
  location: index.place(place)?.point ?? seville.destination.center,
  locationLabel: index.place(place)?.name ?? 'the city centre',
  visited: [],
});

async function run(llm: NodeLlama) {
  let trip: Trip | undefined;
  let sit = at(13 * 60);
  const companion = new DefaultCompanion(llm, index, {
    trip: () => trip,
    situation: () => sit,
    saveTrip: async t => {
      trip = t;
    },
  });
  const say = async (text: string) => {
    const events: CompanionEvent[] = [];
    await companion.handle(text, e => events.push(e));
    const done = events.find(e => e.type === 'done') as { text: string } | undefined;
    const error = events.find(e => e.type === 'error') as { text: string } | undefined;
    transcript.push(`**You:** ${text}\n\n**Buddy:** ${error ? `ERROR ${error.text}` : done?.text ?? '(nothing)'}\n`);
    return { events, done: done?.text ?? '', error: error?.text };
  };

  // Beat 2: trip setup, several times, because small models vary.
  for (let i = 1; i <= RUNS; i++) {
    await check(`trip setup from the spec sentence (run ${i}/${RUNS})`, async () => {
      trip = undefined;
      const r = await say(SPEC_SENTENCE);
      if (r.error || !trip) return { pass: false, detail: r.error ?? 'no trip saved' };
      const t = trip as Trip;
      const tuesday = stopsOn(t, '2026-11-17');
      const museum = tuesday.find(s => /museum|bellas|fine arts/i.test(s.title) || s.placeId === 'bellas-artes');
      const problems = [
        t.days !== 3 && `days=${t.days}`,
        !t.interests.includes('food') && 'no food interest',
        !t.interests.includes('architecture') && 'no architecture interest',
        !museum && 'no museum stop on Tuesday',
        museum && !museum.fixed && 'museum not marked booked',
        museum && museum.start && (Number(museum.start.slice(0, 2)) < 12 || Number(museum.start.slice(0, 2)) > 18) && `museum at ${museum.start}`,
        t.base?.placeId !== 'santa-cruz' && `base=${t.base?.name ?? 'none'}→${t.base?.placeId ?? 'unmatched'}`,
      ].filter(Boolean);
      return { pass: problems.length === 0, detail: problems.length ? problems.join('; ') : `museum ${museum?.start ?? ''} day ${museum?.day}` };
    });
  }

  // Trip edit
  await check('edit: "move the museum to Monday"', async () => {
    trip = undefined;
    await say(SPEC_SENTENCE);
    const museumDay = () => (trip as Trip | undefined)?.stops.find(s => /museum|fine arts/i.test(s.title))?.day;
    const before = museumDay();
    const r = await say('Move the museum to Monday');
    const after = museumDay();
    return { pass: !r.error && after === 2, detail: `day ${before} → ${after}` };
  });

  // Beats 3 and 4: recommendations at 13:00 and 17:00 (rain from 16:00 in the sample forecast).
  for (const minute of [13 * 60, 17 * 60]) {
    await check(`"What should I do now?" at ${minute / 60}:00`, async () => {
      sit = at(minute);
      const r = await say('What should I do now?');
      const recs = [...r.events].reverse().find(e => e.type === 'recommendations') as any;
      const items = recs?.items ?? [];
      const fromModel = items.filter((x: any) => x.fromModel).length;
      const reasons = items.map((x: any) => `${x.placeId}: ${x.reason}`).join(' | ');
      return { pass: items.length > 0 && fromModel > 0, detail: `${fromModel}/${items.length} model reasons. ${reasons}` };
    });
  }

  // Beat 5: guide
  sit = at(13 * 60);
  await check('guide: answered from the pack', async () => {
    const r = await say('Why does the Giralda have ramps instead of stairs?');
    return { pass: !r.error && /ramp|horse/i.test(r.done) && r.done !== NOT_IN_GUIDE, detail: r.done };
  });
  await check('guide: declines what the pack does not cover', async () => {
    const r = await say("What's the best sushi in Tokyo?");
    return { pass: r.done.includes(NOT_IN_GUIDE.slice(0, 20)), detail: r.done };
  });
  await check('guide: "what\'s near my hotel?"', async () => {
    const r = await say("What's near my hotel?");
    return { pass: !r.error && r.done.length > 0 && r.done !== NOT_IN_GUIDE, detail: r.done };
  });

  // Beat 6: translation quality, for a person to grade.
  const en = [
    'Where is the cathedral?',
    'Is it far from here?',
    'Could we have a table for two outside?',
    'What time does the market close today?',
    'I am allergic to nuts, is there any in this dish?',
    'Which bus goes to Plaza de España?',
    'Can you recommend a good tapas bar nearby?',
    'How much is a ticket for the Alcázar?',
    'We would like to see a flamenco show tonight.',
    'Thank you very much, you have been very kind.',
  ];
  const es = [
    'Está a cinco minutos andando, todo recto.',
    'Hoy cerramos a las tres de la tarde.',
    'Las espinacas con garbanzos son la especialidad de la casa.',
    'Tiene que comprar las entradas en la taquilla de la esquina.',
    'Va a llover esta tarde, mejor visite un museo.',
    'El autobús número tres le deja en la puerta.',
    '¿Quiere la cuenta junta o por separado?',
    'Lo siento, la cocina abre a las ocho y media.',
    'Cruce el puente y gire a la izquierda.',
    'Bienvenidos a Sevilla, que disfruten de su visita.',
  ];
  const translations: string[] = [];
  const tr = companion.translator;
  for (const [list, from, to] of [[en, 'en', 'es'], [es, 'es', 'en']] as const) {
    for (const s of list) {
      const t0 = Date.now();
      let first: number | undefined;
      const out = await tr.translate(s, from, to, () => {
        if (first === undefined) first = Date.now() - t0;
      });
      translations.push(`| ${from}→${to} | ${s} | ${out} | ${((Date.now() - t0) / 1000).toFixed(2)} s |`);
      console.log(`  ${from}→${to}  ${s}  →  ${out}`);
    }
  }
  return translations;
}

async function speed(): Promise<string> {
  const res = await fetch(`${URL_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Describe Seville in about 80 words.' }],
      max_tokens: 120,
      chat_template_kwargs: { enable_thinking: false },
    }),
  }).then(r => r.json());
  const t = res.timings ?? {};
  return `prompt ${Math.round(t.prompt_ms ?? 0)} ms, generation ${(t.predicted_per_second ?? 0).toFixed(1)} tokens/s over ${t.predicted_n ?? '?'} tokens`;
}

async function main() {
  const llm = new NodeLlama();
  try {
    await llm.connect();
  } catch {
    console.error(`No llama-server at ${URL_BASE}. Start it with scripts/start.sh (or the Bonsai-demo start script) first.`);
    process.exit(1);
  }
  console.log(`Evaluating ${llm.name} at ${URL_BASE}\n`);
  const sp = await speed();
  console.log(`Speed: ${sp}\n`);
  const translations = await run(llm);

  const byTag = new Map<string, number[]>();
  for (const c of llm.calls) byTag.set(c.tag, [...(byTag.get(c.tag) ?? []), c.ms]);
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const passed = results.filter(r => r.pass).length;
  const report = [
    `# ${llm.name}: demo eval`,
    '',
    `Speed: ${sp}. Checks passed: **${passed}/${results.length}**.`,
    '',
    '| Check | Result | Time | Detail |',
    '|---|---|---|---|',
    ...results.map(r => `| ${r.name} | ${r.pass ? 'pass' : '**FAIL**'} | ${(r.ms / 1000).toFixed(1)} s | ${r.detail.replace(/\|/g, '/').replace(/\n/g, ' ')} |`),
    '',
    '## Model call times (median)',
    '',
    '| Call | Median | Count |',
    '|---|---|---|',
    ...[...byTag].map(([tag, ms]) => `| ${tag} | ${(median(ms) / 1000).toFixed(2)} s | ${ms.length} |`),
    '',
    '## Translations (grade these by hand)',
    '',
    '| Direction | Source | Bonsai-2 | Time |',
    '|---|---|---|---|',
    ...translations,
    '',
    '## Conversation transcript',
    '',
    ...transcript,
  ].join('\n');

  const root = path.resolve(process.cwd(), '..');
  const dir = path.join(root, 'docs', 'eval');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${llm.name.replace(/\W+/g, '-').toLowerCase()}.md`);
  fs.writeFileSync(file, report);
  fs.writeFileSync(path.join(process.cwd(), 'src/fixtures/recorded.json'), JSON.stringify(llm.recorded, null, 1));
  console.log(`\n${passed}/${results.length} checks passed. Report: ${file}`);
  console.log('Real answers saved to app/src/fixtures/recorded.json (the dev app replays them without a model).');
}

main();
