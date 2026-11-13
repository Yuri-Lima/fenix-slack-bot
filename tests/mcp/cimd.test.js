import assert from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { describe, it, mock } from 'node:test';

import {
  authorizationOutcome,
  authorizationServerMetadata,
  decideAuthorization,
  exchangeToken,
  isCimdClientId,
  isValidAccessToken,
  redirectMatches,
  startAuthorization,
} from '../../mcp/oauth.js';

// Claude Code's published Client ID Metadata Document, as served at its client_id URL.
const CLAUDE_CODE_ID = 'https://claude.ai/oauth/claude-code-client-metadata';
const claudeCodeDoc = {
  client_id: CLAUDE_CODE_ID,
  client_name: 'Claude Code',
  client_uri: 'https://claude.ai',
  redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

/** A fetch that serves one document; records calls. */
const serving = (doc) => mock.fn(async () => ({ ok: true, text: async () => JSON.stringify(doc) }));

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

/** /authorize parameters for a client. */
const authorizeParams = (clientId, redirectUri, challenge) =>
  new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 's1',
  });

describe('CIMD discovery', () => {
  it('advertises CIMD together with public-client auth, as Claude requires', () => {
    const meta = authorizationServerMetadata();
    assert.strictEqual(meta.client_id_metadata_document_supported, true);
    assert.ok(meta.token_endpoint_auth_methods_supported.includes('none'));
  });

  it('only treats HTTPS URLs on allowed origins as fetchable client IDs', () => {
    assert.ok(isCimdClientId(CLAUDE_CODE_ID));
    assert.ok(!isCimdClientId('https://evil.example/oauth/client'));
    assert.ok(!isCimdClientId('http://claude.ai/oauth/client'));
    assert.ok(!isCimdClientId('https://claude.ai/'));
    assert.ok(!isCimdClientId('fenix-abc123'));
  });
});

describe('redirectMatches', () => {
  it('matches loopback redirects on any port, as RFC 8252 requires', () => {
    assert.ok(redirectMatches('http://localhost:54321/callback', 'http://localhost/callback'));
    assert.ok(redirectMatches('http://127.0.0.1:3118/callback', 'http://127.0.0.1/callback'));
  });

  it('requires the same host and path, and exact matches for everything else', () => {
    assert.ok(!redirectMatches('http://localhost:54321/other', 'http://localhost/callback'));
    assert.ok(!redirectMatches('http://127.0.0.1:3118/callback', 'http://localhost/callback'));
    assert.ok(
      !redirectMatches('https://claude.ai/api/mcp/auth_callback?x=1', 'https://claude.ai/api/mcp/auth_callback'),
    );
    assert.ok(redirectMatches('https://claude.ai/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback'));
  });
});

describe('startAuthorization with a client metadata document', () => {
  it('accepts Claude Code and records its verified origin for the approver', async () => {
    const r = await startAuthorization(
      authorizeParams(CLAUDE_CODE_ID, 'http://localhost:54321/callback', pkce().challenge),
      serving(claudeCodeDoc),
    );
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.request.clientName, 'Claude Code');
    assert.strictEqual(r.request.clientOrigin, 'https://claude.ai');
  });

  it('never fetches client IDs from other origins', async () => {
    const fetchImpl = serving({ ...claudeCodeDoc, client_id: 'https://evil.example/client' });
    const r = await startAuthorization(
      authorizeParams('https://evil.example/client', 'https://claude.ai/api/mcp/auth_callback', pkce().challenge),
      fetchImpl,
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(fetchImpl.mock.callCount(), 0);
  });

  it('rejects a document whose client_id is not its own URL', async () => {
    const id = 'https://claude.ai/oauth/mismatch';
    const r = await startAuthorization(
      authorizeParams(id, 'http://localhost:5000/callback', pkce().challenge),
      serving({ ...claudeCodeDoc, client_id: 'https://claude.ai/oauth/other' }),
    );
    assert.strictEqual(r.ok, false);
  });

  it('rejects confidential clients and redirect URIs outside the allowlist', async () => {
    const confidential = 'https://claude.ai/oauth/confidential';
    const r1 = await startAuthorization(
      authorizeParams(confidential, 'http://localhost:5000/callback', pkce().challenge),
      serving({ ...claudeCodeDoc, client_id: confidential, token_endpoint_auth_method: 'private_key_jwt' }),
    );
    assert.strictEqual(r1.ok, false);

    const foreign = 'https://claude.ai/oauth/foreign-redirect';
    const r2 = await startAuthorization(
      authorizeParams(foreign, 'https://evil.example/cb', pkce().challenge),
      serving({ ...claudeCodeDoc, client_id: foreign, redirect_uris: ['https://evil.example/cb'] }),
    );
    assert.strictEqual(r2.ok, false);
  });

  it('completes sign-in for a public CIMD client after owner approval', async () => {
    const { verifier, challenge } = pkce();
    const redirectUri = 'http://127.0.0.1:3118/callback';
    const r = await startAuthorization(authorizeParams(CLAUDE_CODE_ID, redirectUri, challenge), serving(claudeCodeDoc));
    assert.ok(r.ok, r.error);
    decideAuthorization(r.request.id, 'approved', 'U0OWNER');
    const outcome = authorizationOutcome(r.request.id);
    const code = new URL(outcome.redirect).searchParams.get('code');

    const tokens = exchangeToken(
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLAUDE_CODE_ID,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
      undefined,
    );
    assert.strictEqual(tokens.status, 200);
    assert.ok(isValidAccessToken(tokens.body.access_token));
  });
});
