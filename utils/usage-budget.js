import { config } from '../config.js';
import { calibration } from './billing.js';
import { budgetOverrides } from './budget-overrides-store.js';
import { money } from './helpers.js';
import { isOwner } from './input-guard.js';
import { localDay, monthKey, spendByUser } from './usage-store.js';

// Spending limits checked before each agent reply (config.usage.budgets). Spend comes from the usage log's
// in-memory totals, so a check costs no tokens and no file read. Owners are never blocked; everyone else
// has a daily and a monthly limit of their own and shares the team's monthly limit. Every reply, owners'
// included, is capped by the SDK's maxBudgetUsd. Limits are in billed dollars: once Anthropic's bill is synced
// (utils/billing.js), every estimate is multiplied by the calibration factor before it is compared.

/** The smallest cap a reply gets, so a nearly used budget still allows one short answer. */
export const MIN_REPLY_USD = 0.1;

/** @typedef {'team' | 'monthly' | 'daily' | 'thread'} BudgetLimit */

/**
 * @typedef {{ ok: true, maxUsd: number | undefined } | { ok: false, limit: BudgetLimit, reply: string }} BudgetVerdict
 *   maxUsd: the most this reply may cost (undefined: no cap)
 */

/**
 * An entry of perUser or of the overrides store while it applies (through its `until` day), else none.
 * @template {{ until?: string }} T
 * @param {T | undefined} entry
 * @param {Date} now
 * @returns {T | undefined}
 */
const activeEntry = (entry, now) => (entry && !(entry.until && localDay(now) > entry.until) ? entry : undefined);

/**
 * Where a person's limits come from right now: a limit an owner set by asking (overrides store), else their
 * entry in fenix.config.json (perUser), else the defaults.
 * @param {string} userId
 * @param {Date} [now]
 * @returns {{ source: 'asked' | 'config' | 'default', until?: string, setBy?: string, setAt?: string }}
 */
export function limitSource(userId, now = new Date()) {
  const asked = activeEntry(budgetOverrides()[userId], now);
  if (asked) return { source: 'asked', until: asked.until, setBy: asked.setBy, setAt: asked.setAt };
  const fromConfig = activeEntry(config.usage.budgets.perUser[userId], now);
  if (fromConfig) return { source: 'config', until: fromConfig.until };
  return { source: 'default' };
}

/**
 * A person's daily and monthly limits, field by field: a limit an owner set by asking, else their entry in
 * perUser, else the defaults. Entries apply through their `until` day.
 * @param {string} userId
 * @param {Date} [now]
 * @returns {{ dailyUsd: number | null, monthlyUsd: number | null }}
 */
export function limitsFor(userId, now = new Date()) {
  const b = config.usage.budgets;
  const layers = [activeEntry(budgetOverrides()[userId], now), activeEntry(b.perUser[userId], now)];
  /** @param {'dailyUsd' | 'monthlyUsd'} key @param {number | null} fallback */
  const pick = (key, fallback) => {
    for (const layer of layers) if (layer && layer[key] !== undefined) return /** @type {number | null} */ (layer[key]);
    return fallback;
  };
  return { dailyUsd: pick('dailyUsd', b.userDailyUsd), monthlyUsd: pick('monthlyUsd', b.userMonthlyUsd) };
}

/**
 * `1 December` for the month after `now` (UTC), when monthly limits reset.
 * @param {Date} now
 * @returns {string}
 */
export function nextMonthLabel(now) {
  return dayMonth(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));
}

/** `1 December` for a date (UTC). */
const dayMonth = (/** @type {Date} */ date) =>
  date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });

/**
 * The budget decision for one reply, from spend figures (pure, so it can be tested without a log).
 * @param {Object} input
 * @param {boolean} input.owner
 * @param {{ dailyUsd: number | null, monthlyUsd: number | null }} input.limits
 * @param {{ dayUsd: number, monthUsd: number }} input.spent - This person's spend
 * @param {number} input.teamUsd - Everyone but the owners, this month
 * @param {number} input.threadCostUsd - What the thread has cost before this reply
 * @param {Date} [input.now]
 * @returns {BudgetVerdict}
 */
export function evaluateBudget({ owner, limits, spent, teamUsd, threadCostUsd, now = new Date() }) {
  const b = config.usage.budgets;
  const replyCap = b.replyMaxUsd ?? Number.POSITIVE_INFINITY;
  if (owner) return { ok: true, maxUsd: Number.isFinite(replyCap) ? replyCap : undefined };

  const reached = (/** @type {number | null} */ limit, /** @type {number} */ used) => limit !== null && used >= limit;
  if (reached(b.teamMonthlyUsd, teamUsd)) {
    return {
      ok: false,
      limit: 'team',
      reply:
        `The team's Fenix budget for this month (${money(/** @type {number} */ (b.teamMonthlyUsd))}) is used up, ` +
        `so I can't answer until it resets on ${nextMonthLabel(now)}. ${config.ownerName} has been told.`,
    };
  }
  if (reached(limits.monthlyUsd, spent.monthUsd)) {
    return {
      ok: false,
      limit: 'monthly',
      reply:
        `You've used your Fenix budget for this month (${money(/** @type {number} */ (limits.monthlyUsd))}). ` +
        `It resets on ${nextMonthLabel(now)}; ask ${config.ownerName} if you need more before then.`,
    };
  }
  if (reached(limits.dailyUsd, spent.dayUsd)) {
    return {
      ok: false,
      limit: 'daily',
      reply:
        `You've used your Fenix budget for today (${money(/** @type {number} */ (limits.dailyUsd))}). ` +
        `It resets at midnight (${config.timeZone}); ask ${config.ownerName} if you need more today.`,
    };
  }
  if (reached(b.threadMaxUsd, threadCostUsd)) {
    return {
      ok: false,
      limit: 'thread',
      reply:
        `This thread has cost ${money(threadCostUsd)} so far, and every reply re-reads all of it. ` +
        'Please ask in a new thread (or send me a new message); it will be faster and cheaper.',
    };
  }

  const left = [
    replyCap,
    limits.dailyUsd === null ? Number.POSITIVE_INFINITY : limits.dailyUsd - spent.dayUsd,
    limits.monthlyUsd === null ? Number.POSITIVE_INFINITY : limits.monthlyUsd - spent.monthUsd,
    b.teamMonthlyUsd === null ? Number.POSITIVE_INFINITY : b.teamMonthlyUsd - teamUsd,
  ];
  const cap = Math.min(...left);
  return { ok: true, maxUsd: Number.isFinite(cap) ? Math.max(cap, Math.min(MIN_REPLY_USD, replyCap)) : undefined };
}

/**
 * This month's spend of everyone except the owners.
 * @param {Map<string, { monthUsd: number, dayUsd: number }>} spend
 * @returns {number}
 */
export function teamSpend(spend) {
  let usd = 0;
  for (const [id, u] of spend) if (!isOwner(id)) usd += u.monthUsd;
  return usd;
}

/**
 * Check the budgets before a reply.
 * @param {string} userId
 * @param {number} [threadCostUsd] - What the thread has cost before this reply (0 for a new thread)
 * @returns {BudgetVerdict}
 */
export function checkBudget(userId, threadCostUsd = 0) {
  const { spend, factor } = billedSpend();
  const verdict = evaluateBudget({
    owner: isOwner(userId),
    limits: limitsFor(userId),
    spent: spend.get(userId) || { dayUsd: 0, monthUsd: 0 },
    teamUsd: teamSpend(spend),
    threadCostUsd: threadCostUsd * factor,
  });
  // The SDK enforces the reply cap on its own estimate, so the billed cap goes back into estimated dollars
  return verdict.ok && verdict.maxUsd !== undefined ? { ok: true, maxUsd: verdict.maxUsd / factor } : verdict;
}

/**
 * Spend per person this month and today in billed dollars: the estimates times the calibration factor.
 * @returns {{ spend: Map<string, { monthUsd: number, dayUsd: number }>, factor: number }}
 */
export function billedSpend() {
  const { factor } = calibration();
  const spend = spendByUser();
  for (const u of spend.values()) {
    u.monthUsd *= factor;
    u.dayUsd *= factor;
  }
  return { spend, factor };
}

/**
 * What is left, for the reply footer, once a limit is at least `warnAt` used; null below that and for owners.
 * @param {string} userId
 * @param {number} [threadCostUsd] - What the thread has cost so far
 * @returns {string | null}
 */
export function budgetNote(userId, threadCostUsd = 0) {
  if (isOwner(userId)) return null;
  const b = config.usage.budgets;
  const { spend, factor } = billedSpend();
  const mine = spend.get(userId) || { dayUsd: 0, monthUsd: 0 };
  const limits = limitsFor(userId);
  /** @type {string[]} */
  const notes = [];
  /** @param {number | null} limit @param {number} used @param {string} what */
  const check = (limit, used, what) => {
    if (limit !== null && limit > 0 && used >= b.warnAt * limit)
      notes.push(`${what}: ${money(used)} of ${money(limit)}`);
  };
  check(limits.dailyUsd, mine.dayUsd, 'budget today');
  check(limits.monthlyUsd, mine.monthUsd, 'budget this month');
  check(b.teamMonthlyUsd, teamSpend(spend), 'team budget');
  check(b.threadMaxUsd, threadCostUsd * factor, 'this thread');
  return notes.length ? `:hourglass: ${notes.join(' · ')}` : null;
}

/** Owner notices already sent, by limit and period, so each is sent once. */
const notified = new Set();

/**
 * Post a notice to the owners (adminDmChannel) unless one with this key was already sent.
 * @param {{ chat: { postMessage: Function } }} client
 * @param {string} key
 * @param {string} text
 * @returns {Promise<boolean>} whether a notice was sent
 */
async function noticeOnce(client, key, text) {
  if (!config.adminDmChannel || notified.has(key)) return false;
  notified.add(key);
  try {
    await client.chat.postMessage({ channel: config.adminDmChannel, text });
    return true;
  } catch (e) {
    console.error(`Owner notice failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/**
 * Tell the owners (adminDmChannel) once per person, limit and period that a budget was reached. The thread
 * limit only asks for a new thread, so it sends nothing.
 * @param {{ chat: { postMessage: Function } }} client
 * @param {{ userId: string, userName: string, limit: BudgetLimit }} who
 * @param {Date} [now]
 * @returns {Promise<boolean>} whether a notice was sent
 */
export async function notifyBudgetReached(client, { userId, userName, limit }, now = new Date()) {
  if (limit === 'thread') return false;
  const period = limit === 'daily' ? localDay(now) : monthKey(now);
  const key = limit === 'team' ? `team:${period}` : `${userId}:${limit}:${period}`;

  const b = config.usage.budgets;
  const limits = limitsFor(userId);
  const text =
    limit === 'team'
      ? `:money_with_wings: The team reached its monthly Fenix budget (${money(/** @type {number} */ (b.teamMonthlyUsd))}). ` +
        `Only owners get replies until ${nextMonthLabel(now)}. To change it, set usage.budgets.teamMonthlyUsd ` +
        'in fenix.config.json and deploy.'
      : `:money_with_wings: ${userName} reached their ${limit} Fenix budget ` +
        `(${money(/** @type {number} */ (limit === 'daily' ? limits.dailyUsd : limits.monthlyUsd))}). ` +
        `Their replies stop until ${limit === 'daily' ? `midnight (${config.timeZone})` : nextMonthLabel(now)}. ` +
        `To raise it, reply here with \`limit <@${userId}> ${limit === 'daily' ? '5/day' : '50/month'}\` ` +
        '(add `until end of month` to make it temporary), or ask me.';
  return noticeOnce(client, key, text);
}

// The Anthropic API refuses every call once the account's spend limit (set in the Claude Console) is reached:
// "API Error: 400 You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC."
const API_LIMIT_RE = /reached your specified API usage limits/i;
const API_LIMIT_UNTIL_RE = /regain access on (\d{4}-\d{2}-\d{2})/i;

/**
 * Whether an error text is the account's API usage limit, and until when.
 * @param {string | undefined} text
 * @returns {{ until: string | null } | null} until: e.g. `1 December`, null when the error names no date
 */
export function apiLimitReached(text) {
  if (!text || !API_LIMIT_RE.test(text)) return null;
  const date = API_LIMIT_UNTIL_RE.exec(text)?.[1];
  return { until: date ? dayMonth(new Date(`${date}T00:00:00Z`)) : null };
}

/**
 * The reply when the account's API usage limit is reached.
 * @param {string | null} until
 * @returns {string}
 */
export function apiLimitMessage(until) {
  return (
    `I can't answer right now: Fenix's Anthropic API credits are used up${until ? ` until ${until}` : ''}. ` +
    `${config.ownerName} has been told.`
  );
}

/**
 * Tell the owners once (per date access returns) that the account's API usage limit was reached.
 * @param {{ chat: { postMessage: Function } }} client
 * @param {string | null} until
 * @returns {Promise<boolean>} whether a notice was sent
 */
export function notifyApiLimitReached(client, until) {
  return noticeOnce(
    client,
    `api:${until ?? 'unknown'}`,
    ':rotating_light: The Anthropic API usage limit is reached: every Fenix reply fails' +
      `${until ? ` until ${until}` : ''}. Raise the spend limit in the Claude Console to bring Fenix back; its usage ` +
      'page shows which key used the credits.',
  );
}
