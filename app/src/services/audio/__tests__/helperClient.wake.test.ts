import type { WakeEvent } from '../../../core/types';
import { HelperAudioClient } from '../helperClient';
import { TypedAudio } from '../typedAudio';

/** A stand-in WebSocket: records what the app sends; `deliver` plays a helper message. */
class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket;
  readyState = 0;
  sent: any[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (ev: { data: string }) => void;
  constructor(public url: string) {
    FakeSocket.last = this;
    setTimeout(() => {
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    }, 0);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  deliver(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

const realWebSocket = (globalThis as any).WebSocket;
beforeAll(() => {
  (globalThis as any).WebSocket = FakeSocket;
});
afterAll(() => {
  (globalThis as any).WebSocket = realWebSocket;
});

async function connected(ready: object = { type: 'ready', version: 1, models: ['Whisper'], liveSpeakers: false, camera: true, wake: true }) {
  const client = new HelperAudioClient();
  const ok = client.connect('ws://test', 1000, 1000);
  await new Promise<void>(r => setTimeout(r, 5));
  FakeSocket.last.deliver(ready);
  expect(await ok).toBe(true);
  return { client, ws: FakeSocket.last };
}

describe('HelperAudioClient: wake word and levels', () => {
  it('reads ready.wake into info.wake', async () => {
    const { client } = await connected();
    expect(client.info.wake).toBe(true);
    const old = await connected({ type: 'ready', version: 1, models: [], liveSpeakers: false });
    expect(old.client.info.wake).toBe(false);
  });

  it('wake() sends wake.start, keeps it alive, passes the events on, and stop() sends wake.stop', async () => {
    const { client, ws } = await connected();
    jest.useFakeTimers();
    try {
      const events: WakeEvent[] = [];
      const stop = client.wake(e => events.push(e), 5000);
      expect(ws.sent.filter(m => m.type === 'wake.start')).toHaveLength(1);
      jest.advanceTimersByTime(10_000);
      expect(ws.sent.filter(m => m.type === 'wake.start')).toHaveLength(3);

      jest.spyOn(Date, 'now').mockReturnValue(50_000);
      ws.deliver({ type: 'wake.state', listening: true });
      ws.deliver({ type: 'wake.heard', text: 'Where is' });
      ws.deliver({ type: 'wake', text: 'Where is the cathedral?', heard: 'Wilson, where is the cathedral?', sinceEndMs: 800 });
      expect(events).toEqual([
        { type: 'state', listening: true },
        { type: 'heard', text: 'Where is' },
        { type: 'wake', text: 'Where is the cathedral?', heard: 'Wilson, where is the cathedral?', endedAt: 49_200 },
      ]);

      stop();
      expect(ws.sent[ws.sent.length - 1]).toEqual({ type: 'wake.stop' });
      jest.advanceTimersByTime(10_000);
      expect(ws.sent.filter(m => m.type === 'wake.start')).toHaveLength(3); // keepalive stopped
      ws.deliver({ type: 'wake', text: 'late', heard: 'Wilson, late' });
      expect(events).toHaveLength(3);
    } finally {
      jest.restoreAllMocks();
      jest.useRealTimers();
    }
  });

  it('a helper without the wake word gets no wake.start', async () => {
    const { client, ws } = await connected({ type: 'ready', version: 1, models: [], liveSpeakers: false });
    const stop = client.wake(() => {});
    stop();
    expect(ws.sent.some(m => m.type.startsWith('wake'))).toBe(false);
  });

  it('levels: level is the microphone, speak.level the voice, clamped; the old onLevel slot still works', async () => {
    const { client, ws } = await connected();
    const got: string[] = [];
    const onLevel = jest.fn();
    client.onLevel = onLevel;
    const off = client.subscribeLevels((kind, v) => got.push(`${kind} ${v}`));
    ws.deliver({ type: 'level', value: 0.4 });
    ws.deliver({ type: 'speak.level', value: 1.7 });
    off();
    ws.deliver({ type: 'speak.level', value: 0.2 });
    expect(got).toEqual(['mic 0.4', 'voice 1']);
    expect(onLevel).toHaveBeenCalledWith(0.4);
  });

  it('listen() passes quietMs for the follow-up', async () => {
    const { client, ws } = await connected();
    const heard = client.listen(() => {}, 'en', { quietMs: 6000 });
    expect(ws.sent[ws.sent.length - 1]).toEqual({ type: 'listen.start', language: 'en', quietMs: 6000 });
    ws.deliver({ type: 'final', text: 'Where now?' });
    ws.deliver({ type: 'listen.done', sinceEndMs: 100 });
    expect((await heard).text).toBe('Where now?');
  });

  it('listen() sends quietMs as a whole number (the helper decodes an Int and would drop the message)', async () => {
    const { client, ws } = await connected();
    client.listen(() => {}, 'en', { quietMs: 5999.6 });
    expect(ws.sent[ws.sent.length - 1]).toEqual({ type: 'listen.start', language: 'en', quietMs: 6000 });
    ws.deliver({ type: 'listen.done' });
    client.listen(() => {}, 'en', { quietMs: Number.NaN });
    expect(ws.sent[ws.sent.length - 1]).toEqual({ type: 'listen.start', language: 'en' });
    ws.deliver({ type: 'listen.done' });
  });

  it('a disconnect tells the wake word it stopped and zeroes the levels', async () => {
    const { client, ws } = await connected();
    const events: WakeEvent[] = [];
    const levels: string[] = [];
    client.wake(e => events.push(e));
    client.subscribeLevels((kind, v) => levels.push(`${kind} ${v}`));
    ws.deliver({ type: 'speak.level', value: 0.5 });
    ws.close();
    expect(events[events.length - 1]).toEqual({ type: 'state', listening: false });
    expect(levels).toEqual(['voice 0.5', 'mic 0', 'voice 0']);
  });
});

describe('TypedAudio (no helper)', () => {
  it('has no wake word and no levels, without throwing', () => {
    const typed = new TypedAudio([]);
    expect(typed.info.wake).toBeUndefined();
    const stop = typed.wake(() => {});
    const off = typed.subscribeLevels(() => {});
    expect(() => {
      stop();
      off();
    }).not.toThrow();
  });
});
