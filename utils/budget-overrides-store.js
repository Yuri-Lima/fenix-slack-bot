import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config, resolvePath } from '../config.js';

// Spending limits that owners set for a person by asking Fenix (the budget_limits tool or the `limit`
// command). They live in data/, which deploys never overwrite, and take precedence over the person's
// entry in fenix.config.json (usage.budgets.perUser). utils/usage-budget.js limitsFor() combines both.

const STORE_FILE = join(resolvePath(config.dataDir), 'budget-overrides.json');

/**
 * @typedef {Object} BudgetOverride
 * @property {number} [dailyUsd]
 * @property {number} [monthlyUsd]
 * @property {string} [until] - Last day it applies, "YYYY-MM-DD" in config.timeZone
 * @property {string} setBy - Who asked (Slack name)
 * @property {string} setAt - ISO time
 */

/** @type {Record<string, BudgetOverride> | null} */
let cache = null;

/** @returns {Record<string, BudgetOverride>} Slack user ID -> override */
export function budgetOverrides() {
  if (!cache) {
    try {
      cache = JSON.parse(readFileSync(STORE_FILE, 'utf-8')).overrides || {};
    } catch {
      cache = {}; // nothing set yet
    }
  }
  return /** @type {Record<string, BudgetOverride>} */ (cache);
}

/** @param {Record<string, BudgetOverride>} overrides */
function save(overrides) {
  mkdirSync(dirname(STORE_FILE), { recursive: true });
  writeFileSync(`${STORE_FILE}.tmp`, JSON.stringify({ overrides }, null, 2), 'utf-8');
  renameSync(`${STORE_FILE}.tmp`, STORE_FILE);
  cache = overrides;
}

/**
 * Set (replace) a person's override.
 * @param {string} userId
 * @param {BudgetOverride} override - already validated
 * @returns {void}
 */
export function setBudgetOverride(userId, override) {
  save({ ...budgetOverrides(), [userId]: override });
}

/**
 * Remove a person's override. Returns false if they had none.
 * @param {string} userId
 * @returns {boolean}
 */
export function removeBudgetOverride(userId) {
  const { [userId]: removed, ...rest } = budgetOverrides();
  if (!removed) return false;
  save(rest);
  return true;
}
