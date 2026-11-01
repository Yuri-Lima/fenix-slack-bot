import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';

import { handleAppMentioned } from '../../../listeners/events/app-mentioned.js';
import { deleteBotMessagesInThread, isDeleteCommand } from '../../../listeners/events/delete-thread.js';
import { sessionStore } from '../../../thread-context/index.js';

const OWNER = 'U0OWNER';
const OUTSIDER = 'U0OUTSIDER';
const BOT_USER = 'U0BOT';
const BOT_ID = 'B0BOT';

describe('isDeleteCommand', () => {
  it('matches the bare command, case-insensitively', () => {
    assert.ok(isDeleteCommand('delete'));
    assert.ok(isDeleteCommand('  Delete '));
    assert.ok(isDeleteCommand('delete!'));
  });

  it('does not match a sentence that mentions delete', () => {
    assert.ok(!isDeleteCommand('how do I delete a document?'));
    assert.ok(!isDeleteCommand('delete everything'));
    assert.ok(!isDeleteCommand(''));
  });
});

describe('deleteBotMessagesInThread', () => {
  let fakeClient;
  let fakeLogger;

  beforeEach(() => {
    fakeClient = {
      conversations: {
        replies: mock.fn(async () => ({
          messages: [
            { ts: '1.0', user: BOT_USER, bot_id: BOT_ID },
            { ts: '2.0', user: OWNER },
            { ts: '3.0', user: BOT_USER, bot_id: BOT_ID },
            { ts: '4.0', bot_id: 'B0TEAMCITY' },
          ],
        })),
      },
      chat: { delete: mock.fn(async () => ({ ok: true })) },
    };
    fakeLogger = { error: mock.fn(), warn: mock.fn() };
  });

  it('deletes only the bot messages, replies before the parent', async () => {
    const result = await deleteBotMessagesInThread({
      client: fakeClient,
      channelId: 'C1',
      threadTs: '1.0',
      botUserId: BOT_USER,
      botId: BOT_ID,
      logger: fakeLogger,
    });
    assert.deepStrictEqual(result, { deleted: 2, failed: 0 });
    const deletedTs = fakeClient.chat.delete.mock.calls.map((c) => c.arguments[0].ts);
    assert.deepStrictEqual(deletedTs, ['3.0', '1.0']);
  });

  it('counts failures and keeps going', async () => {
    fakeClient.chat.delete = mock.fn(async ({ ts }) => {
      if (ts === '3.0') throw new Error('message_not_found');
      return { ok: true };
    });
    const result = await deleteBotMessagesInThread({
      client: fakeClient,
      channelId: 'C1',
      threadTs: '1.0',
      botUserId: BOT_USER,
      botId: BOT_ID,
      logger: fakeLogger,
    });
    assert.deepStrictEqual(result, { deleted: 1, failed: 1 });
    assert.strictEqual(fakeLogger.error.mock.callCount(), 1);
  });

  it('forgets the thread session', async () => {
    sessionStore.setSession('C1', '1.0', 'session-1');
    await deleteBotMessagesInThread({
      client: fakeClient,
      channelId: 'C1',
      threadTs: '1.0',
      botUserId: BOT_USER,
      botId: BOT_ID,
      logger: fakeLogger,
    });
    assert.strictEqual(sessionStore.getSession('C1', '1.0'), null);
  });
});

describe('handleAppMentioned delete command', () => {
  let fakeClient;
  let fakeLogger;
  let say;

  const run = (event) =>
    handleAppMentioned({
      client: fakeClient,
      context: { botUserId: BOT_USER, botId: BOT_ID },
      event,
      logger: fakeLogger,
      say,
    });

  beforeEach(() => {
    fakeClient = {
      conversations: { replies: mock.fn(async () => ({ messages: [{ ts: '1.0', user: BOT_USER }] })) },
      chat: {
        delete: mock.fn(async () => ({ ok: true })),
        postEphemeral: mock.fn(async () => ({ ok: true })),
      },
    };
    fakeLogger = { error: mock.fn(), warn: mock.fn() };
    say = mock.fn(async () => ({ ok: true }));
  });

  it('deletes the thread messages for the owner and confirms ephemerally', async () => {
    await run({ channel: 'C1', user: OWNER, text: `<@${BOT_USER}> delete`, ts: '5.0', thread_ts: '1.0' });
    const deletedTs = fakeClient.chat.delete.mock.calls.map((c) => c.arguments[0].ts);
    assert.deepStrictEqual(deletedTs, ['1.0', '5.0']);
    assert.strictEqual(fakeClient.chat.postEphemeral.mock.callCount(), 1);
    assert.match(fakeClient.chat.postEphemeral.mock.calls[0].arguments[0].text, /Deleted 1/);
    assert.strictEqual(say.mock.callCount(), 0);
  });

  it('ignores the command from anyone else without replying', async () => {
    await run({ channel: 'C1', user: OUTSIDER, text: `<@${BOT_USER}> delete`, ts: '5.0', thread_ts: '1.0' });
    assert.strictEqual(fakeClient.chat.delete.mock.callCount(), 0);
    assert.strictEqual(fakeClient.chat.postEphemeral.mock.callCount(), 0);
    assert.strictEqual(say.mock.callCount(), 0);
  });

  it('explains the command when used outside a thread', async () => {
    await run({ channel: 'C1', user: OWNER, text: `<@${BOT_USER}> delete`, ts: '5.0' });
    assert.strictEqual(fakeClient.chat.delete.mock.callCount(), 0);
    assert.match(fakeClient.chat.postEphemeral.mock.calls[0].arguments[0].text, /inside a thread/);
  });
});
