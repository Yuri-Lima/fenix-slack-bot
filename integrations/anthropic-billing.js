import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { createTokenReader } from '../utils/tokens.js';

// What Anthropic billed for Fenix's own API key(s), from the Usage and Cost Analytics API (beta). It needs an
// Admin API key (or a key with the read:analytics scope), read from ANTHROPIC_ADMIN_KEY or ~/.anthropic_admin_key,
// and the IDs of the keys Fenix uses (usage.billing.apiKeyIds). Read-only: this module only ever lists costs.
// Billed data arrives 4 to 24 hours late and can be revised until about 7 days after a month ends.

const getAdminKey = createTokenReader('ANTHROPIC_ADMIN_KEY', '.anthropic_admin_key');

/** True when both the admin key and Fenix's API key IDs are set. */
export const billingConfigured = () => Boolean(getAdminKey() && config.usage.billing.apiKeyIds.length);

/** @type {Anthropic | null} */
let client = null;

/**
 * @typedef {Object} BilledCost
 * @property {Record<string, number>} days - UTC day "YYYY-MM-DD" -> USD billed (after discounts, before credits)
 * @property {string | null} refreshedAt - ISO time up to which the data is complete; later usage is missing
 */

/**
 * Billed cost of Fenix's API keys per UTC day, from `from` (a UTC midnight) to `to`, at most 31 days.
 * @param {Date} from
 * @param {Date} to
 * @returns {Promise<BilledCost>}
 */
export async function billedCostByDay(from, to) {
  const key = getAdminKey();
  if (!key || !config.usage.billing.apiKeyIds.length) {
    throw new Error('Anthropic billing is not configured (admin key or usage.billing.apiKeyIds missing).');
  }
  // apiKey only: never fall back to ANTHROPIC_API_KEY, Fenix's own key, which cannot read costs
  client ??= new Anthropic({ apiKey: key, authToken: null });
  /** @type {Record<string, number>} */
  const days = {};
  let page = await client.beta.organization.analytics.cost.list({
    starting_at: from.toISOString(),
    ending_at: to.toISOString(),
    time_bucket_width: '1d',
    api_key_ids: config.usage.billing.apiKeyIds,
    order_by: 'time',
    order: 'asc',
    limit: 1000,
  });
  const refreshedAt = page.data_refreshed_at;
  for (;;) {
    for (const row of page.data) {
      const day = row.starting_at.slice(0, 10);
      // Amounts are decimal strings in cents
      days[day] = (days[day] || 0) + Number(row.cost.amount) / 100;
    }
    if (!page.hasNextPage()) break;
    page = await page.getNextPage();
  }
  return { days, refreshedAt };
}
