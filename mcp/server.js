import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { READ_ONLY_TOOLS } from '../agent/tools/index.js';
import { config } from '../config.js';
import { buildApprovalBlocks } from '../listeners/views/mcp-oauth-approval-builder.js';
import packageJson from '../package.json' with { type: 'json' };
import { createTokenReader } from '../utils/tokens.js';
import { recordUsage, ruleBasedRun } from '../utils/usage-store.js';
import {
  authorizationOutcome,
  authorizationServerMetadata,
  exchangeToken,
  isValidAccessToken,
  protectedResourceMetadata,
  registerClient,
  startAuthorization,
} from './oauth.js';

// MCP server for Claude Code: Fenix's read-only tools over Streamable HTTP.
// Stateless (a fresh server per request), protected by a bearer token, and
// every tool call is recorded in the usage log as kind 'mcp'. It reuses the
// exact tool definitions the Slack agent uses, so there is one source per tool.

const getToken = createTokenReader('FENIX_MCP_TOKEN', '.fenix_mcp_token');
/** Seconds between attempts to bind when the listen address is not available yet. */
const RETRY_SEC = 30;
/** Paths left out of the request log: health checks and the sign-in page's status polling. */
const QUIET_PATHS = new Set(['/healthz', '/authorize/status']);

/**
 * A header or parameter value made safe for a single log line.
 * @param {unknown} value
 * @returns {string}
 */
const logSafe = (value) =>
  String(value ?? '-')
    .replace(/[^\x20-\x7e]|"/g, '')
    .slice(0, 120);

/**
 * The OAuth error code from a response body, for the request log.
 * @param {any} body
 * @returns {string}
 */
const oauthErrorDetail = (body) => (body?.error ? ` error=${logSafe(body.error)}` : '');

const INSTRUCTIONS =
  'Fenix is the team DevOps assistant. Use these tools for CI builds and test failures (TeamCity), flaky tests, ' +
  'server health from Grafana metrics and logs, the GitLab codebase, YouTrack issues, and Fenix usage. ' +
  'All tools are read-only.';

/**
 * Constant-time check of an Authorization header against the expected token.
 * @param {string | undefined} header
 * @param {string} token
 * @returns {boolean}
 */
export function isAuthorized(header, token) {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header || '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * An MCP server exposing the read-only tools, each call recorded in the usage log.
 * @returns {McpServer}
 */
export function buildMcpServer() {
  const server = new McpServer({ name: 'fenix', version: packageJson.version }, { instructions: INSTRUCTIONS });
  for (const t of READ_ONLY_TOOLS) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true } },
      /** @type {any} */ (
        async (/** @type {any} */ args, /** @type {any} */ extra) => {
          const startedAt = Date.now();
          /** @type {any} */
          let result;
          try {
            result = await t.handler(args, extra);
            return result;
          } finally {
            void recordUsage({
              ...ruleBasedRun('mcp', t.name, startedAt),
              outcome: result && !result.isError ? 'ok' : 'error',
              tools: { [t.name]: 1 },
            });
          }
        }
      ),
    );
  }
  return server;
}

/** Largest request body accepted on the OAuth endpoints. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
}

/** @param {string} s */
const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);

/**
 * Page shown while an owner approves the sign-in in Slack; it polls and then
 * follows the redirect back to the client.
 * @param {import('./oauth.js').PendingRequest} request
 * @returns {string}
 */
function waitingPage(request) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Approve in Slack · Fenix</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1d1c1d}h1{font-size:1.4rem}p{line-height:1.5}#s{color:#616061}</style></head>
<body><h1>Approve the sign-in in Slack</h1>
<p><strong>${escapeHtml(request.clientName)}</strong> wants to use Fenix's read-only tools. Fenix sent the owners an <strong>Approve</strong> button in Slack.</p>
<p id="s">Waiting for approval… this page continues on its own.</p>
<script>
const id=${JSON.stringify(request.id)};
async function poll(){
  try{const r=await fetch('/authorize/status?id='+encodeURIComponent(id),{cache:'no-store'});const j=await r.json();
    if(j.status==='done'){location.replace(j.redirect);return}
    if(j.status==='expired'){document.getElementById('s').textContent='This request expired. Start the connection again.';return}
  }catch(e){}
  setTimeout(poll,2000);
}
poll();
</script></body></html>`;
}

/**
 * DM every owner an Approve/Deny button for a pending sign-in.
 * @param {any} slack - Slack WebClient
 * @param {import('./oauth.js').PendingRequest} request
 */
async function notifyOwners(slack, request) {
  await Promise.all(
    config.ownerIds.map((owner) =>
      slack.chat.postMessage({
        channel: owner,
        text: `${request.clientName} wants to connect to Fenix. Approve or deny in Slack.`,
        blocks: buildApprovalBlocks(request),
      }),
    ),
  );
}

/**
 * Start the HTTP endpoint when enabled in config. Refuses to start without a token.
 * Serves the MCP endpoint plus, when mcp.publicUrl is set, the OAuth endpoints
 * Claude app connectors use to sign in (approved by an owner in Slack).
 * @param {{ info: (msg: string) => void, error: (msg: string) => void }} logger
 * @param {any} [slack] - Slack WebClient used to ask owners for approval
 * @returns {import('node:http').Server | null}
 */
export function startMcpServer(logger, slack) {
  const { enabled, host, port, path, publicUrl } = config.mcp;
  if (!enabled) return null;
  const token = getToken();
  if (!token) {
    logger.error('MCP server not started: FENIX_MCP_TOKEN is not set');
    return null;
  }
  const oauth = Boolean(publicUrl && slack && config.ownerIds.length);
  const challenge = oauth ? `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"` : 'Bearer';

  const http = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const { pathname } = url;
    const started = Date.now();
    /** Extra detail for the request log (client id, error code); never tokens or the query string. */
    let detail = '';
    res.on('finish', () => {
      if (QUIET_PATHS.has(pathname)) return;
      logger.info(
        `MCP ${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms ua="${logSafe(req.headers['user-agent'])}"${detail}`,
      );
    });
    try {
      if (pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
        return;
      }

      if (oauth) {
        if (
          pathname === '/.well-known/oauth-protected-resource' ||
          pathname === `/.well-known/oauth-protected-resource${path}`
        ) {
          sendJson(res, 200, protectedResourceMetadata());
          return;
        }
        if (pathname === '/.well-known/oauth-authorization-server') {
          sendJson(res, 200, authorizationServerMetadata());
          return;
        }
        if (pathname === '/register' && req.method === 'POST') {
          const r = registerClient(JSON.parse((await readBody(req)) || '{}'));
          detail = oauthErrorDetail(r.body);
          sendJson(res, r.status, r.body);
          return;
        }
        if (pathname === '/authorize' && req.method === 'GET') {
          const r = await startAuthorization(url.searchParams);
          detail = ` client="${logSafe(url.searchParams.get('client_id'))}"${r.ok ? '' : ` error="${logSafe(r.error)}"`}`;
          if (!r.ok) {
            if (r.redirect) res.writeHead(302, { Location: r.redirect }).end();
            else res.writeHead(r.status, { 'Content-Type': 'text/plain' }).end(r.error);
            return;
          }
          await notifyOwners(slack, r.request);
          res
            .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
            .end(waitingPage(r.request));
          return;
        }
        if (pathname === '/authorize/status' && req.method === 'GET') {
          sendJson(res, 200, authorizationOutcome(url.searchParams.get('id') || ''));
          return;
        }
        if (pathname === '/token' && req.method === 'POST') {
          const raw = await readBody(req);
          const form = String(req.headers['content-type']).includes('application/json')
            ? new URLSearchParams(JSON.parse(raw || '{}'))
            : new URLSearchParams(raw);
          const r = exchangeToken(form, req.headers.authorization);
          detail = ` grant=${logSafe(form.get('grant_type'))}${oauthErrorDetail(r.body)}`;
          sendJson(res, r.status, r.body);
          return;
        }
      }

      if (pathname !== path) {
        res.writeHead(404).end();
        return;
      }
      const bearer = req.headers.authorization || '';
      const accessToken = bearer.startsWith('Bearer ') ? bearer.slice(7) : '';
      if (!isAuthorized(bearer, token) && !(oauth && accessToken && isValidAccessToken(accessToken))) {
        res.writeHead(401, { 'WWW-Authenticate': challenge }).end();
        return;
      }
      // Stateless server: no session to stream to (GET) or to end (DELETE)
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' }).end();
        return;
      }
      const server = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      logger.error(`MCP request ${req.method} ${pathname} failed: ${e}`);
      if (!res.headersSent) sendJson(res, 400, { error: 'invalid_request' });
    }
  });
  // The bind address may not exist yet at boot (Docker creates its bridge after Fenix starts);
  // retry instead of letting the error take down the Slack bot.
  http.on('error', (/** @type {NodeJS.ErrnoException} */ e) => {
    logger.error(`MCP server could not listen on ${host}:${port} (${e.code || e.message}); retrying in ${RETRY_SEC} s`);
    setTimeout(() => http.listen(port, host), RETRY_SEC * 1000).unref();
  });
  http.on('listening', () =>
    logger.info(
      `MCP server listening on http://${host}:${port}${path}${oauth ? ` (OAuth sign-in for ${publicUrl})` : ''}`,
    ),
  );
  http.listen(port, host);
  return http;
}
