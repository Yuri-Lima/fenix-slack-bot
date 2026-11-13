import assert from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, describe, it, mock } from 'node:test';

process.env.FENIX_MCP_TOKEN = 'static-test-token';

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { config } = await import('../../config.js');
const { startMcpServer } = await import('../../mcp/server.js');
const { flushOAuthStore, revokeAllTokens } = await import('../../mcp/oauth.js');
const { handleMcpOAuthDecision } = await import('../../listeners/actions/mcp-oauth-approval.js');

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const OWNER = 'U0OWNER';

describe('MCP OAuth sign-in with Slack approval', () => {
  /** @type {import('node:http').Server} */
  let http;
  let base;
  const slack = {
    chat: {
      postMessage: mock.fn(async () => ({ ok: true })),
      update: mock.fn(async () => ({ ok: true })),
    },
  };

  before(async () => {
    config.mcp = { ...config.mcp, enabled: true, host: '127.0.0.1', port: 0 };
    http = startMcpServer({ info: () => {}, error: () => {} }, slack);
    await new Promise((resolve) => http.once('listening', resolve));
    base = `http://127.0.0.1:${http.address().port}`;
  });

  after(async () => {
    await flushOAuthStore();
    await new Promise((resolve) => http.close(resolve));
  });

  const pkce = () => {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
  };

  const register = async () => {
    const r = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }),
    });
    assert.strictEqual(r.status, 201);
    return (await r.json()).client_id;
  };

  /** Click a DM button as `user`; returns the request id the DM carried. */
  const click = async (actionId, user) => {
    const dm = slack.chat.postMessage.mock.calls.at(-1).arguments[0];
    const requestId = dm.blocks.find((b) => b.type === 'actions').elements[0].value;
    await handleMcpOAuthDecision({
      ack: async () => {},
      body: {
        user: { id: user },
        actions: [{ action_id: actionId, value: requestId }],
        channel: { id: 'D1' },
        message: { ts: '1.0' },
      },
      client: slack,
      logger: { error: () => {} },
    });
    return requestId;
  };

  /** Run register → authorize → decision, return the redirect the waiting page would follow. */
  const signIn = async (decision = 'mcp_oauth_approve') => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
    });
    const page = await fetch(`${base}/authorize?${q}`);
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /Approve the sign-in in Slack/);
    const requestId = await click(decision, OWNER);
    const status = await (await fetch(`${base}/authorize/status?id=${requestId}`)).json();
    return { clientId, verifier, redirect: new URL(status.redirect) };
  };

  const token = (form) =>
    fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    });

  it('publishes discovery metadata and points 401s at it', async () => {
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    assert.strictEqual(prm.resource, 'https://fenix-mcp.example.com/mcp');
    const asm = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.deepStrictEqual(asm.code_challenge_methods_supported, ['S256']);
    const unauth = await fetch(`${base}/mcp`, { method: 'POST' });
    assert.strictEqual(unauth.status, 401);
    assert.match(
      unauth.headers.get('www-authenticate'),
      /resource_metadata="https:\/\/fenix-mcp\.example\.com\/\.well-known/,
    );
  });

  it('refuses to register redirect URIs outside the allowlist', async () => {
    const r = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://evil.example/callback'] }),
    });
    assert.strictEqual(r.status, 400);
  });

  it('ignores approval clicks from non-owners', async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    await fetch(`${base}/authorize?${q}`);
    const requestId = await click('mcp_oauth_approve', 'U0STRANGER');
    const status = await (await fetch(`${base}/authorize/status?id=${requestId}`)).json();
    assert.strictEqual(status.status, 'pending');
  });

  it('returns access_denied to the client when the owner denies', async () => {
    const { redirect } = await signIn('mcp_oauth_deny');
    assert.strictEqual(redirect.searchParams.get('error'), 'access_denied');
    assert.strictEqual(redirect.searchParams.get('state'), 'xyz');
  });

  it('rejects a code exchanged with the wrong PKCE verifier, and never accepts it twice', async () => {
    const { clientId, verifier, redirect } = await signIn();
    const code = redirect.searchParams.get('code');
    const wrong = await token({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: CALLBACK,
      code_verifier: pkce().verifier,
    });
    assert.strictEqual(wrong.status, 400);
    assert.strictEqual((await wrong.json()).error, 'invalid_grant');
    // The failed attempt consumed the code: the correct verifier no longer works either
    const retry = await token({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
    });
    assert.strictEqual(retry.status, 400);
  });

  it('grants tokens after approval, serves tools, rotates refresh tokens, and honours revocation', async () => {
    const { clientId, verifier, redirect } = await signIn();
    assert.strictEqual(redirect.origin + redirect.pathname, CALLBACK);
    assert.strictEqual(redirect.searchParams.get('state'), 'xyz');

    const res = await token({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: redirect.searchParams.get('code'),
      redirect_uri: CALLBACK,
      code_verifier: verifier,
    });
    assert.strictEqual(res.status, 200);
    const tokens = await res.json();
    assert.strictEqual(tokens.token_type, 'Bearer');

    const client = new Client({ name: 'claude-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      }),
    );
    assert.ok((await client.listTools()).tools.some((t) => t.name === 'host_health'));
    await client.close();

    const refreshed = await (
      await token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token })
    ).json();
    assert.ok(refreshed.access_token && refreshed.access_token !== tokens.access_token);
    const reused = await token({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: tokens.refresh_token,
    });
    assert.strictEqual(reused.status, 400);

    revokeAllTokens();
    const afterRevoke = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${refreshed.access_token}` },
    });
    assert.strictEqual(afterRevoke.status, 401);
  });

  it('keeps accepting the static token used by Claude Code', async () => {
    const client = new Client({ name: 'claude-code', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: 'Bearer static-test-token' } },
      }),
    );
    assert.ok((await client.listTools()).tools.length > 0);
    await client.close();
  });
});
