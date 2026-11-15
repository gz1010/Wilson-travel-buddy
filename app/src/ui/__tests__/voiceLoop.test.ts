import type { Heard } from '../../core/types';
import { SUMMONED_REPLY, VoiceLoop, type VoiceLoopDeps } from '../voiceLoop';

/**
 * A scripted microphone and companion: each listen() takes the next line ('' = silence), each
 * ask() is answered aloud (or not, per `silentAnswers`). The log reads like the exchange.
 */
function rig(heard: string[], opts: { silentAnswers?: string[]; canListen?: () => boolean } = {}) {
  const log: string[] = [];
  const quiet: (number | undefined)[] = [];
  const deps: VoiceLoopDeps = {
    ask: async text => {
      log.push(`ask: ${text}`);
      return { spoke: !opts.silentAnswers?.includes(text) };
    },
    listen: async quietMs => {
      quiet.push(quietMs);
      const text = heard.shift() ?? '';
      log.push(`listen${quietMs ? ' (follow-up)' : ''}: ${text || '(silence)'}`);
      return { text, endedAt: text ? 1000 : undefined } as Heard;
    },
    say: async text => {
      log.push(`say: ${text}`);
    },
    onFollowUp: on => log.push(on ? 'follow-up on' : 'follow-up off'),
    canListen: opts.canListen,
  };
  return { log, quiet, deps, loop: new VoiceLoop(deps, { followUpMs: 6000, maxTurns: 8 }) };
}

describe('VoiceLoop (call and response)', () => {
  it('a tap: listens, asks, then keeps listening for follow-ups until silence', async () => {
    const { log, quiet, loop } = rig(['Where is the cathedral?', 'And is it open now?', '']);
    await loop.listenFirst();
    expect(log).toEqual([
      'listen: Where is the cathedral?',
      'ask: Where is the cathedral?',
      'follow-up on',
      'listen (follow-up): And is it open now?',
      'follow-up off',
      'ask: And is it open now?',
      'follow-up on',
      'listen (follow-up): (silence)',
      'follow-up off',
    ]);
    // The first listen waits as long as the helper likes; follow-ups give up after 6 s of quiet.
    expect(quiet).toEqual([undefined, 6000, 6000]);
    expect(loop.active).toBe(false);
  });

  it('"Thanks, Wilson" or "That\'s all" ends it without asking', async () => {
    for (const bye of ['Thanks, Wilson.', "That's all.", 'No thanks']) {
      const { log, loop } = rig(['Is it going to rain?', bye, 'never asked']);
      await loop.listenFirst();
      expect(log.filter(l => l.startsWith('ask'))).toEqual(['ask: Is it going to rain?']);
      expect(log[log.length - 1]).toBe('follow-up off');
    }
  });

  it('a first "Thank you" still gets an answer (only a follow-up dismisses)', async () => {
    const { log, loop } = rig(['Thank you, Wilson!', '']);
    await loop.listenFirst();
    expect(log).toContain('ask: Thank you, Wilson!');
  });

  it('times a spoken question from when the person stopped talking', async () => {
    const at: (number | undefined)[] = [];
    const loop = new VoiceLoop({
      ask: async (_text, heardAt) => {
        at.push(heardAt);
        return { spoke: false };
      },
      listen: async () => ({ text: 'Where now?' }), // no endedAt from this helper
      say: async () => {},
    });
    const before = Date.now();
    await loop.listenFirst();
    expect(at[0]).toBeGreaterThanOrEqual(before);
  });

  it('the wake word with a question asks it at once, then follows up', async () => {
    const { log, loop } = rig(['']);
    await loop.wake('Where is the cathedral?', 500);
    expect(log).toEqual(['ask: Where is the cathedral?', 'follow-up on', 'listen (follow-up): (silence)', 'follow-up off']);
  });

  it('"Wilson" alone: "Yes?", then listens for the question', async () => {
    const { log, loop } = rig(['What is open for lunch?', '']);
    await loop.wake('');
    expect(log.slice(0, 3)).toEqual([`say: ${SUMMONED_REPLY}`, 'follow-up on', 'listen (follow-up): What is open for lunch?']);
    expect(log).toContain('ask: What is open for lunch?');
  });

  it('drops the name from questions, which is optional when you tap him', async () => {
    const { log, loop } = rig(['Wilson, where can I park?', 'Hey Wilson, and after that?', '']);
    await loop.listenFirst();
    expect(log.filter(l => l.startsWith('ask'))).toEqual(['ask: Where can I park?', 'ask: And after that?']);
  });

  it('a tap that hears only the name gets "Yes?" too; silence after a tap does nothing', async () => {
    const named = rig(['Wilson.', 'Where is the river?', '']);
    await named.loop.listenFirst();
    expect(named.log).toContain(`say: ${SUMMONED_REPLY}`);
    expect(named.log).toContain('ask: Where is the river?');

    const silent = rig(['']);
    await silent.loop.listenFirst();
    expect(silent.log).toEqual(['listen: (silence)']);
  });

  it('no follow-up when the answer was not spoken (error, Translate, voice stopped)', async () => {
    const { log, loop } = rig(['Translate for me', 'should not be heard'], { silentAnswers: ['Translate for me'] });
    await loop.listenFirst();
    expect(log).toEqual(['listen: Translate for me', 'ask: Translate for me']);
  });

  it('no follow-up where Wilson may not listen (no microphone, Translate open)', async () => {
    const { log, loop } = rig([], { canListen: () => false });
    await loop.wake('Where is the cathedral?');
    expect(log).toEqual(['ask: Where is the cathedral?']);
  });

  it('cancel() (a tap, a typed message, stopping his voice) stops it before the follow-up', async () => {
    let finishAnswer!: () => void;
    const listened: string[] = [];
    const loop = new VoiceLoop({
      ask: () => new Promise(resolve => (finishAnswer = () => resolve({ spoke: true }))),
      listen: async () => {
        listened.push('listen');
        return { text: 'more' };
      },
      say: async () => {},
    });
    const running = loop.wake('Where is the cathedral?');
    await Promise.resolve();
    expect(loop.active).toBe(true);
    loop.cancel();
    finishAnswer();
    await running;
    expect(listened).toEqual([]);
    expect(loop.active).toBe(false);
  });

  it('a newer exchange replaces an older one', async () => {
    const asked: string[] = [];
    let finishFirst!: () => void;
    const loop = new VoiceLoop({
      ask: text => {
        asked.push(text);
        return text === 'first' ? new Promise(r => (finishFirst = () => r({ spoke: true }))) : Promise.resolve({ spoke: true });
      },
      listen: async () => ({ text: '' }),
      say: async () => {},
    });
    const first = loop.wake('first');
    await Promise.resolve();
    await loop.wake('second');
    finishFirst();
    await first;
    expect(asked).toEqual(['first', 'second']);
  });

  it('never runs away: at most maxTurns questions in one exchange', async () => {
    const heard = Array.from({ length: 20 }, (_, i) => `question ${i}`);
    const { log, loop } = rig(heard);
    await loop.listenFirst();
    expect(log.filter(l => l.startsWith('ask'))).toHaveLength(8);
  });

  it('a failing microphone or companion ends the exchange quietly', async () => {
    const loop = new VoiceLoop({
      ask: async () => {
        throw new Error('model down');
      },
      listen: async () => {
        throw new Error('no microphone');
      },
      say: async () => {},
    });
    await expect(loop.listenFirst()).resolves.toBeUndefined();
    await expect(loop.wake('Where?')).resolves.toBeUndefined();
  });
});
