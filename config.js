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
 * @property {string} contextFile - Markdown appended to the system prompt (team-specific knowledge)
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
  contextFile: 'prompts/context.local.md',
  dataDir: 'data',
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
