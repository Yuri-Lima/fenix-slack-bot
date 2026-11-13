import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {Object} BuildConfigHint
 * @property {string} id - TeamCity build configuration ID
 * @property {string} description - What the configuration runs
 */

/**
 * @typedef {Object} FenixConfig
 * @property {string} teamName - Team the bot serves, used in the system prompt
 * @property {string[]} ownerIds - Slack user IDs allowed to use the bot
 * @property {string} ownerName - Name shown in access-denied and error messages
 * @property {string | null} adminDmChannel - DM channel where messages from non-owners are forwarded
 * @property {{ url: string | null, botId: string | null, keyConfigs: BuildConfigHint[] }} teamcity
 * @property {{ url: string | null, project: string | null, defaultBranch: string }} gitlab
 * @property {{ url: string | null, project: string }} youtrack
 * @property {{ url: string | null, botId: string | null, prometheusUid: string | null, lokiUid: string | null, replyMode: 'dm' | 'thread' | 'off', ignoreHosts: string[] }} grafana
 *   Grafana alert analysis. replyMode 'dm' sends analyses to adminDmChannel (preview), 'thread' replies under the alert.
 *   ignoreHosts: name parts (case-insensitive) of servers never analysed, e.g. ["test"].
 * @property {string} contextFile - Markdown appended to the system prompt (team-specific knowledge)
 * @property {{ enabled: boolean, host: string, port: number, path: string, publicUrl: string | null, oauthRedirectUris: string[], cimdOrigins: string[], maxUploadMb: number, maxUploadTotalMb: number }} mcp
 *   MCP server (read-only tools). Static bearer FENIX_MCP_TOKEN for Claude Code; OAuth with Slack approval for
 *   Claude app connectors when publicUrl is set (only redirect URIs listed in oauthRedirectUris may register).
 * @property {{ retentionMonths: number }} usage - Agent usage log: monthly files kept for this many months
 * @property {string} timeZone - IANA time zone for times shown in Slack (alerts use it too)
 * @property {string} dataDir - Directory for persisted state (feedback, failure log), relative to the project root
 */

/** @type {FenixConfig} */
const DEFAULTS = {
  teamName: 'the engineering team',
  ownerIds: [],
  ownerName: 'the bot owner',
  adminDmChannel: null,
  teamcity: { url: null, botId: null, keyConfigs: [] },
  gitlab: { url: null, project: null, defaultBranch: 'main' },
  youtrack: { url: null, project: 'DEV' },
  grafana: { url: null, botId: null, prometheusUid: null, lokiUid: null, replyMode: 'dm', ignoreHosts: [] },
  contextFile: 'prompts/context.local.md',
  dataDir: 'data',
  usage: { retentionMonths: 12 },
  mcp: {
    enabled: false,
    host: '127.0.0.1',
    port: 8787,
    path: '/mcp',
    publicUrl: null,
    oauthRedirectUris: ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'],
    // Largest image or video an MCP client may upload for slack_send_message, and all uploads held at once (on disk)
    maxUploadMb: 200,
    maxUploadTotalMb: 1024,
    // Origins whose Client ID Metadata Documents may be fetched (Claude's published client identities)
    cimdOrigins: ['https://claude.ai', 'https://claude.com'],
  },
  timeZone: 'UTC',
};

/**
 * Load `fenix.config.json` (or the file named by FENIX_CONFIG) over the defaults.
 * Deployment-specific values live there so the source stays generic; see
 * `fenix.config.example.json`.
 * @returns {FenixConfig}
 */
function loadConfig() {
  const path = resolvePath(process.env.FENIX_CONFIG || 'fenix.config.json');
  const file = existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {};
  return {
    ...DEFAULTS,
    ...file,
    teamcity: { ...DEFAULTS.teamcity, ...file.teamcity },
    gitlab: { ...DEFAULTS.gitlab, ...file.gitlab },
    youtrack: { ...DEFAULTS.youtrack, ...file.youtrack },
    grafana: { ...DEFAULTS.grafana, ...file.grafana },
    usage: { ...DEFAULTS.usage, ...file.usage },
    mcp: { ...DEFAULTS.mcp, ...file.mcp },
  };
}

/**
 * @param {string} path
 * @returns {string}
 */
export function resolvePath(path) {
  return isAbsolute(path) ? path : join(ROOT, path);
}

/**
 * Strip a trailing slash so URLs can be joined with `${base}/path`.
 * @param {string | null} url
 * @returns {string | null}
 */
export function baseUrl(url) {
  return url ? url.replace(/\/+$/, '') : null;
}

export const config = loadConfig();
