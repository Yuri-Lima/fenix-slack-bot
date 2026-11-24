import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

process.env.YOUTRACK_API_TOKEN = 'yt-test-token';

// Capture the tools each run hands the SDK; the run itself answers at once
const sdk = await import('@anthropic-ai/claude-agent-sdk');
/** @type {any[]} */
let captured = [];
mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    ...sdk,
    createSdkMcpServer: (/** @type {any} */ { tools }) => {
      captured = tools;
      return {};
    },
    query: () =>
      (async function* () {
        yield { type: 'result', subtype: 'success', session_id: 's', num_turns: 1, duration_ms: 1, total_cost_usd: 0 };
      })(),
  },
});

const { runFenixAgent } = await import('../../agent/fenix.js');
const { attachSlackFiles } = await import('../../integrations/youtrack.js');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
/** Slack serves the files, YouTrack takes the uploads; every request is recorded. */
const fakeNetwork = (/** @type {any} */ t) =>
  t.mock.method(globalThis, 'fetch', async (/** @type {string} */ url) =>
    url.startsWith('https://files.slack.com/')
      ? new Response(PNG)
      : new Response(JSON.stringify({ id: '1-1', name: 'x' }), { headers: { 'content-type': 'application/json' } }),
  );
const slackFile = (/** @type {string} */ id, /** @type {string} */ name, extra = {}) => ({
  id,
  name,
  mimetype: 'image/png',
  size: PNG.length,
  url_private: `https://files.slack.com/files-pri/T1-${id}/${name}`,
  ...extra,
});

describe('attachSlackFiles', () => {
  it('copies Slack files to the issue, sending the Slack token only to Slack', async (t) => {
    const fetchMock = fakeNetwork(t);
    const r = await attachSlackFiles('xoxb-test', 'DEV-7', [
      { name: 'a.png', mimetype: 'image/png', url: 'https://files.slack.com/files-pri/T1-F1/a.png' },
      { name: 'evil.png', url: 'https://evil.example.com/a.png' },
      { name: 'big.mov', url: 'https://files.slack.com/files-pri/T1-F2/big.mov', size: 50 * 1024 * 1024 },
    ]);
    assert.deepStrictEqual(r, {
      attached: ['a.png'],
      skipped: ['evil.png (not a Slack file link)', 'big.mov (over 10 MB)'],
    });
    const calls = fetchMock.mock.calls.map((c) => [String(c.arguments[0]), c.arguments[1]?.headers?.Authorization]);
    assert.deepStrictEqual(calls, [
      ['https://files.slack.com/files-pri/T1-F1/a.png', 'Bearer xoxb-test'],
      ['https://acme.youtrack.cloud/api/issues/DEV-7/attachments?fields=id,name', 'Bearer yt-test-token'],
    ]);
  });
});

describe('youtrack_attach_files', () => {
  /** The tool from a run in a thread whose messages are `messages`. */
  const toolFor = async (/** @type {any[]} */ messages) => {
    const client = {
      token: 'xoxb-test',
      chat: { postMessage: async () => ({ ok: true }) },
      conversations: { replies: mock.fn(async () => ({ messages })) },
    };
    const thread = `${Date.now() / 1000}`;
    await runFenixAgent('attach them', undefined, {
      client: /** @type {any} */ (client),
      channelId: 'C1',
      threadTs: thread,
      messageTs: thread,
      userId: 'U0OWNER',
      userName: 'Owner',
    });
    return captured.find((x) => x.name === 'youtrack_attach_files');
  };
  const text = async (/** @type {any} */ tool, /** @type {object} */ args) => {
    const r = await tool.handler(args, {});
    return { text: r.content[0].text, isError: Boolean(r.isError) };
  };

  it("attaches the files people shared in the thread, not bots' files", async (t) => {
    fakeNetwork(t);
    const tool = await toolFor([
      { user: 'U0OWNER', text: 'see these', files: [slackFile('F1', 'error.png'), slackFile('F2', 'grafana.png')] },
      { bot_id: 'B0FENIX', text: 'chart', files: [slackFile('F3', 'fenix-chart.png')] },
      { user: 'U0OWNER', text: 'create it', files: [slackFile('F1', 'error.png')] },
    ]);
    assert.deepStrictEqual(await text(tool, { issue_id: 'dev-3559' }), {
      text: 'Attached to dev-3559: error.png, grafana.png.',
      isError: false,
    });
  });

  it('attaches only the named files, and says what it could not find', async (t) => {
    fakeNetwork(t);
    const tool = await toolFor([{ user: 'U1', files: [slackFile('F1', 'error.png'), slackFile('F2', 'log.txt')] }]);
    const r = await text(tool, { issue_id: 'DEV-1', files: ['log.txt', 'missing.pdf'] });
    assert.strictEqual(r.text, 'Attached to DEV-1: log.txt. Not in this thread: missing.pdf.');
    const none = await text(tool, { issue_id: 'DEV-1', files: ['nope.png'] });
    assert.ok(none.isError && /Files here: error\.png, log\.txt\./.test(none.text), none.text);
  });

  it('says so when nobody shared a file', async () => {
    const tool = await toolFor([{ user: 'U1', text: 'no files' }]);
    const r = await text(tool, { issue_id: 'DEV-1' });
    assert.ok(r.isError && /Nobody shared a file/.test(r.text));
  });
});
