import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config, resolvePath } from '../config.js';

// OAuth 2.1 authorization server for the MCP endpoint, so Claude app connectors
// can sign in (they cannot send a static bearer header). Follows the MCP
// authorization spec: protected-resource and authorization-server metadata,
// dynamic client registration restricted to allowed redirect URIs, PKCE (S256)
// authorization codes, and short-lived access tokens with rotating refresh
// tokens. A human approves every sign-in: Fenix DMs an owner Approve/Deny
// buttons (listeners/actions/mcp-oauth-approval.js).
//
// Clients and tokens are persisted (tokens only as SHA-256 hashes) so deploys
// do not sign Claude out; pending approvals and authorization codes live in
// memory and expire within minutes.

export const ACCESS_TOKEN_TTL_SEC = 60 * 60;
export const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;
const AUTH_CODE_TTL_SEC = 60;
export const PENDING_TTL_SEC = 5 * 60;
const MAX_PENDING = 20;
const MAX_CLIENTS = 50;

const STORE_FILE = join(resolvePath(config.dataDir), 'mcp-oauth.json');

/** @param {number} bytes */
const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
/** @param {string} value */
const sha256 = (value) => createHash('sha256').update(value).digest('base64url');
const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Constant-time string comparison.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * @typedef {Object} OAuthClient
 * @property {string} clientId
 * @property {string | null} secretHash - null for public clients (token_endpoint_auth_method "none")
 * @property {string} name
 * @property {string[]} redirectUris
 * @property {number} createdAt
 */

/**
 * @typedef {Object} TokenRecord
 * @property {string} clientId
 * @property {number} expiresAt
 * @property {string} approvedBy - Slack user who approved the sign-in
 */

/** @type {{ clients: Record<string, OAuthClient>, accessTokens: Record<string, TokenRecord>, refreshTokens: Record<string, TokenRecord> }} */
let store = { clients: {}, accessTokens: {}, refreshTokens: {} };
let loaded = false;
let writeChain = Promise.resolve();

function load() {
  if (loaded) return;
  loaded = true;
  try {
    store = { ...store, ...JSON.parse(readFileSync(STORE_FILE, 'utf-8')) };
  } catch {
    // first start, or an unreadable file: start empty (clients re-register)
  }
}

/** Persist atomically (temp file + rename); writes are chained so they land in order. */
function save() {
  const snapshot = JSON.stringify(store);
  writeChain = writeChain
    .then(async () => {
      mkdirSync(dirname(STORE_FILE), { recursive: true });
      await writeFile(`${STORE_FILE}.tmp`, snapshot, { encoding: 'utf-8', mode: 0o600 });
      await rename(`${STORE_FILE}.tmp`, STORE_FILE);
    })
    .catch((e) => console.error(`MCP OAuth store write failed: ${e}`));
  return writeChain;
}

/** Drop expired tokens so the store does not grow without bound. */
function pruneExpired() {
  const now = nowSec();
  for (const table of [store.accessTokens, store.refreshTokens]) {
    for (const [hash, t] of Object.entries(table)) if (t.expiresAt <= now) delete table[hash];
  }
}

/**
 * Whether a redirect URI is one the deployment allows (exact match).
 * @param {string} uri
 * @returns {boolean}
 */
export function isAllowedRedirect(uri) {
  return config.mcp.oauthRedirectUris.includes(uri);
}

// ── Metadata ───────────────────────────────────────────────────────────

/** RFC 9728 protected-resource metadata. */
export function protectedResourceMetadata() {
  const base = config.mcp.publicUrl;
  return {
    resource: `${base}${config.mcp.path}`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    resource_name: 'Fenix',
  };
}

/** RFC 8414 authorization-server metadata. */
export function authorizationServerMetadata() {
  const base = config.mcp.publicUrl;
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
  };
}

// ── Dynamic client registration (RFC 7591) ──────────────────────────────

/**
 * Register a client. Only allowed redirect URIs are accepted.
 * @param {any} body - Registration request
 * @returns {{ status: number, body: Record<string, unknown> }}
 */
export function registerClient(body) {
  load();
  const redirectUris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (redirectUris.length === 0 || !redirectUris.every(isAllowedRedirect)) {
    return {
      status: 400,
      body: { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be allowed Claude callback URLs' },
    };
  }
  if (Object.keys(store.clients).length >= MAX_CLIENTS) {
    // Oldest registration goes first; a real client re-registers if it needs to
    const oldest = Object.values(store.clients).sort((a, b) => a.createdAt - b.createdAt)[0];
    delete store.clients[oldest.clientId];
  }
  const method = body?.token_endpoint_auth_method === 'none' ? 'none' : (body?.token_endpoint_auth_method ?? 'none');
  const clientId = `fenix-${randomToken(12)}`;
  const secret = method === 'none' ? null : randomToken();
  store.clients[clientId] = {
    clientId,
    secretHash: secret ? sha256(secret) : null,
    name: String(body?.client_name || 'MCP client').slice(0, 80),
    redirectUris,
    createdAt: nowSec(),
  };
  void save();
  return {
    status: 201,
    body: {
      client_id: clientId,
      ...(secret && { client_secret: secret, client_secret_expires_at: 0 }),
      client_id_issued_at: store.clients[clientId].createdAt,
      client_name: store.clients[clientId].name,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
    },
  };
}

// ── Authorization requests awaiting a human decision ────────────────────

/**
 * @typedef {Object} PendingRequest
 * @property {string} id
 * @property {string} clientId
 * @property {string} clientName
 * @property {string} redirectUri
 * @property {string} codeChallenge
 * @property {string | null} state
 * @property {number} expiresAt
 * @property {'pending' | 'approved' | 'denied'} status
 * @property {string | null} decidedBy
 */

/** @type {Map<string, PendingRequest>} */
const pending = new Map();
/** @type {Map<string, { clientId: string, redirectUri: string, codeChallenge: string, approvedBy: string, expiresAt: number }>} */
const authCodes = new Map();

function prunePending() {
  const now = nowSec();
  for (const [id, p] of pending) if (p.expiresAt <= now) pending.delete(id);
  for (const [code, c] of authCodes) if (c.expiresAt <= now) authCodes.delete(code);
}

/**
 * Validate an /authorize request and create a pending approval.
 * @param {URLSearchParams} params
 * @returns {{ ok: true, request: PendingRequest } | { ok: false, status: number, error: string, redirect?: string }}
 */
export function startAuthorization(params) {
  load();
  prunePending();
  const client = store.clients[params.get('client_id') || ''];
  const redirectUri = params.get('redirect_uri') || '';
  // Never redirect to an unverified URI: errors before this point are shown, not redirected
  if (!client) return { ok: false, status: 400, error: 'Unknown client. Remove and re-add the connector.' };
  if (!client.redirectUris.includes(redirectUri))
    return { ok: false, status: 400, error: 'Redirect URI not registered.' };

  const state = params.get('state');
  /** @param {string} error */
  const fail = (error) => {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error);
    if (state) url.searchParams.set('state', state);
    return { ok: /** @type {const} */ (false), status: 302, error, redirect: url.toString() };
  };
  if (params.get('response_type') !== 'code') return fail('unsupported_response_type');
  const codeChallenge = params.get('code_challenge') || '';
  if (params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
    return fail('invalid_request');
  }
  if (pending.size >= MAX_PENDING) return fail('temporarily_unavailable');

  /** @type {PendingRequest} */
  const request = {
    id: randomToken(16),
    clientId: client.clientId,
    clientName: client.name,
    redirectUri,
    codeChallenge,
    state,
    expiresAt: nowSec() + PENDING_TTL_SEC,
    status: 'pending',
    decidedBy: null,
  };
  pending.set(request.id, request);
  return { ok: true, request };
}

/**
 * Record an owner's decision on a pending request.
 * @param {string} id
 * @param {'approved' | 'denied'} decision
 * @param {string} userId - Slack user who decided (caller checks they are an owner)
 * @returns {PendingRequest | null} null when unknown, expired, or already decided
 */
export function decideAuthorization(id, decision, userId) {
  prunePending();
  const request = pending.get(id);
  if (request?.status !== 'pending') return null;
  request.status = decision;
  request.decidedBy = userId;
  return request;
}

/**
 * Where the browser waiting on /authorize should go next, once decided.
 * Issues the authorization code exactly once, on approval.
 * @param {string} id
 * @returns {{ status: 'pending' } | { status: 'expired' } | { status: 'done', redirect: string }}
 */
export function authorizationOutcome(id) {
  prunePending();
  const request = pending.get(id);
  if (!request) return { status: 'expired' };
  if (request.status === 'pending') return { status: 'pending' };
  pending.delete(id);
  const url = new URL(request.redirectUri);
  if (request.status === 'approved') {
    const code = randomToken();
    authCodes.set(code, {
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      approvedBy: request.decidedBy || 'unknown',
      expiresAt: nowSec() + AUTH_CODE_TTL_SEC,
    });
    url.searchParams.set('code', code);
  } else {
    url.searchParams.set('error', 'access_denied');
  }
  if (request.state) url.searchParams.set('state', request.state);
  return { status: 'done', redirect: url.toString() };
}

// ── Token endpoint ──────────────────────────────────────────────────────

/**
 * Authenticate the client at the token endpoint (public clients need no secret).
 * @param {URLSearchParams} form
 * @param {string | undefined} authorization - HTTP Authorization header (client_secret_basic)
 * @returns {OAuthClient | null}
 */
function authenticateClient(form, authorization) {
  let clientId = form.get('client_id') || '';
  let secret = form.get('client_secret');
  if (authorization?.startsWith('Basic ')) {
    const [id, s] = Buffer.from(authorization.slice(6), 'base64').toString().split(':');
    clientId = decodeURIComponent(id || '');
    secret = decodeURIComponent(s || '');
  }
  const client = store.clients[clientId];
  if (!client) return null;
  if (client.secretHash === null) return client;
  return secret && safeEqual(sha256(secret), client.secretHash) ? client : null;
}

/**
 * Issue a new access/refresh token pair.
 * @param {string} clientId
 * @param {string} approvedBy
 */
function issueTokens(clientId, approvedBy) {
  pruneExpired();
  const accessToken = randomToken();
  const refreshToken = randomToken();
  store.accessTokens[sha256(accessToken)] = { clientId, approvedBy, expiresAt: nowSec() + ACCESS_TOKEN_TTL_SEC };
  store.refreshTokens[sha256(refreshToken)] = { clientId, approvedBy, expiresAt: nowSec() + REFRESH_TOKEN_TTL_SEC };
  void save();
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SEC,
    refresh_token: refreshToken,
  };
}

/**
 * Handle a token request (authorization_code with PKCE, or refresh_token with rotation).
 * @param {URLSearchParams} form
 * @param {string | undefined} authorization
 * @returns {{ status: number, body: Record<string, unknown> }}
 */
export function exchangeToken(form, authorization) {
  load();
  prunePending();
  const client = authenticateClient(form, authorization);
  if (!client) return { status: 401, body: { error: 'invalid_client' } };
  const grant = form.get('grant_type');

  if (grant === 'authorization_code') {
    const code = form.get('code') || '';
    const entry = authCodes.get(code);
    authCodes.delete(code); // single use, even when the exchange fails
    if (!entry || entry.clientId !== client.clientId || entry.redirectUri !== form.get('redirect_uri')) {
      return { status: 400, body: { error: 'invalid_grant' } };
    }
    const verifier = form.get('code_verifier') || '';
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(sha256(verifier), entry.codeChallenge)) {
      return { status: 400, body: { error: 'invalid_grant', error_description: 'PKCE verification failed' } };
    }
    return { status: 200, body: issueTokens(client.clientId, entry.approvedBy) };
  }

  if (grant === 'refresh_token') {
    const hash = sha256(form.get('refresh_token') || '');
    const entry = store.refreshTokens[hash];
    if (!entry || entry.clientId !== client.clientId || entry.expiresAt <= nowSec()) {
      return { status: 400, body: { error: 'invalid_grant' } };
    }
    delete store.refreshTokens[hash]; // rotation: every refresh token works once
    return { status: 200, body: issueTokens(client.clientId, entry.approvedBy) };
  }

  return { status: 400, body: { error: 'unsupported_grant_type' } };
}

/**
 * Whether a bearer token is a valid, unexpired OAuth access token.
 * @param {string} token
 * @returns {boolean}
 */
export function isValidAccessToken(token) {
  load();
  const entry = store.accessTokens[sha256(token)];
  return Boolean(entry && entry.expiresAt > nowSec());
}

/**
 * Revoke every OAuth token (connectors must sign in again). Static token users are unaffected.
 * @returns {number} tokens removed
 */
export function revokeAllTokens() {
  load();
  const removed = Object.keys(store.accessTokens).length + Object.keys(store.refreshTokens).length;
  store.accessTokens = {};
  store.refreshTokens = {};
  void save();
  return removed;
}

/**
 * Resolves once every store write started so far has finished (for tests).
 * @returns {Promise<void>}
 */
export function flushOAuthStore() {
  return writeChain;
}
