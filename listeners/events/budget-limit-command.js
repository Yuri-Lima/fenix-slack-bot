import { findPerson, listLimits, notFoundText, resetLimits, setLimits } from '../../utils/budget-limits.js';
import { resolveUserName } from '../../utils/slack.js';

// Owner commands to change a person's spending limits, run in code (no AI tokens, so they work even while
// the API credits are used up):
//   limits                                     everyone's limits and spend
//   limit @Dana 5/day [50/month] [until 2026-11-30 | until end of month]
//   limit @Dana reset                        back to fenix.config.json or the defaults
// A bare amount is a daily limit. Anything else starting with "limit" goes to the agent as usual.

export const LIMIT_HELP =
  'Try `limits`, `limit @name 5/day`, `limit @name 50/month until end of month` or `limit @name reset`.';

/** One amount at the end of the text: "5", "$5", "5/day", "5 a day", "50 per month", "50/monthly". */
const AMOUNT_AT_END = /\s+\$?(\d+(?:\.\d+)?)\s*(?:\/\s*|\s+(?:a|per)\s+)?(day|daily|month|monthly)?$/i;

/**
 * @typedef {{ action: 'list' } | { action: 'reset', who: string }
 *   | { action: 'set', who: string, dailyUsd?: number, monthlyUsd?: number, until?: string }} LimitCommand
 */

/**
 * The command when the text is a well-formed `limits` / `limit …` command, else null.
 * @param {string} text - Message text with bot mentions of Fenix stripped
 * @returns {LimitCommand | null}
 */
export function parseLimitCommand(text) {
  const t = text.trim().replace(/[.!]$/, '');
  if (/^limits$/i.test(t)) return { action: 'list' };
  const m = /^limit\s+(.+)$/i.exec(t);
  if (!m) return null;
  let rest = ` ${m[1]}`;
  let until;
  const u = /\s+until\s+(\S.*)$/i.exec(rest);
  if (u) {
    until = u[1].trim();
    rest = rest.slice(0, u.index);
  }
  if (/\s+reset$/i.test(rest)) {
    const who = rest.replace(/\s+reset$/i, '').trim();
    return who && until === undefined ? { action: 'reset', who } : null;
  }
  /** @type {{ dailyUsd?: number, monthlyUsd?: number }} */
  const amounts = {};
  for (let a = AMOUNT_AT_END.exec(rest); a; a = AMOUNT_AT_END.exec(rest)) {
    const key = /^month/i.test(a[2] || '') ? 'monthlyUsd' : 'dailyUsd';
    if (amounts[key] !== undefined) return null;
    amounts[key] = Number(a[1]);
    rest = rest.slice(0, a.index);
  }
  const who = rest.trim();
  if (!who || (amounts.dailyUsd === undefined && amounts.monthlyUsd === undefined)) return null;
  return { action: 'set', who, ...amounts, ...(until !== undefined && { until }) };
}

/**
 * Run a limit command and answer in the thread it was sent in.
 * @param {object} args
 * @param {import('@slack/web-api').WebClient} args.client
 * @param {string} args.channel
 * @param {string} args.threadTs
 * @param {LimitCommand} args.command
 * @param {string} args.actor - Name of the owner who sent it
 * @returns {Promise<void>}
 */
export async function handleLimitCommand({ client, channel, threadTs, command, actor }) {
  const nameOf = (/** @type {string} */ id) => resolveUserName(client, id);
  const reply = (/** @type {string} */ text) => client.chat.postMessage({ channel, thread_ts: threadTs, text });
  if (command.action === 'list') {
    await reply(await listLimits(nameOf));
    return;
  }
  const person = await findPerson(command.who, nameOf);
  if ('candidates' in person) {
    await reply(`${await notFoundText(command.who, person.candidates, nameOf)} ${LIMIT_HELP}`);
    return;
  }
  const { dailyUsd, monthlyUsd, until } = command.action === 'set' ? command : {};
  const result =
    command.action === 'reset' ? resetLimits(person) : setLimits(person, { dailyUsd, monthlyUsd, until }, actor);
  await reply(result.text);
}
