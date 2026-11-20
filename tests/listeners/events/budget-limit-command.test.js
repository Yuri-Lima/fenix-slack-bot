import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

import { handleLimitCommand, parseLimitCommand } from '../../../listeners/events/budget-limit-command.js';
import { resetLimits } from '../../../utils/budget-limits.js';

describe('parseLimitCommand', () => {
  it('reads list, set and reset commands', () => {
    assert.deepStrictEqual(parseLimitCommand('limits'), { action: 'list' });
    assert.deepStrictEqual(parseLimitCommand('limit <@U0ALLOWED> 5'), {
      action: 'set',
      who: '<@U0ALLOWED>',
      dailyUsd: 5,
    });
    assert.deepStrictEqual(parseLimitCommand('limit Dana $5/day 50 per month until end of month.'), {
      action: 'set',
      who: 'Dana',
      dailyUsd: 5,
      monthlyUsd: 50,
      until: 'end of month',
    });
    assert.deepStrictEqual(parseLimitCommand('Limit Big Spender 7.5 a day until 2026-11-30'), {
      action: 'set',
      who: 'Big Spender',
      dailyUsd: 7.5,
      until: '2026-11-30',
    });
    assert.deepStrictEqual(parseLimitCommand('limit <@U0ALLOWED> reset'), { action: 'reset', who: '<@U0ALLOWED>' });
  });

  it('leaves anything else to the agent', () => {
    for (const text of [
      'limit the logs to the last 5 minutes',
      'limit 5',
      'limit Dana',
      'limit Dana 5/day 6/day',
      'what are the limits?',
      'limit Dana reset until end of month',
    ]) {
      assert.strictEqual(parseLimitCommand(text), null, text);
    }
  });
});

describe('handleLimitCommand', () => {
  const client = () => ({
    chat: { postMessage: mock.fn(async () => ({ ok: true })) },
    users: {
      info: mock.fn(async ({ user }) => ({ user: { real_name: user === 'U0ALLOWED' ? 'Allowed Person' : user } })),
    },
  });

  it('sets a limit by name and answers in the thread', async () => {
    const c = client();
    try {
      await handleLimitCommand({
        client: /** @type {any} */ (c),
        channel: 'D0ADMIN',
        threadTs: '1.0',
        command: { action: 'set', who: 'allowed', dailyUsd: 4 },
        actor: 'Owner',
      });
      const { channel, thread_ts: thread, text } = c.chat.postMessage.mock.calls[0].arguments[0];
      assert.deepStrictEqual([channel, thread], ['D0ADMIN', '1.0']);
      assert.match(text, /^Done\. Allowed Person: \$4\.00 a day, \$30\.00 a month \(set by Owner on /);
    } finally {
      resetLimits({ id: 'U0ALLOWED', name: 'Allowed Person' });
    }
  });

  it('says who it knows when the name matches nobody', async () => {
    const c = client();
    await handleLimitCommand({
      client: /** @type {any} */ (c),
      channel: 'D0ADMIN',
      threadTs: '1.0',
      command: { action: 'reset', who: 'nobody' },
      actor: 'Owner',
    });
    assert.match(
      c.chat.postMessage.mock.calls[0].arguments[0].text,
      /I don't know anyone called "nobody".*Try `limits`/,
    );
  });
});
