import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';

import { handleMessage } from '../../../listeners/events/message.js';
import { sessionStore } from '../../../thread-context/index.js';

const OUTSIDER = 'U0OUTSIDER';
const OWNER = 'U0OWNER';

describe('handleMessage access gate', () => {
  let fakeClient;
  let fakeContext;
  let fakeLogger;
  let say;

  const run = (event) => handleMessage({ client: fakeClient, context: fakeContext, event, logger: fakeLogger, say });

  beforeEach(() => {
    fakeClient = {
      users: { info: mock.fn(async () => ({ user: { real_name: 'Outsider' } })) },
      chat: { postMessage: mock.fn(async () => ({ ok: true })) },
    };
    fakeContext = { botUserId: 'U0BOT' };
    fakeLogger = { error: mock.fn(), warn: mock.fn() };
    say = mock.fn(async () => ({ ok: true }));
  });

  it('stays silent on a top-level channel message that does not mention the bot', async () => {
    await run({ channel: 'C1', channel_type: 'channel', user: OUTSIDER, text: 'hello team', ts: '1.0' });
    assert.strictEqual(say.mock.callCount(), 0);
  });

  it('stays silent on a channel thread reply that does not mention the bot', async () => {
    await run({ channel: 'C1', channel_type: 'channel', user: OUTSIDER, text: 'reply', ts: '2.0', thread_ts: '1.0' });
    assert.strictEqual(say.mock.callCount(), 0);
  });

  it('stays silent in a thread the bot is engaged in when the reply does not mention it', async () => {
    sessionStore.setSession('C2', '1.0', 'session-1');
    await run({ channel: 'C2', channel_type: 'channel', user: OUTSIDER, text: 'reply', ts: '2.0', thread_ts: '1.0' });
    assert.strictEqual(say.mock.callCount(), 0);
  });

  it('stays silent for a whitelisted user in a thread the bot is engaged in without a mention', async () => {
    sessionStore.setSession('C3', '1.0', 'session-2');
    await run({
      channel: 'C3',
      channel_type: 'channel',
      user: OWNER,
      text: 'thanks Daniel',
      ts: '2.0',
      thread_ts: '1.0',
    });
    assert.strictEqual(say.mock.callCount(), 0);
  });

  it('replies with the gate message to a DM from a non-whitelisted user', async () => {
    await run({ channel: 'D1', channel_type: 'im', user: OUTSIDER, text: 'hi', ts: '3.0' });
    assert.strictEqual(say.mock.callCount(), 1);
    assert.match(say.mock.calls[0].arguments[0].text, /work in progress/);
  });
});
