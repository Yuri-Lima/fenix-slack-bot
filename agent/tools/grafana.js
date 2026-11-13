import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { config } from '../../config.js';
import {
  clip,
  collectHostEvidence,
  diagnose,
  evidenceFields,
  ignoredBy,
  ignoredHostMessage,
  ignoreHostParts,
  lastSeenWithin,
  logHosts,
  notableKinds,
  VERDICT_STATUS,
} from '../../integrations/host-health.js';
import { formatHostLogs, MAX_LOG_MINUTES, readHostLogs, resolveLogHost } from '../../integrations/host-logs.js';
import { textResult } from '../../utils/helpers.js';
import { addedIgnoreParts, addIgnorePart, removeIgnorePart } from '../../utils/ignore-hosts-store.js';

const STATUS_ORDER = ['down', 'action', 'watch', 'false-alarm'];
/** How far back to look for a server that sent nothing in the requested window. */
const LOOKBACK_DAYS = 7;
/** Error line length handed to the model; enough for the cause, cheap in tokens. */
const MAX_ERROR_CHARS = 400;

/** Strip Slack emoji codes and markup so the text reads well outside Slack too. */
const plain = (/** @type {string} */ s) => s.replace(/:[a-z_]+: /g, '').replace(/\*/g, '');

export const hostHealthTool = tool(
  'host_health',
  'Current health of one server from Grafana metrics and logs: reachability, CPU and load, memory and swap, ' +
    'disk, Phoenix health checks, and recent error patterns, with a plain-language verdict. ' +
    'Use for "how is <server> doing?" or to investigate a server named in an alert.',
  {
    host: z.string().describe("Server name as it appears in alerts and Grafana, e.g. 'web-01'."),
    minutes: z.number().min(5).max(180).optional().describe('How far back to look (default 30).'),
  },
  async ({ host, minutes = 30 }) => {
    if (ignoredBy(host)) return textResult(ignoredHostMessage(host));
    try {
      const evidence = await collectHostEvidence(host, { start: Math.floor(Date.now() / 1000) - minutes * 60 });
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
            .map((v) => [v.title, v]),
        ).values(),
      ].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
      const lines = [`${host}, last ${minutes} minutes:`];
      for (const v of verdicts) {
        lines.push(`- ${VERDICT_STATUS[v.status].label}: ${v.title}. ${plain(v.detail)} Next step: ${v.nextStep}`);
      }
      if (verdicts.length === 0) lines.push('- Nothing unusual.');
      lines.push(...evidenceFields(evidence, 'other').map((f) => plain(f).replace('\n', ': ')));
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
  "Read one server's recent logs from Grafana Loki, grouped into a timeline (repeated lines counted, " +
    'secrets masked). Use when someone asks what happened on a server or client in the last minutes, ' +
    'or to look for a specific error or text in its logs. Accepts the name people use (case and dashes ' +
    'do not matter); if it matches several servers the result lists them.',
  {
    host: z.string().describe("Server or client name, e.g. 'web-01'."),
    minutes: z.number().int().min(1).max(MAX_LOG_MINUTES).optional().describe('How far back to read (default 15).'),
    service: z.string().optional().describe('Only this service, as named in the logs (see the totals line).'),
    search: z.string().optional().describe('Only lines containing this text (case-insensitive).'),
    problems_only: z.boolean().optional().describe('Only lines that look like errors, timeouts or kills.'),
  },
  async ({ host, minutes = 15, service, search, problems_only: problemsOnly }) => {
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
      const logs = await readHostLogs(match.host, { minutes, service, search, problemsOnly });
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
 * Servers currently sending logs whose names contain `part`, or null when Grafana cannot be asked.
 * @param {string} part
 * @returns {Promise<{ matches: string[], known: number } | null>}
 */
async function serversMatching(part) {
  const known = await logHosts().catch(() => null);
  if (!known) return null;
  return { matches: known.filter((h) => h.toLowerCase().includes(part)).sort(), known: known.length };
}

/** @param {{ matches: string[], known: number } | null} found */
const matchSummary = (found) =>
  !found
    ? 'Could not check which servers it matches (Grafana unavailable).'
    : found.matches.length
      ? `Matches ${found.matches.length} of ${found.known} servers sending logs: ${found.matches.join(', ')}.`
      : 'No server sending logs right now matches it; it applies to matching servers from now on.';

/**
 * Tool to list, add or remove the server name parts excluded from Grafana analysis (alerts, host_health,
 * host_logs). Added parts live in data/ (they survive deploys); the ones in fenix.config.json can only be
 * changed there. It changes Fenix's behaviour, so it is offered to owners only.
 * @param {() => string} actor - who is asking, recorded with each addition
 */
export function createIgnoreHostsTool(actor) {
  return tool(
    'grafana_ignore_hosts',
    'List, add or remove the server name parts Fenix excludes from Grafana analysis (alert analyses, host_health, ' +
      'host_logs), e.g. "test" excludes every server whose name contains "test". Matching is a case-insensitive ' +
      'substring, so check the listed matches before adding. Use when the user asks to ignore, stop analysing, ' +
      'mute or un-ignore a server or a group of servers.',
    {
      action: z.enum(['list', 'add', 'remove']).describe('list the excluded parts, add one, or remove one'),
      part: z
        .string()
        .optional()
        .describe(
          'The server name part to add or remove, e.g. "staging" or a full server name. Required for add and remove.',
        ),
    },
    async ({ action, part }) => {
      try {
        if (action === 'list') {
          const fromConfig = config.grafana.ignoreHosts.map((p) => String(p).toLowerCase());
          const added = addedIgnoreParts();
          if (!fromConfig.length && !added.length) return textResult('No servers are excluded from Grafana analysis.');
          const lines = [];
          for (const p of fromConfig) lines.push(`• "${p}" (fenix.config.json; change it there and deploy)`);
          for (const a of added) lines.push(`• "${a.part}" (added by ${a.addedBy}, ${a.addedAt.slice(0, 10)})`);
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
            `"${value}" is not excluded. Current parts: ${ignoreHostParts().join(', ') || 'none'}.`,
            true,
          );
        }

        // add
        if (ignoreHostParts().includes(value)) return textResult(`"${value}" is already excluded.`);
        const found = await serversMatching(value);
        if (found && found.known > 1 && found.matches.length === found.known) {
          return textResult(
            `Not added: "${value}" matches every server sending logs (${found.known}), so Fenix would analyse ` +
              'nothing. Use a more specific part or the full server name.',
            true,
          );
        }
        addIgnorePart(value, actor());
        return textResult(
          `Added "${value}": Fenix no longer analyses alerts for, or answers host_health / host_logs about, ` +
            `servers whose names contain it. ${matchSummary(found)}`,
        );
      } catch (e) {
        return textResult(`Could not update the excluded servers: ${e instanceof Error ? e.message : e}`, true);
      }
    },
  );
}
