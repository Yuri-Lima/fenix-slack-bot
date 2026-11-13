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
const { MP4, PNG } = await import('../fixtures/media.js');
const { createServer } = await import('node:http');
const { existsSync, readdirSync } = await import('node:fs');
const { join } = await import('node:path');
const { resolvePath } = await import('../../config.js');

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
    conversations: { open: mock.fn(async ({ users }) => ({ channel: { id: `D-${users}` } })) },
    files: {
      // Slack's external upload: an upload URL (served by `receiver` below), then completion into a conversation
      getUploadURLExternal: mock.fn(async (/** @type {any} */ a) => ({
        ok: true,
        upload_url: `${receiverUrl}/upload/${a.filename}`,
        file_id: `F-${a.filename}`,
      })),
      completeUploadExternal: mock.fn(async (/** @type {any} */ a) => ({
        ok: true,
        files: [{ id: a.files[0].id, permalink: `https://acme.slack.com/files/U0BOT/${a.files[0].id}` }],
      })),
    },
  };
  /** Bytes Slack's upload URL received, per file name. */
  /** @type {Record<string, { bytes: number, type: string | undefined, length: string | undefined }>} */
  const received = {};
  let receiverUrl = '';
  const receiver = createServer((req, res) => {
    let bytes = 0;
    req.on('data', (c) => {
      bytes += c.length;
    });
    req.on('end', () => {
      received[decodeURIComponent(req.url?.split('/').pop() || '')] = {
        bytes,
        type: req.headers['content-type'],
        length: req.headers['content-length'],
      };
      res.end('OK');
    });
  });
  const uploadDir = join(resolvePath(config.dataDir), 'uploads');
  /** @type {Record<string, string>} */
  const tokens = {};

  before(async () => {
    tokens.reader = createClient('srv-reader').token;
    tokens.drafter = createClient('srv-drafter', { send: true }).token;
    tokens.sender = createClient('srv-sender', { send: true, sendApproval: 'none' }).token;
    config.mcp = { ...config.mcp, enabled: true, host: '127.0.0.1', port: 0 };
    receiver.listen(0, '127.0.0.1');
    await new Promise((resolve) => receiver.once('listening', resolve));
    receiverUrl = `http://127.0.0.1:${/** @type {any} */ (receiver.address()).port}`;
    http = startMcpServer({ info: (m) => logLines.push(m), error: () => {} }, slack);
    await new Promise((resolve) => http.once('listening', resolve));
    base = `http://127.0.0.1:${http.address().port}`;
  });

  after(async () => {
    for (const name of ['srv-reader', 'srv-drafter', 'srv-sender']) revokeClient(name);
    await new Promise((resolve) => http.close(resolve));
    await new Promise((resolve) => receiver.close(resolve));
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

  /** Upload bytes as a client (PUT, as `curl -T` does); returns the parsed reply and status. */
  const upload = async (/** @type {string} */ token, /** @type {Buffer} */ body, filename = 'banner.png') => {
    const r = await fetch(`${base}/uploads?filename=${filename}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body,
    });
    return { status: r.status, body: await r.json() };
  };

  it('accepts image and video uploads only from connections that can send, and only real media', async () => {
    const image = await upload(tokens.sender, PNG);
    assert.strictEqual(image.status, 201);
    assert.match(image.body.upload_id, /^up_/);
    assert.deepStrictEqual(
      [image.body.filename, image.body.kind, image.body.bytes, image.body.expires_in],
      ['banner.png', 'image', PNG.length, 3600],
    );
    const video = await upload(tokens.sender, MP4, 'demo.mov');
    assert.deepStrictEqual([video.status, video.body.kind, video.body.filename], [201, 'video', 'demo.mp4']);

    assert.strictEqual((await upload(tokens.reader, PNG)).status, 403);
    assert.strictEqual(
      (await upload(tokens.sender, Buffer.from('not an image or a video, just text'.repeat(3)))).status,
      415,
    );
    const anon = await fetch(`${base}/uploads`, { method: 'POST', body: PNG });
    assert.strictEqual(anon.status, 401);
  });

  it('streams an uploaded video to Slack with its caption in one message, then deletes it', async () => {
    const client = await connect(tokens.sender);
    const tool = (await client.listTools()).tools.find((t) => t.name === 'slack_send_message');
    assert.match(tool?.description || '', /curl -sS -T <path to file> "https:\/\/fenix-mcp\.example\.com\/uploads/);
    assert.match(tool?.description || '', /~\/\.fenix_mcp_token_srv-sender/);
    assert.match(tool?.description || '', /MP4, MOV or WebM up to 200 MB/);

    const { body } = await upload(tokens.sender, MP4, 'demo.mp4');
    const r = await client.callTool({
      name: 'slack_send_message',
      arguments: { to: 'me', text: 'New demo', attachment: body.upload_id, attachment_alt: 'Product demo' },
    });
    assert.match(/** @type {any} */ (r.content)[0].text, /^Sent to me\. https:\/\/acme\.slack\.com\/files\//);
    assert.deepStrictEqual(slack.files.getUploadURLExternal.mock.calls.at(-1).arguments[0], {
      filename: 'demo.mp4',
      length: MP4.length,
      alt_txt: 'Product demo',
    });
    assert.deepStrictEqual(received['demo.mp4'], { bytes: MP4.length, type: 'video/mp4', length: String(MP4.length) });
    const done = slack.files.completeUploadExternal.mock.calls.at(-1).arguments[0];
    assert.deepStrictEqual([done.channel_id, done.initial_comment], [`D-${OWNER}`, 'New demo']);
    assert.ok(!readdirSync(uploadDir).includes(body.upload_id), 'the file is deleted once posted');

    const reused = await client.callTool({
      name: 'slack_send_message',
      arguments: { to: 'me', attachment: body.upload_id },
    });
    assert.ok(reused.isError, 'an upload is attached once');
    await client.close();
  });

  it('still accepts the older `image` parameter', async () => {
    const client = await connect(tokens.sender);
    const { body } = await upload(tokens.sender, PNG, 'old.png');
    const r = await client.callTool({ name: 'slack_send_message', arguments: { to: 'me', image: body.upload_id } });
    assert.ok(!r.isError);
    assert.strictEqual(received['old.png']?.bytes, PNG.length);
    await client.close();
  });

  it('previews an attachment in the approval DM, posts it on Send, and deletes it', async () => {
    const drafter = await connect(tokens.drafter);
    const sender = await connect(tokens.sender);
    const { body } = await upload(tokens.drafter, MP4, 'clip.mp4');
    // Another client cannot use this upload
    const stolen = await sender.callTool({
      name: 'slack_send_message',
      arguments: { to: 'me', attachment: body.upload_id },
    });
    assert.ok(stolen.isError);

    const completions = slack.files.completeUploadExternal.mock.callCount();
    const r = await drafter.callTool({
      name: 'slack_send_message',
      arguments: { to: 'C0NEWS01', text: 'Release clip', attachment: body.upload_id },
    });
    assert.match(/** @type {any} */ (r.content)[0].text, /^Not posted yet/);
    // One upload so far: the preview, into the owner's DM, before the buttons
    assert.strictEqual(slack.files.completeUploadExternal.mock.callCount(), completions + 1);
    const preview = slack.files.completeUploadExternal.mock.calls.at(-1).arguments[0];
    assert.strictEqual(preview.channel_id, `D-${OWNER}`);
    assert.match(preview.initial_comment, /Preview: \*srv-drafter\* wants to post this to \*C0NEWS01\*/);
    const dm = slack.chat.postMessage.mock.calls.at(-1).arguments[0];
    assert.match(JSON.stringify(dm.blocks), /:film_frames: With video `clip\.mp4` \(1 KB\) · preview above/);
    assert.ok(readdirSync(uploadDir).includes(body.upload_id), 'the file waits with the draft');

    await click(SEND_ACTION);
    const posted = slack.files.completeUploadExternal.mock.calls.at(-1).arguments[0];
    assert.deepStrictEqual([posted.channel_id, posted.initial_comment], ['C0NEWS01', 'Release clip']);
    assert.ok(!existsSync(join(uploadDir, body.upload_id)), 'the file is deleted after the decision');
    await drafter.close();
    await sender.close();
  });

  it('deletes a discarded attachment without posting it', async () => {
    const drafter = await connect(tokens.drafter);
    const { body } = await upload(tokens.drafter, PNG, 'nope.png');
    await drafter.callTool({ name: 'slack_send_message', arguments: { to: 'me', attachment: body.upload_id } });
    const completions = slack.files.completeUploadExternal.mock.callCount();
    await click(DISCARD_ACTION);
    assert.strictEqual(slack.files.completeUploadExternal.mock.callCount(), completions);
    assert.ok(!existsSync(join(uploadDir, body.upload_id)));
    await drafter.close();
  });

  it('rejects revoked tokens on the next request', async () => {
    revokeClient('srv-reader');
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.reader}` } });
    assert.strictEqual(r.status, 401);
  });
});
