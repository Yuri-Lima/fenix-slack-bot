import assert from 'node:assert';
import { after, before, describe, it, mock } from 'node:test';

process.env.FENIX_MCP_TOKEN = 'static-test-token';

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { config } = await import('../../config.js');
const { startMcpServer } = await import('../../mcp/server.js');
const { clientForToken, createClient, listClients, revokeClient } = await import('../../mcp/clients.js');
const { handleMcpSendDecision } = await import('../../listeners/actions/mcp-send-approval.js');
const { flushUsage, monthKey, readMonth } = await import('../../utils/usage-store.js');
const { DISCARD_ACTION, SEND_ACTION } = await import('../../listeners/views/mcp-send-approval-builder.js');

const OWNER = 'U0OWNER';

describe('MCP client registry', () => {
  after(() => {
    for (const name of ['reg-test', 'reg-rotate']) revokeClient(name);
  });

  it('creates read-only clients by default and finds them by token', () => {
    const { token, client } = createClient('reg-test');
    assert.match(token, /^fenix_mcp_/);
    assert.deepStrictEqual(client.scopes, ['read']);
    assert.deepStrictEqual(clientForToken(token), { name: 'reg-test', scopes: ['read'], sendApproval: 'slack' });
    assert.ok(!JSON.stringify(listClients()).includes(token), 'tokens are never stored or listed');
    assert.ok(!('tokenHash' in listClients()[0]));
  });

  it('rotates a token by creating the same name again, and revokes', () => {
    const first = createClient('reg-rotate', { send: true });
    const second = createClient('reg-rotate', { send: true, sendApproval: 'none' });
    assert.strictEqual(clientForToken(first.token), null);
    assert.deepStrictEqual(clientForToken(second.token)?.scopes, ['read', 'send']);
    assert.ok(revokeClient('reg-rotate'));
    assert.strictEqual(clientForToken(second.token), null);
  });

  it('refuses reserved and malformed names, and unknown tokens', () => {
    assert.throws(() => createClient('claude-code'), /reserved/);
    assert.throws(() => createClient('app-claude'), /reserved/);
    assert.throws(() => createClient('Bad Name'), /lowercase/);
    assert.strictEqual(clientForToken('fenix_mcp_not-a-real-token'), null);
    assert.strictEqual(clientForToken('static-test-token'), null);
  });
});

describe('MCP endpoint with named clients', () => {
  /** @type {import('node:http').Server} */
  let http;
  let base;
  /** @type {string[]} */
  const logLines = [];
  const slack = {
    chat: {
      postMessage: mock.fn(async (/** @type {any} */ msg) => ({ ok: true, channel: msg.channel, ts: '1.000001' })),
      update: mock.fn(async () => ({ ok: true })),
      getPermalink: mock.fn(async () => ({ permalink: 'https://acme.slack.com/archives/D1/p1000001' })),
    },
  };
  /** @type {Record<string, string>} */
  const tokens = {};

  before(async () => {
    tokens.reader = createClient('srv-reader').token;
    tokens.drafter = createClient('srv-drafter', { send: true }).token;
    tokens.sender = createClient('srv-sender', { send: true, sendApproval: 'none' }).token;
    config.mcp = { ...config.mcp, enabled: true, host: '127.0.0.1', port: 0 };
    http = startMcpServer({ info: (m) => logLines.push(m), error: () => {} }, slack);
    await new Promise((resolve) => http.once('listening', resolve));
    base = `http://127.0.0.1:${http.address().port}`;
  });

  after(async () => {
    for (const name of ['srv-reader', 'srv-drafter', 'srv-sender']) revokeClient(name);
    await new Promise((resolve) => http.close(resolve));
  });

  /** @param {string} token */
  const connect = async (token) => {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };

  /** Click a button on the last approval DM as `user`. */
  const click = async (/** @type {string} */ actionId, /** @type {string} */ user = OWNER) => {
    const dm = slack.chat.postMessage.mock.calls.findLast((c) =>
      c.arguments[0].blocks?.some((/** @type {any} */ b) => b.type === 'actions'),
    ).arguments[0];
    const id = dm.blocks.find((/** @type {any} */ b) => b.type === 'actions').elements[0].value;
    await handleMcpSendDecision(
      /** @type {any} */ ({
        ack: async () => {},
        body: {
          user: { id: user },
          actions: [{ action_id: actionId, value: id }],
          channel: { id: 'D1' },
          message: { ts: '1.0' },
        },
        client: slack,
        logger: { error: () => {} },
      }),
    );
  };

  it('gives a read-only client every read tool but no way to send', async () => {
    const client = await connect(tokens.reader);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('slack_users') && names.includes('host_health'));
    assert.ok(!names.includes('slack_send_message'));
    await client.close();
    assert.ok(
      logLines.some((l) => /MCP POST \/mcp 200 .* client=srv-reader/.test(l)),
      'requests are logged by client',
    );
  });

  it('holds a drafting client’s message until an owner clicks Send, then posts it', async () => {
    const client = await connect(tokens.drafter);
    const tool = (await client.listTools()).tools.find((t) => t.name === 'slack_send_message');
    assert.match(tool?.description || '', /owner in Slack, who must click Send/);

    const before = slack.chat.postMessage.mock.callCount();
    const r = await client.callTool({ name: 'slack_send_message', arguments: { to: 'me', text: 'Deploy done' } });
    assert.ok(!r.isError);
    assert.match(
      /** @type {any} */ (r.content)[0].text,
      /^Not posted yet\. Messages from srv-drafter need the owner's approval/,
    );
    // Only the approval DM went out, with the draft quoted
    assert.strictEqual(slack.chat.postMessage.mock.callCount(), before + 1);
    const dm = slack.chat.postMessage.mock.calls.at(-1).arguments[0];
    assert.strictEqual(dm.channel, OWNER);
    assert.match(JSON.stringify(dm.blocks), /srv-drafter\* wants to post as Fenix to \*me\*/);
    assert.match(JSON.stringify(dm.blocks), />Deploy done/);

    await click(SEND_ACTION, 'U0STRANGER'); // non-owners are ignored
    assert.strictEqual(slack.chat.postMessage.mock.callCount(), before + 1);

    await click(SEND_ACTION);
    const posted = slack.chat.postMessage.mock.calls.at(-1).arguments[0];
    assert.deepStrictEqual([posted.channel, posted.text], [OWNER, 'Deploy done']);
    assert.match(
      JSON.stringify(slack.chat.update.mock.calls.at(-1).arguments[0].blocks),
      /sent \*srv-drafter\*'s message/,
    );

    await click(SEND_ACTION); // a draft is decided once
    assert.match(
      JSON.stringify(slack.chat.update.mock.calls.at(-1).arguments[0].blocks),
      /expired, was already decided/,
    );
    assert.strictEqual(slack.chat.postMessage.mock.callCount(), before + 2);
    await client.close();
  });

  it('posts nothing when the owner discards a draft', async () => {
    const client = await connect(tokens.drafter);
    await client.callTool({ name: 'slack_send_message', arguments: { to: 'me', text: 'Not this one' } });
    const before = slack.chat.postMessage.mock.callCount();
    await click(DISCARD_ACTION);
    assert.strictEqual(slack.chat.postMessage.mock.callCount(), before);
    assert.match(
      JSON.stringify(slack.chat.update.mock.calls.at(-1).arguments[0].blocks),
      /discarded \*srv-drafter\*'s message/,
    );
    await client.close();
  });

  it('lets a client with sendApproval "none" post directly', async () => {
    const client = await connect(tokens.sender);
    const r = await client.callTool({ name: 'slack_send_message', arguments: { to: 'me', text: 'Direct' } });
    assert.match(/** @type {any} */ (r.content)[0].text, /^Sent to me\./);
    assert.strictEqual(slack.chat.postMessage.mock.calls.at(-1).arguments[0].text, 'Direct');
    await client.close();
  });

  it('records each owner decision in the usage log, under the client and the owner', async () => {
    await flushUsage();
    const decisions = readMonth(monthKey(new Date())).filter((r) => r.subject?.startsWith('slack_send_message '));
    const sent = decisions.findLast((r) => r.subject === 'slack_send_message sent');
    const discarded = decisions.findLast((r) => r.subject === 'slack_send_message discarded');
    assert.deepStrictEqual(
      [sent?.kind, sent?.userName, sent?.userId, sent?.outcome],
      ['mcp', 'srv-drafter', OWNER, 'ok'],
    );
    assert.strictEqual(discarded?.userName, 'srv-drafter');
    assert.deepStrictEqual(sent?.tools, {}, 'the decision does not count as a second tool call');
  });

  it('rejects revoked tokens on the next request', async () => {
    revokeClient('srv-reader');
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.reader}` } });
    assert.strictEqual(r.status, 401);
  });
});
