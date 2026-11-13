import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createSlackMcpTools, READ_ONLY_TOOLS } from '../agent/tools/index.js';
import { config } from '../config.js';
import { buildApprovalBlocks } from '../listeners/views/mcp-oauth-approval-builder.js';
import packageJson from '../package.json' with { type: 'json' };
import { createTokenReader } from '../utils/tokens.js';
import { recordUsage, ruleBasedRun } from '../utils/usage-store.js';
import { clientForToken, STATIC_CLIENT_NAME } from './clients.js';
import {
  accessTokenClientName,
  authorizationOutcome,
  authorizationServerMetadata,
  exchangeToken,
  protectedResourceMetadata,
  registerClient,
  startAuthorization,
} from './oauth.js';
import { requestSendApproval } from './send-approval.js';
import { deleteUploadFile, storeUploadStream, takeUpload, UPLOAD_TTL_SEC } from './uploads.js';

// MCP server for Claude Code: Fenix's read-only tools over Streamable HTTP, plus
// owner-only tools (slack_send_message) for the static-token connection.
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
  'server health from Grafana metrics and logs, the GitLab codebase, YouTrack issues, Fenix usage, and the people ' +
  'in Slack with their availability (slack_users) and the channels Fenix can post in (slack_channels). ' +
  'All tools are read-only, except where noted.';
const OWNER_INSTRUCTIONS =
  'slack_send_message posts as Fenix to a channel, a DM or a thread. Use it when the user asks to send, post or DM ' +
  'something in Slack; write the finished message in Slack mrkdwn first. If a channel name is not found, check ' +
  'slack_channels for the exact name before suggesting an invite. Before DMing someone, use slack_users to ' +
  'pick the right person and mention it to the user if they are away, on vacation or otherwise unavailable.';

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
 * The shell command a connection runs to upload an image or video (bytes never pass through the model).
 * Token files follow the setup convention: ~/.fenix_mcp_token for Claude Code, ~/.fenix_mcp_token_<client> otherwise.
 * @param {string} base - public origin of the endpoint
 * @param {string} clientName
 * @returns {string}
 */
export function uploadHint(base, clientName) {
  const tokenFile = clientName === STATIC_CLIENT_NAME ? '~/.fenix_mcp_token' : `~/.fenix_mcp_token_${clientName}`;
  return (
    `curl -sS -T <path to file> "${base}/uploads?filename=<file name>" -H "Authorization: Bearer $(cat ${tokenFile})"` +
    ` (PNG, JPEG, GIF, WebP, MP4, MOV or WebM up to ${config.mcp.maxUploadMb} MB; replies {"upload_id": ...}, ` +
    'valid 1 hour)'
  );
}

/**
 * Who a request comes from, by its bearer token: the static FENIX_MCP_TOKEN (Claude Code, which asks
 * before each tool call, so it sends without approval), a registered client (scripts/mcp-client.js),
 * or a Claude app connector signed in with OAuth (read-only).
 * @param {string} header - Authorization header
 * @param {string} staticToken
 * @param {boolean} oauth - whether OAuth sign-in is on
 * @returns {import('./clients.js').McpCaller | null}
 */
export function identifyCaller(header, staticToken, oauth) {
  if (isAuthorized(header, staticToken))
    return { name: STATIC_CLIENT_NAME, scopes: ['read', 'send'], sendApproval: 'none' };
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!bearer) return null;
  const registered = clientForToken(bearer);
  if (registered) return registered;
  const app = oauth ? accessTokenClientName(bearer) : null;
  if (!app) return null;
  const slug =
    app
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'connector';
  return { name: `app-${slug}`, scopes: ['read'], sendApproval: 'slack' };
}

/**
 * An MCP server exposing the read-only tools (plus `readOnly` extras such as slack_users), and
 * `owner` tools (which change things) for callers allowed to use them. Each call is recorded in
 * the usage log under the caller's name.
 * @param {{ readOnly?: any[], owner?: any[], caller?: import('./clients.js').McpCaller }} [options]
 * @returns {McpServer}
 */
export function buildMcpServer({ readOnly = [], owner: ownerTools = [], caller } = {}) {
  const server = new McpServer(
    { name: 'fenix', version: packageJson.version },
    { instructions: ownerTools.length ? `${INSTRUCTIONS} ${OWNER_INSTRUCTIONS}` : INSTRUCTIONS },
  );
  const tools = [
    ...[...READ_ONLY_TOOLS, ...readOnly].map((t) => ({ t, annotations: { readOnlyHint: true } })),
    ...ownerTools.map((t) => ({
      t,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    })),
  ];
  for (const { t, annotations } of tools) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.inputSchema, annotations },
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
              ...(caller ? { userName: caller.name } : {}),
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
  return readBytes(req, MAX_BODY_BYTES).then((b) => b.toString('utf-8'));
}

/** Thrown when a request body is over its limit. */
class BodyTooLarge extends Error {}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Buffer>}
 */
function readBytes(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLarge('body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
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
  // Created once so their Slack directory caches outlive a single stateless request
  const slackTools = slack ? createSlackMcpTools(slack) : null;
  const uploadBase = publicUrl || `http://${host}:${port}`;

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

      // Images and videos for slack_send_message: the client uploads the bytes here (POST, or PUT as
      // `curl -T` sends), then passes the upload_id. The file streams to disk, never into memory.
      if (pathname === '/uploads' && (req.method === 'POST' || req.method === 'PUT')) {
        const caller = identifyCaller(req.headers.authorization || '', token, oauth);
        if (!caller) {
          res.writeHead(401, { 'WWW-Authenticate': challenge }).end();
          return;
        }
        detail = ` client=${caller.name}`;
        if (!caller.scopes.includes('send')) {
          sendJson(res, 403, { error: 'This connection cannot send messages, so it cannot upload files.' });
          return;
        }
        const r = await storeUploadStream(caller.name, req, url.searchParams.get('filename'));
        if (!r.ok) {
          sendJson(res, r.status, { error: r.error });
          return;
        }
        sendJson(res, 201, {
          upload_id: r.upload.id,
          filename: r.upload.filename,
          kind: r.upload.kind,
          bytes: r.upload.size,
          expires_in: UPLOAD_TTL_SEC,
        });
        return;
      }

      if (pathname !== path) {
        res.writeHead(404).end();
        return;
      }
      const caller = identifyCaller(req.headers.authorization || '', token, oauth);
      if (!caller) {
        res.writeHead(401, { 'WWW-Authenticate': challenge }).end();
        return;
      }
      detail = ` client=${caller.name}`;
      // Stateless server: no session to stream to (GET) or to end (DELETE)
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' }).end();
        return;
      }
      // Sending needs the `send` scope; clients with sendApproval "slack" only draft, an owner sends
      const owner =
        slackTools && caller.scopes.includes('send')
          ? [
              slackTools.send({
                approve:
                  caller.sendApproval === 'slack'
                    ? (target, text, attachment) => requestSendApproval(slack, caller.name, target, text, attachment)
                    : undefined,
                takeAttachment: (id) => {
                  const u = takeUpload(id, caller.name);
                  if (!u) return null;
                  const { path, size, filename, mimeType, kind } = u;
                  return { path, size, filename, mimeType, kind, release: () => deleteUploadFile(path) };
                },
                uploadHint: uploadHint(uploadBase, caller.name),
              }),
            ]
          : [];
      const server = buildMcpServer({ readOnly: slackTools?.readOnly, owner, caller });
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
