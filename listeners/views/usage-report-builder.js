import { compact, money } from '../../utils/usage-report.js';

/** @typedef {import('@slack/types').KnownBlock} Block */

/** Display names for runs that use no Fenix AI tokens. */
const ANALYSIS_LABELS = { grafana: 'Grafana alerts', teamcity: 'TeamCity builds', mcp: 'Claude Code (MCP) calls' };

/** @param {string} text */
const section = (text) => /** @type {Block} */ ({ type: 'section', text: { type: 'mrkdwn', text } });
/** @param {string} text */
const context = (text) => /** @type {Block} */ ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });
/** @param {number} ms */
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

/**
 * Proportional bar for day-by-day cost, e.g. `▇▇▇▁▁`.
 * @param {number} value
 * @param {number} max
 * @returns {string}
 */
function bar(value, max) {
  const width = 10;
  const filled = max > 0 ? Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width)) : 0;
  return '▇'.repeat(filled) + '▁'.repeat(width - filled);
}

/**
 * Full usage report as Block Kit blocks. Built from pre-aggregated statistics,
 * so producing it costs no AI tokens.
 * @param {import('../../utils/usage-report.js').UsageStats} s
 * @returns {Block[]}
 */
export function buildUsageReportBlocks(s) {
  /** @type {Block[]} */
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `:bar_chart: Fenix usage · ${s.label}`, emoji: true } },
  ];

  if (s.runs === 0 && Object.keys(s.analyses).length === 0) {
    blocks.push(section('No usage recorded in this period yet.'));
    return blocks;
  }

  const outcomes = Object.entries(s.outcomes)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
  blocks.push({
    type: 'section',
    fields: [
      `:speech_balloon: *Agent replies*\n${s.runs}${outcomes ? ` (${outcomes})` : ''}`,
      `:dollar: *Cost*\n${money(s.costUsd)}`,
      `:coin: *Tokens*\n${compact(s.tokens.total)} · ${compact(s.tokens.input)} in · ${compact(s.tokens.output)} out`,
      `:recycle: *From cache*\n${compact(s.tokens.cached)} tokens · ${Math.round(s.cacheShare * 100)}% of input`,
      `:receipt: *Per reply*\n${money(s.perReply.avgCostUsd)} · ${compact(s.perReply.avgTokens)} tokens · ${s.perReply.avgTurns.toFixed(1)} steps`,
      `:stopwatch: *Reply time*\np50 ${secs(s.perReply.p50Ms)} · p95 ${secs(s.perReply.p95Ms)}`,
    ].map((text) => ({ type: 'mrkdwn', text })),
  });

  if (s.byModel.length) {
    blocks.push(
      section(
        `:robot_face: *By model*\n${s.byModel
          .map((m) => `• \`${m.name}\`  ${m.runs} runs · ${compact(m.tokens)} tokens · ${money(m.costUsd)}`)
          .join('\n')}`,
      ),
    );
  }
  if (s.byUser.length) {
    const where = Object.entries(s.byWhere)
      .map(([k, v]) => `${v} in ${k === 'dm' ? 'DMs' : 'channels'}`)
      .join(', ');
    blocks.push(
      section(
        `:bust_in_silhouette: *By user*${where ? `  _(${where})_` : ''}\n${s.byUser
          .slice(0, 10)
          .map((u) => `• ${u.name}  ${u.runs} replies · ${compact(u.tokens)} tokens · ${money(u.costUsd)}`)
          .join('\n')}`,
      ),
    );
  }
  if (s.byDay.length) {
    const days = s.byDay.slice(-14);
    const max = Math.max(...days.map((d) => d.costUsd));
    blocks.push(
      section(
        `:calendar: *By day*${s.byDay.length > 14 ? ' _(last 14)_' : ''}\n\`\`\`${days
          .map(
            (d) =>
              `${d.day.slice(5)}  ${bar(d.costUsd, max)}  ${String(d.runs).padStart(3)} replies  ${money(d.costUsd)}`,
          )
          .join('\n')}\`\`\``,
      ),
    );
  }
  if (s.tools.length) {
    blocks.push(
      section(
        `:toolbox: *Most used tools*\n${s.tools
          .slice(0, 8)
          .map((t) => `\`${t.name}\` ${t.calls}`)
          .join(' · ')}`,
      ),
    );
  }
  if (s.costliest.length && s.costliest[0].costUsd > 0) {
    blocks.push(
      section(
        `:money_with_wings: *Costliest replies*\n${s.costliest
          .filter((c) => c.costUsd > 0)
          .map(
            (c) =>
              `• <!date^${Math.floor(Date.parse(c.ts) / 1000)}^{date_short} {time}|${c.ts}>  ${c.user} · ${c.model} · ${compact(c.tokens)} tokens · ${c.turns} steps · ${money(c.costUsd)}${c.tools !== '-' ? ` · _${c.tools}_` : ''}`,
          )
          .join('\n')}`,
      ),
    );
  }

  const analyses = Object.entries(s.analyses)
    .map(([k, v]) => `${ANALYSIS_LABELS[k] || k} ${v}`)
    .join(' · ');
  blocks.push(
    { type: 'divider' },
    context(
      `:gear: Runs without Fenix AI tokens: ${analyses || 'none'}  ·  Report computed from the usage log, 0 AI tokens`,
    ),
  );
  return blocks;
}
