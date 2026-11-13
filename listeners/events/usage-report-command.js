import { usageStatsFor } from '../../utils/usage-report.js';
import { buildUsageReportBlocks } from '../views/usage-report-builder.js';

// `report [period]` (or `usage [period]`): the full usage report, built in code
// from the usage log, so it never spends AI tokens.

const REPORT_RE = /^(?:report|usage)(?:\s+([^\s.!]+))?[.!]?$/i;
const PERIOD_HELP = 'Try `report`, `report 7d`, `report 24h`, `report last-month` or `report 2026-10`.';

/**
 * The period argument when the text is a report command, else null.
 * @param {string} text - Message text with bot mentions stripped
 * @returns {string | null} '' for the default period (this month)
 */
export function parseReportCommand(text) {
  const m = REPORT_RE.exec(text.trim());
  return m ? (m[1] ?? '') : null;
}

/**
 * Post the usage report in the thread the command was sent in.
 * @param {object} args
 * @param {import('@slack/web-api').WebClient} args.client
 * @param {string} args.channel
 * @param {string} args.threadTs
 * @param {string} args.periodArg
 * @returns {Promise<void>}
 */
export async function handleReportCommand({ client, channel, threadTs, periodArg }) {
  const stats = usageStatsFor(periodArg);
  if (!stats) {
    await client.chat.postMessage({ channel, thread_ts: threadTs, text: `I don't know that period. ${PERIOD_HELP}` });
    return;
  }
  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: `Fenix usage ${stats.label}: ${stats.runs} agent replies`,
    blocks: buildUsageReportBlocks(stats),
    unfurl_links: false,
  });
}
