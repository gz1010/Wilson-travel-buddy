// Where the app finds its two local helpers. Both must stay on 127.0.0.1 in
// anything committed: the judged build runs with Wi-Fi off.
//
// Development only: if Bonsai-2 is too slow on the Intel Mac, point LLM_URL
// at A's machine (e.g. 'http://192.168.1.20:8081') locally, and never commit it.
export const LLM_URL = 'http://127.0.0.1:8080';
export const AUDIO_HELPER_URL = 'ws://127.0.0.1:8765';

// Which UI to show. 'classic' is the working three-column layout; 'dusk' is the liquid-glass
// redesign being built. Switch to 'dusk' once its screens are in.
export const UI_DESIGN: 'classic' | 'dusk' = 'classic';
