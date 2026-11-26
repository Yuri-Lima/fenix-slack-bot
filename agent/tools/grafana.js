import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { config } from '../../config.js';
import {
  clip,
  clock,
  collectHostEvidence,
  dayLabel,
  diagnose,
  endLabel,
  evidenceFields,
  ignoredBy,
  ignoredHostMessage,
  ignoreHostNames,
  ignoreHostParts,
  lastSeenWithin,
  logHosts,
  notableKinds,
  parseLocalTime,
  serverOf,
  VERDICT_STATUS,
} from '../../integrations/host-health.js';
import { formatHostLogs, MAX_LOG_MINUTES, readHostLogs, resolveLogHost } from '../../integrations/host-logs.js';
import { collectPostgresEvidence, postgresLine, postgresVerdicts } from '../../integrations/postgres-health.js';
import { textResult } from '../../utils/helpers.js';
import { addedIgnoreParts, addIgnorePart, removeIgnorePart } from '../../utils/ignore-hosts-store.js';

const STATUS_ORDER = ['down', 'action', 'watch', 'false-alarm'];
/** How far back to look for a server that sent nothing in the requested window. */
const LOOKBACK_DAYS = 7;
/** Error line length handed to the model; enough for the cause, cheap in tokens. */
const MAX_ERROR_CHARS = 400;

/** The `end` parameter both tools share: a past moment to look at instead of now. */
const endParam = z
  .string()
  .optional()
  .describe(
    `End of the window, "YYYY-MM-DD HH:MM" in ${config.timeZone} (default: now). For a past moment, end a little ` +
      'after it, e.g. "what happened at 11:10 yesterday" → end 11:25 of that day with minutes 30.',
  );

/**
 * Unix seconds for the `end` parameter, now when it is missing, or an error text.
 * @param {string | undefined} end
 * @returns {{ sec: number } | { error: string }}
 */
function windowEnd(end) {
  const now = Math.floor(Date.now() / 1000);
  if (!end) return { sec: now };
  const sec = parseLocalTime(end);
  if (sec === null) return { error: `"${end}" is not a time like "2026-11-16 11:25" (${config.timeZone}).` };
  return { sec: Math.min(sec, now) };
}

/** Strip Slack emoji codes and markup so the text reads well outside Slack too. */
const plain = (/** @type {string} */ s) => s.replace(/:[a-z_]+: /g, '').replace(/\*/g, '');

export const hostHealthTool = tool(
  'host_health',
  'Health of one server from Grafana metrics and logs, now or at a past moment: reachability, CPU and load, ' +
    'memory and swap, disk, Phoenix health checks, Postgres (connections, long transactions, deadlocks, vacuum, ' +
    'database size; where the Postgres exporter runs), and error patterns, with a plain-language verdict. ' +
    'Use for "how is <server> doing?", "was <server> slow yesterday at 10:00?", or a server named in an alert.',
  {
    host: z.string().describe("Server name as it appears in alerts and Grafana, e.g. 'web-01'."),
    minutes: z.number().min(5).max(180).optional().describe('Length of the window before its end (default 30).'),
    end: endParam,
  },
  async ({ host, minutes = 30, end }) => {
    if (ignoredBy(host)) return textResult(ignoredHostMessage(host));
    const until = windowEnd(end);
    if ('error' in until) return textResult(until.error, true);
    try {
      const start = until.sec - minutes * 60;
      const [evidence, pg] = await Promise.all([
        collectHostEvidence(host, { start, end: until.sec }),
        collectPostgresEvidence(host, { start, end: until.sec }).catch(() => null),
      ]);
      if (evidence.reachability.nodeLastSeen === null && evidence.cpus === null) {
        const lastSeen = await lastSeenWithin(host, LOOKBACK_DAYS);
        return lastSeen
          ? textResult(
              `${host} is unreachable: no host metrics since ${new Date(lastSeen * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC. ` +
                'Check the server in the Hetzner console (power, network, disk full).',
            )
          : textResult(`No metrics for "${host}" in the last ${LOOKBACK_DAYS} days. Check the server name.`, true);
      }
      // Only what crosses a threshold; normal values show up in the metric lines below
      const verdicts = [
        ...new Map(
          notableKinds(evidence)
            .map((k) => diagnose(k, evidence))
            .concat(pg ? postgresVerdicts(host, pg, until.sec) : [])
            .map((v) => [v.title, v]),
        ).values(),
      ].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
      const lines = [
        end
          ? `${host}, ${dayLabel(start)} ${clock(start)}–${clock(until.sec)} (${config.timeZone}):`
          : `${host}, last ${minutes} minutes:`,
      ];
      for (const v of verdicts) {
        lines.push(`- ${VERDICT_STATUS[v.status].label}: ${v.title}. ${plain(v.detail)} Next step: ${v.nextStep}`);
      }
      if (verdicts.length === 0) lines.push('- Nothing unusual.');
      lines.push(...evidenceFields(evidence, 'other').map((f) => plain(f).replace('\n', ': ')));
      if (pg) lines.push(postgresLine(pg));
      for (const t of evidence.logs?.topErrors || [])
        lines.push(`Error ${t.count}× (${t.service}): ${clip(t.sample, MAX_ERROR_CHARS)}`);
      return textResult(lines.join('\n'));
    } catch (e) {
      return textResult(`Host health failed: ${/** @type {Error} */ (e).message}`, true);
    }
  },
);

/** Similar host names mentioned next to the one that was read. */
const MAX_SIMILAR = 5;

export const hostLogsTool = tool(
  'host_logs',
  "Read one server's logs from Grafana Loki, now or at a past moment, grouped into a timeline (repeated lines " +
    'counted, secrets masked). Use when someone asks what happened on a server or client, recently or at a given time, ' +
    'or to look for a specific error or text in its logs. Accepts the name people use (case and dashes ' +
    'do not matter); if it matches several servers the result lists them.',
  {
    host: z.string().describe("Server or client name, e.g. 'web-01'."),
    minutes: z
      .number()
      .int()
      .min(1)
      .max(MAX_LOG_MINUTES)
      .optional()
      .describe('Length of the window before its end (default 15).'),
    service: z.string().optional().describe('Only this service, as named in the logs (see the totals line).'),
    search: z.string().optional().describe('Only lines containing this text (case-insensitive).'),
    problems_only: z.boolean().optional().describe('Only lines that look like errors, timeouts or kills.'),
    end: endParam,
  },
  async ({ host, minutes = 15, service, search, problems_only: problemsOnly, end }) => {
    const until = windowEnd(end);
    if ('error' in until) return textResult(until.error, true);
    try {
      if (ignoredBy(host)) return textResult(ignoredHostMessage(host));
      const match = resolveLogHost(
        host,
        (await logHosts()).filter((h) => !ignoredBy(h)),
      );
      if ('candidates' in match) {
        return match.candidates.length
          ? textResult(
              `"${host}" matches several servers: ${match.candidates.slice(0, 10).join(', ')}. Ask which one is meant.`,
            )
          : textResult(`No server named like "${host}" sent logs in the last 24 hours. Check the name.`, true);
      }
      const logs = await readHostLogs(match.host, { minutes, end: until.sec, service, search, problemsOnly });
      const similar = match.similar.length
        ? `\nOther servers with a similar name: ${match.similar.slice(0, MAX_SIMILAR).join(', ')}.`
        : '';
      return textResult(formatHostLogs(logs, { service, search, problemsOnly }) + similar);
    } catch (e) {
      return textResult(`Reading logs failed: ${/** @type {Error} */ (e).message}`, true);
    }
  },
);

/** A server name part: lowercase letters, digits, dots, dashes and underscores, 2-63 characters. */
const NAME_PART = /^[a-z0-9][a-z0-9._-]{1,62}$/;

/**
 * @typedef {Object} ServerMatches
 * @property {string[]} matches - servers sending logs that the entry excludes
 * @property {string[]} similar - for an exact name, other servers whose names contain it (left analysed)
 * @property {number} known - how many servers send logs
 */

/**
 * Servers currently sending logs that `part` excludes (by name part, or the one server named exactly `part`),
 * or null when Grafana cannot be asked.
 * @param {string} part
 * @param {boolean} exact
 * @returns {Promise<ServerMatches | null>}
 */
async function serversMatching(part, exact) {
  const known = await logHosts().catch(() => null);
  if (!known) return null;
  const containing = known.filter((h) => h.toLowerCase().includes(part)).sort();
  if (!exact) return { matches: containing, similar: [], known: known.length };
  const named = (/** @type {string} */ h) => serverOf(h.toLowerCase()) === part;
  return { matches: containing.filter(named), similar: containing.filter((h) => !named(h)), known: known.length };
}

/**
 * @param {ServerMatches | null} found
 * @param {boolean} exact
 */
const matchSummary = (found, exact) => {
  if (!found) return 'Could not check which servers it matches (Grafana unavailable).';
  if (exact) {
    const which = found.matches.length
      ? `Matches ${found.matches.join(', ')}.`
      : 'No server sending logs right now has exactly this name; it applies if one appears.';
    return found.similar.length ? `${which} Still analysed: ${found.similar.join(', ')}.` : which;
  }
  return found.matches.length
    ? `Matches ${found.matches.length} of ${found.known} servers sending logs: ${found.matches.join(', ')}.`
    : 'No server sending logs right now matches it; it applies to matching servers from now on.';
};

const DURATION = /^(\d{1,3})\s*(h|d|w|mo)$/;
/** @type {Record<string, number>} */
const UNIT_MS = { h: 3600_000, d: 86_400_000, w: 7 * 86_400_000 };
const DAY = /^(\d{4})-(\d\d)-(\d\d)$/;

/**
 * When an exclusion ends, from a duration ("4h", "1d", "2w", "1mo", "always") or an end ("2026-11-23" means
 * through the end of that day, or "2026-11-23 18:00"), in config.timeZone. Neither means until removed.
 * @param {{ duration?: string, until?: string }} spec
 * @param {Date} [now]
 * @returns {{ until: Date | null } | { error: string }}
 */
export function ignoreEnd({ duration, until }, now = new Date()) {
  const d = (duration || '').trim().toLowerCase();
  const u = (until || '').trim();
  if (d && u) return { error: 'Give `duration` or `until`, not both.' };
  if (!u && (!d || d === 'always')) return { until: null };
  let end;
  if (d) {
    const m = DURATION.exec(d);
    if (!m || +m[1] < 1) return { error: `"${duration}" is not a duration like "4h", "1d", "2w", "1mo" or "always".` };
    end = new Date(now);
    const n = +m[1];
    if (m[2] === 'mo') end.setUTCMonth(end.getUTCMonth() + n);
    else end.setTime(now.getTime() + n * UNIT_MS[m[2]]);
  } else {
    const day = DAY.exec(u);
    // A day alone runs to the start of the next one
    const next = day && new Date(Date.UTC(+day[1], +day[2] - 1, +day[3] + 1)).toISOString().slice(0, 10);
    const sec = parseLocalTime(next ? `${next} 00:00` : u);
    if (sec === null) {
      return {
        error: `"${until}" is not a day like "2026-11-24" or a time like "2026-11-24 18:00" (${config.timeZone}).`,
      };
    }
    end = new Date(sec * 1000);
  }
  if (end <= now) return { error: `${endLabel(end)} has already passed.` };
  return { until: end };
}

/**
 * Tool to list, add or remove the server name parts excluded from Grafana analysis (alerts, host_health,
 * host_logs). Added parts live in data/ (they survive deploys); the ones in fenix.config.json can only be
 * changed there. It changes Fenix's behaviour, so it is offered to owners only.
 * @param {() => string} actor - who is asking, recorded with each addition
 */
export function createIgnoreHostsTool(actor) {
  return tool(
    'grafana_ignore_hosts',
    'List, add or remove the servers Fenix excludes from Grafana analysis (alert analyses, host_health, ' +
      'host_logs). A name part such as "test" excludes every server whose name contains it (case-insensitive), ' +
      'so check the listed matches; with `exact` only the server with exactly that name is excluded ("alpha" but ' +
      'not "demo-alpha"). When the user names one server, use `exact`; for a group ("the staging servers"), a ' +
      'part. An exclusion can end on its own: pass `duration` or ' +
      '`until` ("today only" is `until` today\'s date); without either it lasts until removed. Adding a part again ' +
      'changes when it ends and whether it is exact. Use when the user asks to ignore, stop analysing, mute or un-ignore a server or a ' +
      'group of servers, for a while or for good.',
    {
      action: z.enum(['list', 'add', 'remove']).describe('list the excluded parts, add one, or remove one'),
      part: z
        .string()
        .optional()
        .describe(
          'The server name part to add or remove, e.g. "staging" or a full server name. Required for add and remove.',
        ),
      exact: z
        .boolean()
        .optional()
        .describe('add only: true to exclude only the server named exactly `part`; default false (name part)'),
      duration: z
        .string()
        .optional()
        .describe('add only: how long, "4h", "1d", "2w", "1mo", or "always" (the default)'),
      until: z
        .string()
        .optional()
        .describe(
          `add only: when it ends, a day "YYYY-MM-DD" (through the end of that day) or "YYYY-MM-DD HH:MM", ` +
            `in ${config.timeZone}`,
        ),
    },
    async ({ action, part, exact = false, duration, until }) => {
      try {
        if (action === 'list') {
          const fromConfig = config.grafana.ignoreHosts.map((p) => String(p).toLowerCase());
          const added = addedIgnoreParts();
          if (!fromConfig.length && !added.length) return textResult('No servers are excluded from Grafana analysis.');
          const lines = [];
          for (const p of fromConfig) lines.push(`• "${p}" (fenix.config.json; change it there and deploy)`);
          for (const a of added) {
            const ends = a.until ? `until ${endLabel(new Date(a.until))}` : 'until removed';
            const kind = a.exact ? 'exact name; ' : '';
            lines.push(`• "${a.part}" (${kind}added by ${a.addedBy}, ${a.addedAt.slice(0, 10)}; ${ends})`);
          }
          const known = await logHosts().catch(() => null);
          const excluded = known ? known.filter((h) => ignoredBy(h)).sort() : null;
          const now = excluded
            ? `\nServers excluded right now (${excluded.length} of ${known?.length}): ${excluded.join(', ') || 'none'}.`
            : '';
          return textResult(`Excluded from Grafana analysis:\n${lines.join('\n')}${now}`);
        }

        const value = (part || '').trim().toLowerCase();
        if (!NAME_PART.test(value)) {
          return textResult(
            'Give `part`: 2-63 lowercase letters, digits, dots, dashes or underscores, e.g. "staging".',
            true,
          );
        }

        if (action === 'remove') {
          if (removeIgnorePart(value)) return textResult(`Removed "${value}": matching servers are analysed again.`);
          if (config.grafana.ignoreHosts.some((p) => String(p).toLowerCase() === value)) {
            return textResult(
              `"${value}" comes from fenix.config.json (grafana.ignoreHosts); remove it there and deploy.`,
              true,
            );
          }
          return textResult(
            `"${value}" is not excluded. Current entries: ${[...ignoreHostNames(), ...ignoreHostParts()].join(', ') || 'none'}.`,
            true,
          );
        }

        // add
        if (config.grafana.ignoreHosts.some((p) => String(p).toLowerCase() === value)) {
          return textResult(`"${value}" is already excluded in fenix.config.json, with no end.`);
        }
        const end = ignoreEnd({ duration, until });
        if ('error' in end) return textResult(end.error, true);
        const ends = end.until
          ? `until ${endLabel(end.until)}, then they are analysed again on their own`
          : 'until someone removes it';
        const what = exact ? 'only this server' : 'every server whose name contains it';
        if (addedIgnoreParts().some((a) => a.part === value)) {
          addIgnorePart(value, actor(), { until: end.until, exact });
          return textResult(`"${value}" stays excluded (${what}), now ${ends}.`);
        }
        const found = await serversMatching(value, exact);
        if (!exact && found && found.known > 1 && found.matches.length === found.known) {
          return textResult(
            `Not added: "${value}" matches every server sending logs (${found.known}), so Fenix would analyse ` +
              'nothing. Use a more specific part or the full server name.',
            true,
          );
        }
        addIgnorePart(value, actor(), { until: end.until, exact });
        const servers = exact ? 'the server with exactly this name' : 'servers whose names contain it';
        return textResult(
          `Added "${value}": Fenix no longer analyses alerts for, or answers host_health / host_logs about, ` +
            `${servers}, ${ends}. ${matchSummary(found, exact)}`,
        );
      } catch (e) {
        return textResult(`Could not update the excluded servers: ${e instanceof Error ? e.message : e}`, true);
      }
    },
  );
}
