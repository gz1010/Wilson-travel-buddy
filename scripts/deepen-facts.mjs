#!/usr/bin/env node
// Gives Wilson more to say about each guide place: up to three more facts per place from the rest
// of the Wikipedia article fetch-facts.mjs matched (the lead's later paragraphs, then sections such
// as History, Architecture or Description), so "tell me more about the cathedral" has an answer
// with Wi-Fi off. Run while online, after fetch-facts.mjs (scripts/prepare-pack.mjs runs both):
//
//   node scripts/deepen-facts.mjs                    # Seville
//   node scripts/deepen-facts.mjs --dry-run          # print what it would add, write nothing
//   node scripts/deepen-facts.mjs --only catedral,alcazar --cache /tmp/wiki
//
// It reads each "wiki-<placeId>" fact's article URL, fetches the whole article as plain text
// (action=query&prop=extracts), and writes facts "wikimore-<placeId>-<n>" (title "<Article>:
// <Section>", at most ~450 characters cut at a sentence end, same source and CC BY-SA 4.0 licence).
// Places with no Wikipedia fact are looked up once more on the local-language Wikipedia, and only an
// article whose title is exactly the place's name and that mentions the city is used.
// Earlier "wikimore-*" facts are replaced (with --only, just those places'); fetch-facts.mjs leaves
// them alone. Same politeness as fetch-facts.mjs: one request at a time, paced to Wikimedia's 10 a
// minute unless WIKIMEDIA_CONTACT is set (sent only to Wikimedia, in the User-Agent).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const opt = name => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const destId = opt('dest') ?? 'seville';
const dryRun = flag('dry-run');
const only = opt('only') ? new Set(opt('only').split(',')) : undefined;
const cacheDir = opt('cache');
const perPlace = Number(opt('per-place') ?? 3);

const packDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'app/src/pack', destId);
const places = JSON.parse(readFileSync(join(packDir, 'places.json'), 'utf8'));
const dest = JSON.parse(readFileSync(join(packDir, 'destination.json'), 'utf8'));
const factsPath = join(packDir, 'facts.json');
const facts = JSON.parse(readFileSync(factsPath, 'utf8'));
const localLang = dest.language ?? 'es';
const localCity = { Seville: 'Sevilla' }[dest.name] ?? dest.name;
const LICENSE = 'CC BY-SA 4.0';
const MAX_BODY = 450;
const MIN_BODY = 140;

const contact = process.env.WIKIMEDIA_CONTACT?.trim();
const HEADERS = {
  'User-Agent': `travel-buddy-prepare/1.0 (offline travel guide pack builder${contact ? `; ${contact}` : ''})`,
  Accept: 'application/json',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
let gapMs = contact ? 200 : 6500;
let lastRequest = 0;
let requests = 0;
let answered = 0;
/** True after a request gave up on the network; reset by the next answer. */
let lostNetwork = false;

async function getJson(url) {
  const cached = cacheDir && join(cacheDir, createHash('sha1').update(url).digest('hex') + '.json');
  if (cached && existsSync(cached)) {
    answered++;
    return JSON.parse(readFileSync(cached, 'utf8'));
  }
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequest + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    requests++;
    let res;
    try {
      res = await fetch(url, { headers: HEADERS });
    } catch (e) {
      if (answered === 0 && attempt >= 2) {
        console.log(`Cannot reach Wikipedia (${e.cause?.code ?? e.message}). Nothing changed; run this again while online.`);
        process.exit(1);
      }
      // Wi-Fi gone mid-run: give up on this request after a few tries instead of waiting forever,
      // and after that try each request once (it carries on if the connection comes back).
      if (attempt >= (lostNetwork ? 0 : 4)) {
        lostNetwork = true;
        throw new Error(`cannot reach ${new URL(url).host} (${e.cause?.code ?? e.message})`);
      }
      await sleep(2000 * (attempt + 1));
      continue;
    }
    answered++;
    lostNetwork = false;
    if (res.ok) {
      const body = await res.json();
      if (cached) {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(cached, JSON.stringify(body));
      }
      return body;
    }
    if (attempt >= 4 || !(res.status === 429 || res.status >= 500)) throw new Error(`${res.status} from ${new URL(url).host}`);
    const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt * 5;
    if (res.status === 429) gapMs = Math.max(gapMs, 6500);
    console.log(`    Wikipedia busy (${res.status}); waiting ${retryAfter} s`);
    await sleep(retryAfter * 1000);
  }
}
const api = (lang, params) =>
  getJson(`https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({ format: 'json', formatversion: '2', ...params }));

// ---------------------------------------------------------------------------
// Text

const fold = s =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const SKIP = new Set(
  `see also references notes external links further reading bibliography sources gallery citations footnotes works cited
   literature in popular culture filmography discography awards notes and references references and notes
   vease tambien referencias notas enlaces externos bibliografia galeria fuentes galeria de imagenes`
    .split('\n')
    .flatMap(l => l.trim().split(/\s{2,}/)),
);
const SKIP_RE = /^(see also|references|notes|external links|further reading|bibliography|sources|gallery|citations|footnotes|works cited|in popular culture|vease tambien|referencias|notas|enlaces externos|bibliografia|galeria|fuentes|filmografia|premios)\b/;
// Sections worth a traveller's time, in the order they are taken.
const PREFER = [
  /histor/, /architect|arquitect/, /descri/, /interior/, /exterior|facade|fachada/, /collection|coleccion|exhibit|exposicion|museum|museo/,
  /tower|torre|chapel|capilla|altar|retablo|tomb|tumba|garden|jardin|courtyard|patio/, /legend|leyenda|name|nombre|etymolog/, /today|actualidad|use|uso/,
];

/** Plain text, at most MAX_BODY characters, cut after the last full sentence that fits. */
function trimBody(text) {
  const t = text
    .replace(/[​-‍﻿]/g, '') // zero-width characters some articles carry
    .replace(/\s+/g, ' ')
    .replace(/\[(cita requerida|citation needed|nota \d+|\d+)\]/gi, '')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .trim();
  if (t.length <= MAX_BODY) return t;
  const head = t.slice(0, MAX_BODY + 1);
  const cut = Math.max(...['. ', '! ', '? '].map(m => head.lastIndexOf(m)));
  if (cut >= MIN_BODY) return head.slice(0, cut + 1).trim();
  // One long sentence: end it at a semicolon if there is one.
  const semi = head.lastIndexOf('; ');
  if (semi >= MIN_BODY) return head.slice(0, semi).trim() + '.';
  const space = head.lastIndexOf(' ');
  return `${head.slice(0, space > 0 ? space : MAX_BODY - 1).replace(/[,;:]$/, '')}…`;
}

/** The article's lead paragraphs and its level-2 sections (subsections folded in). */
function splitArticle(extract) {
  const lines = extract.split('\n');
  const lead = [];
  const sections = [];
  let cur;
  for (const line of lines) {
    const h = /^(=+)\s*(.+?)\s*\1\s*$/.exec(line);
    if (h) {
      if (h[1].length === 2) {
        cur = { title: h[2], paragraphs: [] };
        sections.push(cur);
      }
      continue;
    }
    if (!line.trim()) continue;
    (cur ? cur.paragraphs : lead).push(line.trim());
  }
  return { lead, sections };
}

const tagsFor = (place, section) => {
  const t = new Set(place.tags ?? []);
  const s = fold(section);
  if (/histor|legend|leyenda/.test(s)) t.add('history');
  if (/architect|arquitect|facade|fachada|tower|torre|interior|exterior/.test(s)) t.add('architecture');
  if (/collection|coleccion|museum|museo|exhibit|art|arte|pintur|painting/.test(s)) t.add('art');
  return [...t];
};

// ---------------------------------------------------------------------------

const isMore = f => String(f.id).startsWith('wikimore-');
const base = new Map(facts.filter(f => String(f.id).startsWith('wiki-') && f.source).map(f => [f.placeId, f]));
const todo = places.filter(p => !only || only.has(p.id));
const fresh = [];
const notes = [];
let failed = 0;
const started = Date.now();
console.log(`More Wikipedia facts for ${todo.length} places${dryRun ? ' (dry run)' : ''}${contact ? '' : ` (paced to 10 requests a minute: about ${Math.ceil((todo.length * gapMs) / 60000)} min)`}`);

for (const place of todo) {
  try {
    let source = base.get(place.id)?.source;
    let article;
    if (!source && !facts.some(f => f.placeId === place.id)) {
      // No fact at all: one more, strict look on the local Wikipedia (exact title, mentions the city).
      const names = [place.localName, place.name].filter(Boolean);
      const hits = (await api(localLang, { action: 'query', list: 'search', srsearch: `${names[0]} ${localCity}`, srlimit: '5' }))?.query?.search ?? [];
      const hit = hits.find(h => names.some(n => fold(h.title) === fold(n) || fold(h.title) === fold(`${n} ${localCity}`) || fold(h.title) === fold(`${n} (${localCity})`)));
      if (hit) source = `https://${localLang}.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`;
      else {
        notes.push(`${place.id}: no article`);
        continue;
      }
    }
    if (!source) continue;
    const u = new URL(source);
    const lang = u.host.split('.')[0];
    const title = decodeURIComponent(u.pathname.replace(/^\/wiki\//, '')).replace(/_/g, ' ');
    const page = (await api(lang, { action: 'query', prop: 'extracts', explaintext: '1', exsectionformat: 'wiki', redirects: '1', titles: title }))?.query?.pages?.[0];
    article = page?.extract;
    if (!article) {
      notes.push(`${place.id}: empty article ${lang}:${title}`);
      continue;
    }
    if (!base.has(place.id) && !new RegExp(fold(localCity)).test(fold(article.slice(0, 3000)))) {
      notes.push(`${place.id}: ${lang}:${title} does not mention ${localCity}`);
      continue;
    }
    const { lead, sections } = splitArticle(article);
    const shownStart = fold(base.get(place.id)?.body ?? '').slice(0, 60);
    const picks = [];
    // 1. The lead after what the base fact already says (or all of it for a newly found article).
    const leadRest = base.has(place.id) ? lead.slice(1) : lead;
    const leadText = leadRest.join(' ');
    if (leadText.length >= MIN_BODY && !fold(leadText).startsWith(shownStart || '\u0000')) picks.push({ section: base.has(place.id) ? 'more' : 'overview', text: leadText });
    // 2. Sections, the useful kinds first.
    const usable = sections.filter(s => !SKIP_RE.test(fold(s.title)) && !SKIP.has(fold(s.title)) && s.paragraphs.join(' ').length >= MIN_BODY);
    const ranked = [...usable].sort((a, b) => {
      const ra = PREFER.findIndex(r => r.test(fold(a.title)));
      const rb = PREFER.findIndex(r => r.test(fold(b.title)));
      return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || usable.indexOf(a) - usable.indexOf(b);
    });
    for (const s of ranked) picks.push({ section: s.title, text: s.paragraphs.join(' ') });
    const made = [];
    for (const p of picks) {
      if (made.length >= perPlace) break;
      const body = trimBody(p.text);
      if (body.length < MIN_BODY || made.some(m => fold(m.body).slice(0, 60) === fold(body).slice(0, 60))) continue;
      const nice = p.section === 'more' ? 'More' : p.section === 'overview' ? '' : p.section;
      made.push({
        id: `wikimore-${place.id}-${made.length + 1}`,
        placeId: place.id,
        title: nice ? `${page.title}: ${nice}` : page.title,
        body,
        tags: tagsFor(place, p.section),
        source: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
        license: LICENSE,
      });
    }
    fresh.push(...made);
    console.log(`  ok    ${place.id}: ${lang}:${page.title}, ${made.length} more (${made.map(m => m.title.split(': ')[1] ?? 'overview').join(', ')})`);
  } catch (e) {
    failed++;
    console.log(`  error ${place.id}: ${e.message} (keeping its earlier extra facts)`);
    fresh.push(...facts.filter(f => isMore(f) && f.placeId === place.id));
  }
}

const touched = new Set(todo.map(p => p.id));
const kept = facts.filter(f => !isMore(f) || !touched.has(f.placeId));
const order = new Map(places.map((p, i) => [p.id, i]));
const more = [...kept.filter(isMore), ...fresh].sort((a, b) => (order.get(a.placeId) ?? 1e9) - (order.get(b.placeId) ?? 1e9) || a.id.localeCompare(b.id));
const out = [...kept.filter(f => !isMore(f)), ...more];
if (!dryRun && answered > 0) writeFileSync(factsPath, JSON.stringify(out, null, 1) + '\n');
for (const n of notes) console.log(`  -     ${n}`);
console.log(
  `\n${fresh.length} more facts for ${new Set(fresh.map(f => f.placeId)).size} places; ${out.length} facts in all. ${requests} requests in ${Math.round((Date.now() - started) / 1000)} s.` +
    (dryRun ? ' Dry run: facts.json not written.' : answered ? ` Wrote ${factsPath.replace(/.*\/app\//, 'app/')}.` : ' Wikipedia did not answer: facts.json left as it was.') +
    (failed ? ` ${failed} places failed; run again to retry them.` : ''),
);
if (failed) process.exitCode = 1;
