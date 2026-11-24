import { join } from 'node:path';
import { config, resolvePath } from '../config.js';
import { readJsonFile, writeJsonFile } from './json-file.js';

// Server name parts excluded from Grafana analysis that owners added by asking
// Fenix (the grafana_ignore_hosts tool). They live in data/, which deploys never
// overwrite; the ones in fenix.config.json (grafana.ignoreHosts) are managed there.
// integrations/host-health.js ignoreHostParts() combines both lists.
// A part with `until` stops applying at that moment on its own; expired parts are dropped on the next save.
// An `exact` entry excludes only the server with exactly that name, not every name containing it.

const STORE_FILE = join(resolvePath(config.dataDir), 'grafana-ignore-hosts.json');

/**
 * @typedef {Object} AddedIgnorePart
 * @property {string} part - lowercase name part, e.g. "staging", or a full server name when `exact`
 * @property {boolean} [exact] - only the server named exactly `part` (e.g. "alpha" but not "demo-alpha")
 * @property {string} addedBy - who asked (Slack name or MCP client)
 * @property {string} addedAt - ISO time
 * @property {string | null} [until] - ISO time it stops applying; absent or null means until removed
 */

/** @type {AddedIgnorePart[] | null} */
let cache = null;

/** @param {AddedIgnorePart} a @param {Date} now */
const active = (a, now) => !a.until || Date.parse(a.until) > now.getTime();

/**
 * The added parts that apply at `now` (expired ones are left out).
 * @param {Date} [now]
 * @returns {AddedIgnorePart[]}
 */
export function addedIgnoreParts(now = new Date()) {
  cache ??= readJsonFile(STORE_FILE, { added: [] }).added || []; // nothing added yet: []
  return /** @type {AddedIgnorePart[]} */ (cache).filter((a) => active(a, now));
}

/** @param {AddedIgnorePart[]} added */
function save(added) {
  writeJsonFile(STORE_FILE, { added });
  cache = added;
}

/**
 * Add a name part, or change an added one (adding it again replaces its end and whether it is exact).
 * @param {string} part - already validated and lowercased
 * @param {string} addedBy
 * @param {{ until?: Date | null, exact?: boolean, now?: Date }} [options] - until: when it stops applying
 *   (null for until removed); exact: only the server with exactly this name
 * @returns {'added' | 'changed'}
 */
export function addIgnorePart(part, addedBy, { until = null, exact = false, now = new Date() } = {}) {
  const added = addedIgnoreParts(now);
  const entry = { part, exact, addedBy, addedAt: now.toISOString(), until: until ? until.toISOString() : null };
  const existed = added.some((a) => a.part === part);
  save([...added.filter((a) => a.part !== part), entry]);
  return existed ? 'changed' : 'added';
}

/**
 * Remove a name part that was added by asking. Returns false if it was not one of them (or had already ended).
 * @param {string} part
 * @param {Date} [now]
 * @returns {boolean}
 */
export function removeIgnorePart(part, now = new Date()) {
  const added = addedIgnoreParts(now);
  if (!added.some((a) => a.part === part)) return false;
  save(added.filter((a) => a.part !== part));
  return true;
}
