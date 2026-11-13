import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  clip,
  collectHostEvidence,
  diagnose,
  evidenceFields,
  lastSeenWithin,
  notableKinds,
  VERDICT_STATUS,
} from '../../integrations/host-health.js';
import { textResult } from '../../utils/helpers.js';

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
