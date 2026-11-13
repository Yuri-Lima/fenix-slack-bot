import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';

import {
  createSlackChannelsTool,
  createSlackDirectory,
  createSlackSendMessageTool,
  createSlackUsersTool,
  describeStatus,
  parseThreadRef,
} from '../../../agent/tools/slack.js';

const LINK = 'https://acme.slack.com/archives/C0NEWS/p1794486526038069';
/** 20 Nov 2026 17:00 in Berlin. */
const VACATION_ENDS = Date.UTC(2026, 10, 20, 16, 0) / 1000;

/** A Slack client with two channels, three people (one on vacation, one in a huddle) and a working postMessage. */
function fakeSlack() {
  return {
    conversations: {
      list: mock.fn(async ({ cursor }) =>
        cursor
          ? {
              channels: [
                { id: 'C0NEWS', name: 'team-news', is_member: true },
                { id: 'G0SECRET', name: 'secret-team', is_private: true, is_member: true },
              ],
            }
          : { channels: [{ id: 'C0RANDOM', name: 'random' }], response_metadata: { next_cursor: 'page2' } },
      ),
    },
    auth: { test: mock.fn(async () => ({ user_id: 'U0FENIXBOT', user: 'fenix_bot' })) },
    users: {
      info: mock.fn(async () => ({ user: { name: 'fenix_bot', real_name: 'Fenix (dev)' } })),
      getPresence: mock.fn(async ({ user }) => ({ presence: user === 'U0SAM' ? 'active' : 'away' })),
      list: mock.fn(async () => ({
        members: [
          {
            id: 'U0ALEXR01',
            name: 'alex',
            real_name: 'Alex R',
            tz: 'Europe/Berlin',
            profile: {
              display_name: 'Alex',
              title: 'QA',
              status_emoji: ':palm_tree:',
              status_text: 'Vacation',
              status_expiration: VACATION_ENDS,
            },
          },
          { id: 'U0ALEX2', name: 'alex.b', real_name: 'Alex B', profile: { display_name: 'Alex' } },
          { id: 'U0SAM', name: 'sam', real_name: 'Sam H', profile: { display_name: '', huddle_state: 'in_a_huddle' } },
          { id: 'U0OWNER', name: 'owner', real_name: 'Olivia Owner', tz: 'Europe/Berlin', profile: {} },
          { id: 'B0BOT', name: 'somebot', is_bot: true, profile: {} },
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
    assert.match(r.content[0].text, /^Sent as "Fenix \(dev\)" \(@fenix_bot\) to me\. https:\/\/acme\.slack\.com\//);
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
    assert.match(r.content[0].text, /U0ALEXR01.*U0ALEX2/);
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
    assert.match(unknown.content[0].text, /No channel called "#nope"\. Fenix sees every public channel/);
    assert.match(unknown.content[0].text, /is a private channel: invite Fenix with \/invite @fenix_bot/);

    const typo = await send(slack, { to: '#team-new', text: 'x' });
    assert.match(typo.content[0].text, /Did you mean #team-news\?/);

    slack.chat.postMessage = mock.fn(async () => {
      throw Object.assign(new Error('An API error occurred: not_in_channel'), { data: { error: 'not_in_channel' } });
    });
    const r = await send(slack, { to: 'G0PRIVATE1', text: 'x' });
    assert.ok(r.isError);
    assert.match(r.content[0].text, /\/invite @fenix_bot \(the bot shown as "Fenix \(dev\)"\)/);
  });

  it('needs somewhere to post', async () => {
    const r = await send(slack, { text: 'x' });
    assert.ok(r.isError);
    assert.strictEqual(slack.chat.postMessage.mock.callCount(), 0);
  });
});

describe('describeStatus', () => {
  it("describes a custom status with when it clears, in the person's time zone, and huddles", () => {
    assert.strictEqual(
      describeStatus({
        tz: 'Europe/Berlin',
        profile: { status_emoji: ':palm_tree:', status_text: 'Vacation', status_expiration: VACATION_ENDS },
      }),
      'status :palm_tree: Vacation until Fri 20 Nov, 17:00',
    );
    assert.strictEqual(describeStatus({ profile: { huddle_state: 'in_a_huddle' } }), 'in a huddle');
    assert.strictEqual(describeStatus({ profile: {} }), '');
  });
});

describe('slack_users', () => {
  /** @type {ReturnType<typeof fakeSlack>} */
  let slack;
  beforeEach(() => {
    slack = fakeSlack();
  });

  /** @param {object} args */
  const users = (args) => createSlackUsersTool(/** @type {any} */ (slack)).handler(args, {});

  it('lists active people with presence, status, local time and the owner, leaving out bots and deactivated accounts', async () => {
    const r = await users({});
    assert.ok(!r.isError, r.content[0].text);
    const text = r.content[0].text;
    assert.match(text, /^4 people:/);
    assert.match(
      text,
      /• Alex R \(@alex, U0ALEXR01, QA\): away · status :palm_tree: Vacation until Fri 20 Nov, 17:00 · \d\d:\d\d local \(Europe\/Berlin\)/,
    );
    assert.match(text, /• Sam H \(@sam, U0SAM\): active · in a huddle/);
    assert.match(text, /• Olivia Owner .*bot owner, 'me'/);
    assert.ok(!text.includes('somebot') && !text.includes('U0GONE'));
    assert.strictEqual(slack.users.getPresence.mock.callCount(), 4);
  });

  it('filters by name, handle or title', async () => {
    const text = (await users({ query: '@sam' })).content[0].text;
    assert.match(text, /^1 person:\n• Sam H/);
    assert.match((await users({ query: 'qa' })).content[0].text, /^1 person:\n• Alex R/);
    assert.match((await users({ query: 'nobody' })).content[0].text, /Nobody matches/);
  });

  it('shares one directory with slack_send_message', async () => {
    const directory = createSlackDirectory(/** @type {any} */ (slack));
    await createSlackUsersTool(/** @type {any} */ (slack), directory).handler({}, {});
    await createSlackSendMessageTool(/** @type {any} */ (slack), directory).handler({ to: '@sam', text: 'hi' }, {});
    assert.strictEqual(slack.users.list.mock.callCount(), 1);
  });
});

describe('slack_send_message and recipient status', () => {
  it('notes when the person it DMed has a status', async () => {
    const slack = fakeSlack();
    const r = await send(slack, { to: 'U0ALEXR01', text: 'hi' });
    assert.match(r.content[0].text, /\nNote: Alex R has status :palm_tree: Vacation until Fri 20 Nov, 17:00\.$/);
    const quiet = await send(slack, { to: '#random', text: 'hi' });
    assert.ok(!quiet.content[0].text.includes('Note:'));
  });
});

describe('slack_channels', () => {
  /** @param {object} args */
  const channels = (args) =>
    createSlackChannelsTool(createSlackDirectory(/** @type {any} */ (fakeSlack()))).handler(args, {});

  it('lists where Fenix can post, whether it needs an invite, and which bot it is', async () => {
    const text = (await channels({})).content[0].text;
    assert.match(text, /^3 channels:/);
    assert.match(text, /• #random \(C0RANDOM\): public · Fenix can post without an invite/);
    assert.match(text, /• #secret-team \(G0SECRET\): private · Fenix is a member/);
    assert.match(text, /• #team-news \(C0NEWS\): public · Fenix is a member/);
    assert.match(text, /Fenix posts as "Fenix \(dev\)" \(@fenix_bot\)/);
  });

  it('suggests close names when nothing matches', async () => {
    const text = (await channels({ query: '#team-newz' })).content[0].text;
    assert.match(text, /No channel matches "#team-newz"\. Did you mean #team-news\?/);
  });
});
