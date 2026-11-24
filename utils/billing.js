import { join } from 'node:path';
import { config, resolvePath } from '../config.js';
import { billedCostByDay, billingConfigured } from '../integrations/anthropic-billing.js';
import { readJsonFile, writeJsonFile } from './json-file.js';
import { readRange } from './usage-store.js';

// Fenix's budgets in billed dollars. The Agent SDK only estimates each reply's cost; Anthropic's Usage and Cost
// API reports what was billed for Fenix's API key(s), but 4 to 24 hours late and with no Slack user attached.
// So the bill is fetched every few hours (data/usage/billed.json) and compared with Fenix's own estimates for the
// same recent days; that ratio, the calibration factor, turns every estimate into billed dollars.

const STORE_FILE = join(resolvePath(config.dataDir), 'usage', 'billed.json');
const DAY_MS = 24 * 3600_000;
/** Complete billed days the factor compares. */
export const CALIBRATION_DAYS = 7;
/** Below this many estimated dollars in the window, the factor is 1: too little data to compare. */
const MIN_SAMPLE_USD = 1;
/** The factor stays within these bounds, so a billing glitch cannot zero or explode the budgets. */
const FACTOR_RANGE = /** @type {const} */ ([0.25, 4]);
/** Billed days kept in the store. */
const KEEP_DAYS = 62;

/**
 * @typedef {Object} BillingState
 * @property {Record<string, number>} days - UTC day -> USD billed
 * @property {string | null} refreshedAt - billed data is complete up to here
 * @property {string | null} fetchedAt - when Fenix last asked
 */

/** @type {BillingState | null} */
let cache = null;

/** @returns {BillingState} */
export function billingState() {
  cache ??= readJsonFile(STORE_FILE, { days: {}, refreshedAt: null, fetchedAt: null });
  return /** @type {BillingState} */ (cache);
}

/** @param {Date} date @returns {Date} UTC midnight of that day */
const utcMidnight = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
/** @param {Date} date @returns {Date} first UTC midnight of that month */
const monthStart = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));

/**
 * Fetch the bill for this month so far and the calibration window, and save it.
 * @param {Date} [now]
 * @returns {Promise<BillingState | null>} null when billing is not configured
 */
export async function syncBilling(now = new Date()) {
  if (!billingConfigured()) return null;
  // Early in a month the calibration window reaches into the previous one; the span stays within 31 days
  const from = new Date(Math.min(monthStart(now).getTime(), utcMidnight(now).getTime() - CALIBRATION_DAYS * DAY_MS));
  const billed = await billedCostByDay(from, now);
  const oldest = new Date(now.getTime() - KEEP_DAYS * DAY_MS).toISOString().slice(0, 10);
  const days = Object.fromEntries(
    Object.entries({ ...billingState().days, ...billed.days }).filter(([day]) => day >= oldest),
  );
  cache = { days, refreshedAt: billed.refreshedAt ?? billingState().refreshedAt, fetchedAt: now.toISOString() };
  writeJsonFile(STORE_FILE, cache);
  factorCache = null;
  return cache;
}

/**
 * @typedef {Object} Calibration
 * @property {number} factor - billed / estimated; 1 when there is no bill to compare with
 * @property {number} billedUsd - billed in the window
 * @property {number} estimatedUsd - Fenix's estimates in the same window
 * @property {string | null} from - window start (UTC midnight), null without a bill
 * @property {string | null} to - window end, the last complete billed day's end
 */

/** @type {{ key: string, value: Calibration } | null} */
let factorCache = null;

/**
 * How Fenix's cost estimates compare with the bill over the last CALIBRATION_DAYS complete billed days.
 * Estimates count every run except MCP tool calls (those are the AI client's tokens, not Fenix's).
 * @returns {Calibration}
 */
export function calibration() {
  const { refreshedAt, days } = billingState();
  const none = { factor: 1, billedUsd: 0, estimatedUsd: 0, from: null, to: null };
  if (!refreshedAt) return none;
  if (factorCache?.key === refreshedAt) return factorCache.value;
  const to = utcMidnight(new Date(refreshedAt)); // days before this one are complete
  const from = new Date(to.getTime() - CALIBRATION_DAYS * DAY_MS);
  let billedUsd = 0;
  for (let t = from.getTime(); t < to.getTime(); t += DAY_MS) {
    billedUsd += days[new Date(t).toISOString().slice(0, 10)] || 0;
  }
  const estimatedUsd = readRange(from, new Date(to.getTime() - 1))
    .filter((r) => r.kind !== 'mcp')
    .reduce((sum, r) => sum + r.costUsd, 0);
  const factor =
    estimatedUsd >= MIN_SAMPLE_USD && billedUsd > 0
      ? Math.min(FACTOR_RANGE[1], Math.max(FACTOR_RANGE[0], billedUsd / estimatedUsd))
      : 1;
  const value = { factor, billedUsd, estimatedUsd, from: from.toISOString(), to: to.toISOString() };
  factorCache = { key: refreshedAt, value };
  return value;
}

/**
 * Billed cost between two UTC days (inclusive), from the store; days after refreshedAt are missing or partial.
 * @param {string} fromDay - "YYYY-MM-DD"
 * @param {string} toDay - "YYYY-MM-DD"
 * @returns {number}
 */
export function billedBetween(fromDay, toDay) {
  return Object.entries(billingState().days)
    .filter(([day]) => day >= fromDay && day <= toDay)
    .reduce((sum, [, usd]) => sum + usd, 0);
}

/**
 * Fetch the bill now and then every `usage.billing.refreshHours`; does nothing when billing is not configured.
 * @param {{ info: Function, warn: Function }} logger
 */
export function startBillingSync(logger) {
  if (!billingConfigured()) {
    logger.info('Billing: not configured (ANTHROPIC_ADMIN_KEY and usage.billing.apiKeyIds); budgets use estimates.');
    return;
  }
  const run = () =>
    syncBilling()
      .then((s) => {
        const c = calibration();
        logger.info(`Billing: synced up to ${s?.refreshedAt ?? 'nothing yet'}; calibration ×${c.factor.toFixed(2)}`);
      })
      .catch((e) => logger.warn(`Billing: sync failed: ${e instanceof Error ? e.message : e}`));
  void run();
  setInterval(run, config.usage.billing.refreshHours * 3600_000).unref();
}
