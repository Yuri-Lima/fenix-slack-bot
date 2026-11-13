import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config, resolvePath } from '../config.js';

// Named MCP clients (Cursor, Grok, ...), each with its own bearer token and
// scopes, so connections can be told apart, limited and revoked one by one.
// Tokens are stored only as SHA-256 hashes in data/mcp-clients.json, which the
// `scripts/mcp-client.js` CLI edits; the server re-reads the file when it changes.

/** What a connection may do. */
export const SCOPES = /** @type {const} */ (['read', 'send']);
/** `slack`: messages from this client wait for an owner's Send click in Slack. */
export const SEND_APPROVALS = /** @type {const} */ (['slack', 'none']);
/** Name of the connection that uses FENIX_MCP_TOKEN (Claude Code, which asks before each tool call). */
export const STATIC_CLIENT_NAME = 'claude-code';
/** Lowercase letters, digits and dashes; used in logs and the usage report. */
const CLIENT_NAME = /^[a-z0-9][a-z0-9-]{1,30}$/;
/** Recognisable prefix, so a leaked token is easy to identify and revoke. */
const TOKEN_PREFIX = 'fenix_mcp_';

const STORE_FILE = join(resolvePath(config.dataDir), 'mcp-clients.json');

/**
 * @typedef {Object} McpClient
 * @property {string} name
 * @property {string} tokenHash - SHA-256 (base64url) of the bearer token
 * @property {Array<typeof SCOPES[number]>} scopes
 * @property {typeof SEND_APPROVALS[number]} sendApproval
 * @property {number} createdAt - epoch seconds
 */

/**
 * Who is calling the MCP endpoint, and what it may do.
 * @typedef {{ name: string, scopes: string[], sendApproval: string }} McpCaller
 */

/** @param {string} value */
export const hashToken = (value) => createHash('sha256').update(value).digest('base64url');

/** @type {{ mtimeMs: number, clients: Record<string, McpClient> }} */
let cache = { mtimeMs: -1, clients: {} };

/** The registry, re-read whenever the file changes (the CLI writes it from another process). */
function readStore() {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(STORE_FILE).mtimeMs;
  } catch {
    return {}; // no clients yet
  }
  if (mtimeMs !== cache.mtimeMs) {
    try {
      cache = { mtimeMs, clients: JSON.parse(readFileSync(STORE_FILE, 'utf-8')).clients || {} };
    } catch {
      cache = { mtimeMs, clients: {} }; // unreadable: nobody gets in through the registry
    }
  }
  return cache.clients;
}

/** @param {Record<string, McpClient>} clients */
function writeStore(clients) {
  mkdirSync(dirname(STORE_FILE), { recursive: true });
  writeFileSync(`${STORE_FILE}.tmp`, JSON.stringify({ clients }, null, 2), { encoding: 'utf-8', mode: 0o600 });
  renameSync(`${STORE_FILE}.tmp`, STORE_FILE);
}

/**
 * The registered client a bearer token belongs to, or null.
 * @param {string} token
 * @returns {McpCaller | null}
 */
export function clientForToken(token) {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const hash = hashToken(token);
  const client = Object.values(readStore()).find((c) => c.tokenHash === hash);
  return client ? { name: client.name, scopes: client.scopes, sendApproval: client.sendApproval } : null;
}

/**
 * Create a client, or replace its token if it exists (rotation). Returns the token; it is not stored.
 * @param {string} name
 * @param {{ send?: boolean, sendApproval?: typeof SEND_APPROVALS[number] }} [options]
 * @returns {{ token: string, client: McpClient }}
 */
export function createClient(name, { send = false, sendApproval = 'slack' } = {}) {
  if (!CLIENT_NAME.test(name)) throw new Error('Name must be 2-31 lowercase letters, digits or dashes.');
  if (name === STATIC_CLIENT_NAME || name.startsWith('app-')) throw new Error(`"${name}" is reserved.`);
  if (!SEND_APPROVALS.includes(sendApproval)) throw new Error(`Send approval must be ${SEND_APPROVALS.join(' or ')}.`);
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  /** @type {McpClient} */
  const client = {
    name,
    tokenHash: hashToken(token),
    scopes: send ? ['read', 'send'] : ['read'],
    sendApproval,
    createdAt: Math.floor(Date.now() / 1000),
  };
  writeStore({ ...readStore(), [name]: client });
  return { token, client };
}

/**
 * Remove a client; its token stops working on the next request.
 * @param {string} name
 * @returns {boolean} whether it existed
 */
export function revokeClient(name) {
  const clients = { ...readStore() };
  if (!clients[name]) return false;
  delete clients[name];
  writeStore(clients);
  return true;
}

/**
 * Registered clients, without their token hashes.
 * @returns {Array<Omit<McpClient, 'tokenHash'>>}
 */
export function listClients() {
  return Object.values(readStore()).map(({ tokenHash, ...rest }) => rest);
}
