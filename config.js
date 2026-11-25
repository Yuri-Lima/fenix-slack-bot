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
 * @property {string[]} ownerIds - Slack user IDs of the owners: full access, admin tools and approvals
 * @property {string[]} allowedUserIds - Other Slack user IDs that may ask Fenix (no admin tools or commands)
 * @property {string} ownerName - Name shown in access-denied and error messages
 * @property {string | null} ownerTitle - How Fenix addresses an owner in replies to them, e.g. "my lord"; null for
 *   no title
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
 * @property {{ retentionMonths: number, budgets: UsageBudgets, billing: UsageBilling }} usage - Agent usage log: monthly
 *   files kept for this many months, the spending limits checked before each agent reply, and the bill they follow
 * @property {TranslateConfig} translate - German messages translated for owners who do not read German
 * @property {string} timeZone - IANA time zone for times shown in Slack (alerts use it too)
 * @property {string} dataDir - Directory for persisted state (feedback, failure log), relative to the project root
 */

/**
 * Spending limits in USD (the SDK's cost estimates). Owners are never blocked; everyone else is checked before each
 * reply. Set a limit to null to turn it off.
 * @typedef {Object} UsageBudgets
 * @property {number | null} userDailyUsd - Per person per day (in timeZone)
 * @property {number | null} userMonthlyUsd - Per person per calendar month (UTC, like the usage log)
 * @property {number | null} teamMonthlyUsd - Everyone except owners together, per month
 * @property {number | null} replyMaxUsd - Most one reply may cost; also applies to owners
 * @property {number | null} threadMaxUsd - A thread that has cost this much asks for a new thread
 * @property {number} warnAt - Share of a limit (0-1) from which the reply footer shows what is left
 * @property {Record<string, { dailyUsd?: number | null, monthlyUsd?: number | null, until?: string }>} perUser - Slack user
 *   ID -> own limits; `until` ("YYYY-MM-DD", in timeZone) is the last day they apply, after which the defaults do
 */

/**
 * Anthropic's bill for Fenix's API key(s), used to turn cost estimates into billed dollars (utils/billing.js).
 * Off until apiKeyIds is set and an Admin API key is in ANTHROPIC_ADMIN_KEY or ~/.anthropic_admin_key.
 * @typedef {Object} UsageBilling
 * @property {string[]} apiKeyIds - IDs ("apikey_...") of the Anthropic API keys only Fenix uses
 * @property {number} refreshHours - How often the bill is fetched
 */

/**
 * Translation of German messages for owners who do not read German (listeners/events/translate-watch.js). In channels
 * Fenix is in, German messages in threads such a person wrote in or was mentioned in, and top-level messages that
 * mention them, are translated in the thread with a mention. Off while userIds is empty.
 * @typedef {Object} TranslateConfig
 * @property {string[]} userIds - Owners (Slack user IDs) to translate for; IDs that are not owners are ignored
 * @property {'en' | 'pt-BR'} defaultLanguage - Language a person gets until they choose another
 * @property {number} batchSeconds - Messages arriving this soon after the first one are translated in one reply
 */

/** @type {FenixConfig} */
const DEFAULTS = {
  teamName: 'the engineering team',
  ownerIds: [],
  allowedUserIds: [],
  ownerName: 'the bot owner',
  ownerTitle: null,
  adminDmChannel: null,
  teamcity: { url: null, botId: null, keyConfigs: [] },
  gitlab: { url: null, project: null, defaultBranch: 'main' },
  youtrack: { url: null, project: 'DEV' },
  grafana: { url: null, botId: null, prometheusUid: null, lokiUid: null, replyMode: 'dm', ignoreHosts: [] },
  contextFile: 'prompts/context.local.md',
  dataDir: 'data',
  usage: {
    retentionMonths: 12,
    budgets: {
      userDailyUsd: 3,
      userMonthlyUsd: 30,
      teamMonthlyUsd: 100,
      replyMaxUsd: 1,
      threadMaxUsd: 2,
      warnAt: 0.8,
      perUser: {},
    },
    billing: { apiKeyIds: [], refreshHours: 6 },
  },
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
  translate: { userIds: [], defaultLanguage: 'en', batchSeconds: 15 },
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
    usage: {
      ...DEFAULTS.usage,
      ...file.usage,
      budgets: { ...DEFAULTS.usage.budgets, ...file.usage?.budgets },
      billing: { ...DEFAULTS.usage.billing, ...file.usage?.billing },
    },
    mcp: { ...DEFAULTS.mcp, ...file.mcp },
    translate: { ...DEFAULTS.translate, ...file.translate },
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
