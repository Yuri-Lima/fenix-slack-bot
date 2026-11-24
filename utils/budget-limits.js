import { config } from '../config.js';
import { budgetOverrides, removeBudgetOverride, setBudgetOverride } from './budget-overrides-store.js';
import { money } from './helpers.js';
import { isAllowed, isOwner } from './input-guard.js';
import { billedSpend, limitSource, limitsFor, teamSpend } from './usage-budget.js';
import { localDay } from './usage-store.js';

// Owners change a person's spending limits by asking: the budget_limits agent tool and the `limit` command
// (no AI tokens, so it also works while the API credits are used up) both use these functions, and both
// return the same texts.

/** The most a limit set by asking may be, so a typo cannot open the budget. */
export const MAX_LIMIT_USD = 1000;

/** @typedef {(userId: string) => Promise<string>} NameOf - Slack display name for a user ID */
/** @typedef {{ id: string, name: string }} Person */

/**
 * The last day a limit applies, as "YYYY-MM-DD": a date, or "end of month" / "this month" (the last day of
 * the current month in config.timeZone). Null when the text is neither or the day has already passed.
 * @param {string} text
 * @param {Date} [now]
 * @returns {string | null}
 */
export function parseUntil(text, now = new Date()) {
  const today = localDay(now);
  const t = text.trim().toLowerCase();
  let day = null;
  if (/^(?:the\s+)?(?:end\s+of\s+(?:the\s+|this\s+)?month|this\s+month)$/.test(t)) {
    const [y, m] = today.split('-').map(Number);
    day = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(t) && new Date(`${t}T00:00:00Z`).toISOString().slice(0, 10) === t) {
    day = t;
  }
  return day && day >= today ? day : null;
}

/** `30 Nov` for "2026-11-30". */
const shortDay = (/** @type {string} */ day) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** People whose limits matter: the access list, plus anyone who already has their own limits. Never owners. */
function limitablePeople() {
  const ids = [
    ...config.allowedUserIds,
    ...Object.keys(config.usage.budgets.perUser),
    ...Object.keys(budgetOverrides()),
  ];
  return [...new Set(ids)].filter((id) => !isOwner(id));
}

/**
 * Find the person meant: a Slack mention (`<@U123>`), a user ID, or part of the name of someone on the access
 * list.
 * @param {string} query
 * @param {NameOf} nameOf
 * @returns {Promise<Person | { candidates: string[] }>} candidates: the names that matched (none, or several)
 */
export async function findPerson(query, nameOf) {
  const q = query.trim().replace(/^@/, '');
  const id = /^<@([A-Z0-9]+)(?:\|[^>]*)?>$/.exec(q)?.[1] ?? (/^[UW][A-Z0-9]{6,}$/.test(q) ? q : null);
  if (id) return { id, name: await nameOf(id) };
  const people = await Promise.all(limitablePeople().map(async (p) => ({ id: p, name: await nameOf(p) })));
  const needle = q.toLowerCase();
  const hits = people.filter((p) => p.name.toLowerCase().includes(needle));
  if (hits.length === 1) return hits[0];
  const exact = hits.filter((p) => p.name.toLowerCase() === needle);
  return exact.length === 1 ? exact[0] : { candidates: hits.map((p) => p.name) };
}

/** The reply when no single person matched. */
export async function notFoundText(
  /** @type {string} */ query,
  /** @type {string[]} */ candidates,
  /** @type {NameOf} */ nameOf,
) {
  if (candidates.length) return `"${query}" matches several people: ${candidates.join(', ')}. Which one?`;
  const names = await Promise.all(limitablePeople().map(nameOf));
  return `I don't know anyone called "${query}" on Fenix's access list${names.length ? ` (${names.join(', ')})` : ''}.`;
}

/** `$5.00 a day, $30.00 a month` (a null limit reads "no daily limit"). */
const limitsText = (/** @type {{ dailyUsd: number | null, monthlyUsd: number | null }} */ l) =>
  `${l.dailyUsd === null ? 'no daily limit' : `${money(l.dailyUsd)} a day`}, ` +
  `${l.monthlyUsd === null ? 'no monthly limit' : `${money(l.monthlyUsd)} a month`}`;

/**
 * One line about a person: their limits now, where they come from, what follows, and what they used.
 * @param {Person} person
 * @param {Date} [now]
 * @returns {string}
 */
export function describeLimits({ id, name }, now = new Date()) {
  const limits = limitsFor(id, now);
  const src = limitSource(id, now);
  const parts = [];
  if (src.source === 'asked')
    parts.push(`set by ${src.setBy}${src.setAt ? ` on ${shortDay(src.setAt.slice(0, 10))}` : ''}`);
  if (src.source === 'config') parts.push('from fenix.config.json');
  if (src.until) {
    // The day after `until`, at noon UTC so it is that day in any European time zone
    const after = new Date(Date.parse(`${src.until}T12:00:00Z`) + 86_400_000);
    parts.push(`until ${shortDay(src.until)}, then ${limitsText(limitsFor(id, after))}`);
  }
  const spent = billedSpend().spend.get(id) || { dayUsd: 0, monthUsd: 0 };
  const access = isAllowed(id) ? '' : ' Not on the access list, so they cannot ask Fenix yet.';
  return (
    `${name}: ${limitsText(limits)}${parts.length ? ` (${parts.join('; ')})` : ' (default)'}. ` +
    `Used ${money(spent.dayUsd)} today, ${money(spent.monthUsd)} this month.${access}`
  );
}

/**
 * Set a person's daily and/or monthly limit. Fields not given keep the limit an owner set before (while it
 * applies). Returns the reply, or an error text.
 * @param {Person} person
 * @param {{ dailyUsd?: number, monthlyUsd?: number, until?: string }} change - until: text for parseUntil()
 * @param {string} setBy
 * @param {Date} [now]
 * @returns {{ ok: boolean, text: string }}
 */
export function setLimits(person, { dailyUsd, monthlyUsd, until }, setBy, now = new Date()) {
  if (isOwner(person.id)) return { ok: false, text: `${person.name} is an owner; owners have no spending limits.` };
  if (dailyUsd === undefined && monthlyUsd === undefined) {
    return { ok: false, text: 'Give a daily and/or a monthly limit in USD, e.g. 5 a day.' };
  }
  for (const v of [dailyUsd, monthlyUsd]) {
    if (v !== undefined && !(Number.isFinite(v) && v > 0 && v <= MAX_LIMIT_USD)) {
      return { ok: false, text: `A limit must be more than $0 and at most ${money(MAX_LIMIT_USD)}.` };
    }
  }
  const lastDay = until === undefined ? undefined : parseUntil(until, now);
  if (lastDay === null) {
    return { ok: false, text: `"${until}" is not a day from today on, like "2026-11-30" or "end of month".` };
  }

  const before = budgetOverrides()[person.id];
  const kept = before && !(before.until && localDay(now) > before.until) ? before : undefined;
  setBudgetOverride(person.id, {
    ...(kept?.dailyUsd !== undefined && { dailyUsd: kept.dailyUsd }),
    ...(kept?.monthlyUsd !== undefined && { monthlyUsd: kept.monthlyUsd }),
    ...(dailyUsd !== undefined && { dailyUsd }),
    ...(monthlyUsd !== undefined && { monthlyUsd }),
    ...((lastDay ?? kept?.until) && { until: lastDay ?? kept?.until }),
    setBy,
    setAt: now.toISOString(),
  });
  return { ok: true, text: `Done. ${describeLimits(person, now)}` };
}

/**
 * Remove the limits an owner set by asking, so the person's config entry or the defaults apply again.
 * @param {Person} person
 * @param {Date} [now]
 * @returns {{ ok: boolean, text: string }}
 */
export function resetLimits(person, now = new Date()) {
  if (!removeBudgetOverride(person.id)) {
    const fromConfig = config.usage.budgets.perUser[person.id];
    return {
      ok: false,
      text: fromConfig
        ? `${person.name} has no limits set by asking; theirs come from fenix.config.json (usage.budgets.perUser).`
        : `${person.name} already has the default limits.`,
    };
  }
  return { ok: true, text: `Reset. ${describeLimits(person, now)}` };
}

/**
 * The defaults and everyone's limits and spend.
 * @param {NameOf} nameOf
 * @param {Date} [now]
 * @returns {Promise<string>}
 */
export async function listLimits(nameOf, now = new Date()) {
  const b = config.usage.budgets;
  const teamUsd = teamSpend(billedSpend().spend);
  const header =
    `Defaults: ${limitsText({ dailyUsd: b.userDailyUsd, monthlyUsd: b.userMonthlyUsd })} per person; ` +
    `team ${b.teamMonthlyUsd === null ? 'no limit' : `${money(b.teamMonthlyUsd)} a month`} (used ${money(teamUsd)}); ` +
    `${b.threadMaxUsd === null ? 'no thread limit' : `${money(b.threadMaxUsd)} a thread`}; ` +
    `${b.replyMaxUsd === null ? 'no reply cap' : `${money(b.replyMaxUsd)} a reply`}. Owners have no limits.`;
  const people = await Promise.all(limitablePeople().map(async (id) => ({ id, name: await nameOf(id) })));
  const lines = people.sort((a, c) => a.name.localeCompare(c.name)).map((p) => `• ${describeLimits(p, now)}`);
  return [header, ...lines].join('\n');
}
