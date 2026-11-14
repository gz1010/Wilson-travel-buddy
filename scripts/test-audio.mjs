#!/usr/bin/env node
// Tests the Argmax audio helper from the terminal, without the app.
// Start the helper first (audio-helper/.build/release/BuddyAudio), then:
//
//   node scripts/test-audio.mjs speak "Hola, ¿dónde está la catedral?" es
//   node scripts/test-audio.mjs listen            # say one sentence; prints partials, then the final text
//   node scripts/test-audio.mjs conversation      # two people talk, English and Spanish; Ctrl-C to stop
//
// Needs Node 22 or newer (built-in WebSocket).
const [mode = 'speak', text = 'Hello! I am your travel buddy.', lang = 'en'] = process.argv.slice(2);
const ws = new WebSocket('ws://127.0.0.1:8765');
const send = m => ws.send(JSON.stringify(m));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

ws.onerror = () => {
  console.error('Could not connect to ws://127.0.0.1:8765. Is BuddyAudio running?');
  process.exit(1);
};
ws.onopen = () => send({ type: 'hello', version: 1 });
let started = false;
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.type === 'level') return;
  if (m.type === 'status') return console.log(`[${at()}] status: ${m.message}`);
  if (m.type === 'error') return console.log(`[${at()}] ERROR: ${m.message}`);
  if (m.type === 'ready') {
    if (started) return;
    started = true;
    console.log(`[${at()}] ready: ${m.models.join(' | ')} (live speakers: ${m.liveSpeakers})`);
    if (mode === 'speak') send({ type: 'speak', id: 'test', text, language: lang });
    else if (mode === 'listen') { console.log('Speak now…'); send({ type: 'listen.start', language: 'en' }); }
    else if (mode === 'conversation') {
      console.log('Talk, taking turns (English and Spanish). Ctrl-C to stop.');
      send({ type: 'conversation.start', languages: ['en', 'es'] });
      process.on('SIGINT', () => { send({ type: 'conversation.stop' }); setTimeout(() => process.exit(0), 300); });
    }
    return;
  }
  if (m.type === 'partial') return console.log(`[${at()}] partial${m.speaker !== undefined ? ` (speaker ${m.speaker})` : ''}: ${m.text}`);
  if (m.type === 'final') return console.log(`[${at()}] FINAL (${m.language ?? '?'}${m.speaker !== undefined ? `, speaker ${m.speaker}` : ''}): ${m.text}`);
  if (m.type === 'speak.done') { console.log(`[${at()}] finished speaking`); process.exit(0); }
  if (m.type === 'listen.done') { console.log(`[${at()}] listen done`); process.exit(0); }
};
