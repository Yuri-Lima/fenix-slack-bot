import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';

import { createSlackSendMessageTool, parseThreadRef } from '../../../agent/tools/slack.js';

const LINK = 'https://acme.slack.com/archives/C0NEWS/p1794486526038069';

/** A Slack client with one public channel, two people and a working postMessage. */
function fakeSlack() {
  return {
    conversations: {
      list: mock.fn(async ({ cursor }) =>
        cursor
          ? { channels: [{ id: 'C0NEWS', name: 'team-news' }] }
          : { channels: [{ id: 'C0RANDOM', name: 'random' }], response_metadata: { next_cursor: 'page2' } },
      ),
    },
    users: {
      list: mock.fn(async () => ({
        members: [
          { id: 'U0ALEX', name: 'alex', real_name: 'Alex R', profile: { display_name: 'Alex' } },
          { id: 'U0ALEX2', name: 'alex.b', real_name: 'Alex B', profile: { display_name: 'Alex' } },
          { id: 'U0SAM', name: 'sam', real_name: 'Sam H', profile: { display_name: '' } },
          { id: 'U0GONE', name: 'gone', deleted: true },
        ],
      })),
    },
    chat: {
      postMessage: mock.fn(async ({ channel }) => ({
        ok: true,
        channel: channel.startsWith('U') ? 'D0DM' : channel,
        ts: '1.000001',
      })),
      getPermalink: mock.fn(async () => ({ permalink: 'https://acme.slack.com/archives/X/p1000001' })),
    },
  };
}

/** @param {ReturnType<typeof fakeSlack>} slack @param {object} args */
const send = (slack, args) => createSlackSendMessageTool(/** @type {any} */ (slack)).handler(args, {});

describe('parseThreadRef', () => {
  it('reads a ts, a message link, and a reply link (which points at its parent)', () => {
    assert.deepStrictEqual(parseThreadRef('1794486526.038069'), { ts: '1794486526.038069' });
    assert.deepStrictEqual(parseThreadRef(LINK), { channel: 'C0NEWS', ts: '1794486526.038069' });
    assert.deepStrictEqual(parseThreadRef(`${LINK}?thread_ts=1794480000.000100&cid=C0NEWS`), {
      channel: 'C0NEWS',
      ts: '1794480000.000100',
    });
  });

  it('rejects anything that is not a Slack message link', () => {
    assert.strictEqual(parseThreadRef('https://evil.example/archives/C0NEWS/p1794486526038069'), null);
    assert.strictEqual(parseThreadRef('yesterday'), null);
  });
});

describe('slack_send_message', () => {
  /** @type {ReturnType<typeof fakeSlack>} */
  let slack;
  beforeEach(() => {
    slack = fakeSlack();
  });

  it("DMs the bot owner for 'me' and returns the message link", async () => {
    const r = await send(slack, { to: 'me', text: '*Hello*' });
    assert.ok(!r.isError, r.content[0].text);
    const msg = slack.chat.postMessage.mock.calls[0].arguments[0];
    assert.strictEqual(msg.channel, 'U0OWNER');
    assert.strictEqual(msg.text, '*Hello*');
    assert.match(r.content[0].text, /^Sent to me\. https:\/\/acme\.slack\.com\//);
  });

  it('finds a channel by name across pages and reuses the directory', async () => {
    await send(slack, { to: '#team-news', text: 'a' });
    const tool = createSlackSendMessageTool(/** @type {any} */ (slack));
    await tool.handler({ to: 'Team-News', text: 'b' }, {});
    await tool.handler({ to: '#random', text: 'c' }, {});
    assert.deepStrictEqual(
      slack.chat.postMessage.mock.calls.map((c) => c.arguments[0].channel),
      ['C0NEWS', 'C0NEWS', 'C0RANDOM'],
    );
    // Two pages for the first tool, two for the second; its second call used the cache
    assert.strictEqual(slack.conversations.list.mock.callCount(), 4);
  });

  it('DMs a person by handle, and asks for an ID when a name is ambiguous', async () => {
    await send(slack, { to: '@sam', text: 'hi' });
    assert.strictEqual(slack.chat.postMessage.mock.calls[0].arguments[0].channel, 'U0SAM');
    const r = await send(slack, { to: '@Alex', text: 'hi' });
    assert.ok(r.isError);
    assert.match(r.content[0].text, /U0ALEX.*U0ALEX2/);
    assert.strictEqual(slack.chat.postMessage.mock.callCount(), 1);
  });

  it('replies in the thread a link points to, without needing `to`', async () => {
    await send(slack, { thread: LINK, text: 'reply' });
    const msg = slack.chat.postMessage.mock.calls[0].arguments[0];
    assert.strictEqual(msg.channel, 'C0NEWS');
    assert.strictEqual(msg.thread_ts, '1794486526.038069');
  });

  it('refuses a thread link in another conversation than `to`', async () => {
    const r = await send(slack, { to: '#random', thread: LINK, text: 'x' });
    assert.ok(r.isError);
    assert.strictEqual(slack.chat.postMessage.mock.callCount(), 0);
  });

  it('reports unknown targets and explains Slack errors without throwing', async () => {
    const unknown = await send(slack, { to: '#nope', text: 'x' });
    assert.ok(unknown.isError);
    assert.match(unknown.content[0].text, /No channel called "#nope"/);

    slack.chat.postMessage = mock.fn(async () => {
      throw Object.assign(new Error('An API error occurred: not_in_channel'), { data: { error: 'not_in_channel' } });
    });
    const r = await send(slack, { to: 'G0PRIVATE1', text: 'x' });
    assert.ok(r.isError);
    assert.match(r.content[0].text, /\/invite @Fenix/);
  });

  it('needs somewhere to post', async () => {
    const r = await send(slack, { text: 'x' });
    assert.ok(r.isError);
    assert.strictEqual(slack.chat.postMessage.mock.callCount(), 0);
  });
});
