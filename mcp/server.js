import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { READ_ONLY_TOOLS } from '../agent/tools/index.js';
import { config } from '../config.js';
import packageJson from '../package.json' with { type: 'json' };
import { createTokenReader } from '../utils/tokens.js';
import { recordUsage, ruleBasedRun } from '../utils/usage-store.js';

// MCP server for Claude Code: Fenix's read-only tools over Streamable HTTP.
// Stateless (a fresh server per request), protected by a bearer token, and
// every tool call is recorded in the usage log as kind 'mcp'. It reuses the
// exact tool definitions the Slack agent uses, so there is one source per tool.

const getToken = createTokenReader('FENIX_MCP_TOKEN', '.fenix_mcp_token');
/** Seconds between attempts to bind when the listen address is not available yet. */
const RETRY_SEC = 30;

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

/**
 * Start the HTTP endpoint when enabled in config. Refuses to start without a token.
 * @param {{ info: (msg: string) => void, error: (msg: string) => void }} logger
 * @returns {import('node:http').Server | null}
 */
export function startMcpServer(logger) {
  const { enabled, host, port, path } = config.mcp;
  if (!enabled) return null;
  const token = getToken();
  if (!token) {
    logger.error('MCP server not started: FENIX_MCP_TOKEN is not set');
    return null;
  }

  const http = createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    if (pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    if (!isAuthorized(req.headers.authorization, token)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
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
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      logger.error(`MCP request failed: ${e}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  // The bind address may not exist yet at boot (Docker creates its bridge after Fenix starts);
  // retry instead of letting the error take down the Slack bot.
  http.on('error', (/** @type {NodeJS.ErrnoException} */ e) => {
    logger.error(`MCP server could not listen on ${host}:${port} (${e.code || e.message}); retrying in ${RETRY_SEC} s`);
    setTimeout(() => http.listen(port, host), RETRY_SEC * 1000).unref();
  });
  http.on('listening', () => logger.info(`MCP server listening on http://${host}:${port}${path}`));
  http.listen(port, host);
  return http;
}
