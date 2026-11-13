import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config, resolvePath } from '../config.js';

// Server name parts excluded from Grafana analysis that owners added by asking
// Fenix (the grafana_ignore_hosts tool). They live in data/, which deploys never
// overwrite; the ones in fenix.config.json (grafana.ignoreHosts) are managed there.
// integrations/host-health.js ignoreHostParts() combines both lists.

const STORE_FILE = join(resolvePath(config.dataDir), 'grafana-ignore-hosts.json');

/**
 * @typedef {Object} AddedIgnorePart
 * @property {string} part - lowercase name part, e.g. "staging"
 * @property {string} addedBy - who asked (Slack name or MCP client)
 * @property {string} addedAt - ISO time
 */

/** @type {AddedIgnorePart[] | null} */
let cache = null;

/** @returns {AddedIgnorePart[]} */
export function addedIgnoreParts() {
  if (!cache) {
    try {
      cache = JSON.parse(readFileSync(STORE_FILE, 'utf-8')).added || [];
    } catch {
      cache = []; // nothing added yet
    }
  }
  return /** @type {AddedIgnorePart[]} */ (cache);
}

/** @param {AddedIgnorePart[]} added */
function save(added) {
  mkdirSync(dirname(STORE_FILE), { recursive: true });
  writeFileSync(`${STORE_FILE}.tmp`, JSON.stringify({ added }, null, 2), 'utf-8');
  renameSync(`${STORE_FILE}.tmp`, STORE_FILE);
  cache = added;
}

/**
 * Add a name part. Returns false if it was already added.
 * @param {string} part - already validated and lowercased
 * @param {string} addedBy
 * @returns {boolean}
 */
export function addIgnorePart(part, addedBy) {
  const added = addedIgnoreParts();
  if (added.some((a) => a.part === part)) return false;
  save([...added, { part, addedBy, addedAt: new Date().toISOString() }]);
  return true;
}

/**
 * Remove a name part that was added by asking. Returns false if it was not one of them.
 * @param {string} part
 * @returns {boolean}
 */
export function removeIgnorePart(part) {
  const added = addedIgnoreParts();
  if (!added.some((a) => a.part === part)) return false;
  save(added.filter((a) => a.part !== part));
  return true;
}
