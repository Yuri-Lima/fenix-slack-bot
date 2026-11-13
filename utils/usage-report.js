import { config } from '../config.js';
import { readRange, totalTokens } from './usage-store.js';

// Turns the usage log into footers and reports. Everything here is computed in
// code, so a report costs no LLM tokens no matter how much history it covers.

/** @typedef {import('./usage-store.js').UsageRecord} UsageRecord */

/**
 * `claude-sonnet-4-5-20250929` -> `sonnet-4-5`
 * @param {string} model
 * @returns {string}
 */
export function shortModel(model) {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

/**
 * 845 -> `845`, 12345 -> `12.3k`, 1234567 -> `1.23M`
 * @param {number} n
 * @returns {string}
 */
export function compact(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/**
 * @param {number} usd
 * @returns {string}
 */
export function money(usd) {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/**
 * Tokens of a record split into fresh input, output, and cached input.
 * @param {UsageRecord} r
 * @returns {{ input: number, output: number, cached: number }}
 */
export function tokenSplit(r) {
  let input = 0;
  let output = 0;
  let cached = 0;
  for (const t of Object.values(r.models)) {
    input += t.input + t.cacheWrite;
    output += t.output;
    cached += t.cacheRead;
  }
  return { input, output, cached };
}

/**
 * One-line footer under an agent reply.
 * @param {UsageRecord} usage
 * @param {{ costUsd: number, tokens: number }} [monthToDate]
 * @returns {string}
 */
export function formatUsageFooter(usage, monthToDate) {
  const models = Object.entries(usage.models)
    .sort((a, b) => b[1].costUsd - a[1].costUsd)
    .map(([m]) => shortModel(m));
  const { input, output, cached } = tokenSplit(usage);
  const parts = [
    `:robot_face: ${models.join(' + ') || 'no model call'}`,
    `${compact(input)} in · ${compact(output)} out${cached ? ` · ${compact(cached)} cache` : ''}`,
    money(usage.costUsd),
    `${usage.turns} step${usage.turns === 1 ? '' : 's'}`,
    `${(usage.durationMs / 1000).toFixed(1)} s`,
  ];
  if (monthToDate) parts.push(`month: ${compact(monthToDate.tokens)} tokens · ${money(monthToDate.costUsd)}`);
  return parts.join('  ·  ');
}

/**
 * Report period from a short argument: `` / `month` (this month), `last-month`,
 * `7d` / `30d` / `24h`, or `YYYY-MM`.
 * @param {string} arg
 * @param {Date} [now]
 * @returns {{ from: Date, to: Date, label: string } | null}
 */
export function parsePeriod(arg, now = new Date()) {
  const a = arg.trim().toLowerCase();
  const startOfMonth = (/** @type {number} */ y, /** @type {number} */ m) => new Date(Date.UTC(y, m, 1));
  if (a === '' || a === 'month' || a === 'this-month') {
    return { from: startOfMonth(now.getUTCFullYear(), now.getUTCMonth()), to: now, label: 'this month' };
  }
  if (a === 'last-month') {
    const from = startOfMonth(now.getUTCFullYear(), now.getUTCMonth() - 1);
    return {
      from,
      to: new Date(startOfMonth(now.getUTCFullYear(), now.getUTCMonth()).getTime() - 1),
      label: from.toISOString().slice(0, 7),
    };
  }
  const rel = /^(\d{1,3})([dh])$/.exec(a);
  if (rel) {
    const ms = Number(rel[1]) * (rel[2] === 'd' ? 86_400_000 : 3_600_000);
    return {
      from: new Date(now.getTime() - ms),
      to: now,
      label: `last ${rel[1]}${rel[2] === 'd' ? ' days' : ' hours'}`,
    };
  }
  const month = /^(\d{4})-(\d{2})$/.exec(a);
  if (month) {
    const from = startOfMonth(Number(month[1]), Number(month[2]) - 1);
    const to = new Date(startOfMonth(Number(month[1]), Number(month[2])).getTime() - 1);
    return { from, to: to < now ? to : now, label: a };
  }
  return null;
}

/**
 * @param {number[]} values
 * @param {number} p - 0..1
 * @returns {number}
 */
function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/**
 * @typedef {Object} UsageStats
 * @property {string} label
 * @property {number} runs - Agent runs
 * @property {Record<string, number>} outcomes
 * @property {{ input: number, output: number, cached: number, total: number }} tokens
 * @property {number} costUsd
 * @property {number} cacheShare - Cached input / all input (0-1)
 * @property {{ avgCostUsd: number, avgTokens: number, avgTurns: number, p50Ms: number, p95Ms: number }} perReply - Over successful replies
 * @property {Array<{ name: string, runs: number, tokens: number, costUsd: number }>} byModel
 * @property {Array<{ name: string, runs: number, tokens: number, costUsd: number }>} byUser
 * @property {Record<string, number>} byWhere
 * @property {Array<{ day: string, runs: number, costUsd: number }>} byDay
 * @property {Array<{ name: string, calls: number }>} tools
 * @property {Array<{ ts: string, user: string, model: string, tokens: number, costUsd: number, turns: number, tools: string }>} costliest
 * @property {Record<string, number>} analyses - Rule-based runs (no tokens) by kind
 */

/**
 * Aggregate usage records into report statistics.
 * @param {UsageRecord[]} records
 * @param {string} label
 * @returns {UsageStats}
 */
export function aggregateUsage(records, label) {
  const agent = records.filter((r) => r.kind === 'agent');
  const ok = agent.filter((r) => r.outcome === 'ok');
  /** @type {Record<string, number>} */
  const outcomes = {};
  const tokens = { input: 0, output: 0, cached: 0, total: 0 };
  let costUsd = 0;
  /** @type {Map<string, { runs: number, tokens: number, costUsd: number }>} */
  const byModel = new Map();
  /** @type {Map<string, { runs: number, tokens: number, costUsd: number }>} */
  const byUser = new Map();
  /** @type {Record<string, number>} */
  const byWhere = {};
  /** @type {Map<string, { runs: number, costUsd: number }>} */
  const byDay = new Map();
  /** @type {Map<string, number>} */
  const tools = new Map();
  /** @param {Map<string, { runs: number, tokens: number, costUsd: number }>} map @param {string} key */
  const bucket = (map, key) => {
    if (!map.has(key)) map.set(key, { runs: 0, tokens: 0, costUsd: 0 });
    return /** @type {{ runs: number, tokens: number, costUsd: number }} */ (map.get(key));
  };

  for (const r of agent) {
    outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
    const split = tokenSplit(r);
    const total = totalTokens(r);
    tokens.input += split.input;
    tokens.output += split.output;
    tokens.cached += split.cached;
    tokens.total += total;
    costUsd += r.costUsd;
    for (const [model, t] of Object.entries(r.models)) {
      const b = bucket(byModel, shortModel(model));
      b.runs++;
      b.tokens += t.input + t.output + t.cacheRead + t.cacheWrite;
      b.costUsd += t.costUsd;
    }
    const u = bucket(byUser, r.userName || r.userId || 'unknown');
    u.runs++;
    u.tokens += total;
    u.costUsd += r.costUsd;
    if (r.where) byWhere[r.where] = (byWhere[r.where] || 0) + 1;
    const day = new Date(r.ts).toLocaleDateString('en-CA', { timeZone: config.timeZone });
    const d = byDay.get(day) || { runs: 0, costUsd: 0 };
    d.runs++;
    d.costUsd += r.costUsd;
    byDay.set(day, d);
    for (const [name, calls] of Object.entries(r.tools || {})) tools.set(name, (tools.get(name) || 0) + calls);
  }

  const sortByCost = (/** @type {Map<string, { runs: number, tokens: number, costUsd: number }>} */ map) =>
    [...map.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.costUsd - a.costUsd);
  const allInput = tokens.input + tokens.cached;

  /** @type {Record<string, number>} */
  const analyses = {};
  for (const r of records) if (r.kind !== 'agent') analyses[r.kind] = (analyses[r.kind] || 0) + 1;

  return {
    label,
    runs: agent.length,
    outcomes,
    tokens,
    costUsd,
    cacheShare: allInput ? tokens.cached / allInput : 0,
    perReply: {
      avgCostUsd: ok.length ? ok.reduce((s, r) => s + r.costUsd, 0) / ok.length : 0,
      avgTokens: ok.length ? ok.reduce((s, r) => s + totalTokens(r), 0) / ok.length : 0,
      avgTurns: ok.length ? ok.reduce((s, r) => s + r.turns, 0) / ok.length : 0,
      p50Ms: percentile(
        ok.map((r) => r.durationMs),
        0.5,
      ),
      p95Ms: percentile(
        ok.map((r) => r.durationMs),
        0.95,
      ),
    },
    byModel: sortByCost(byModel),
    byUser: sortByCost(byUser),
    byWhere,
    byDay: [...byDay.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
    tools: [...tools.entries()].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls),
    costliest: [...agent]
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 5)
      .map((r) => ({
        ts: r.ts,
        user: r.userName || r.userId || 'unknown',
        model: Object.keys(r.models).map(shortModel).join(' + ') || '-',
        tokens: totalTokens(r),
        costUsd: r.costUsd,
        turns: r.turns,
        tools: Object.keys(r.tools || {}).join(', ') || '-',
      })),
    analyses,
  };
}

/**
 * Usage statistics for a period argument (see parsePeriod).
 * @param {string} periodArg
 * @returns {UsageStats | null} null when the period is not understood
 */
export function usageStatsFor(periodArg) {
  const period = parsePeriod(periodArg);
  if (!period) return null;
  return aggregateUsage(readRange(period.from, period.to), period.label);
}

/**
 * Compact plain-text summary for the agent's usage_report tool: a few hundred
 * tokens of finished numbers, so asking in natural language stays cheap.
 * @param {UsageStats} s
 * @returns {string}
 */
export function formatUsageSummary(s) {
  const lines = [
    `Usage ${s.label}: ${s.runs} agent replies, ${compact(s.tokens.total)} tokens (${compact(s.tokens.input)} in, ${compact(s.tokens.output)} out, ${compact(s.tokens.cached)} cached, ${Math.round(s.cacheShare * 100)}% of input from cache), cost ${money(s.costUsd)}.`,
    `Outcomes: ${
      Object.entries(s.outcomes)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || 'none'
    }.`,
    `Per successful reply: ${money(s.perReply.avgCostUsd)}, ${compact(s.perReply.avgTokens)} tokens, ${s.perReply.avgTurns.toFixed(1)} steps, p50 ${(s.perReply.p50Ms / 1000).toFixed(1)} s, p95 ${(s.perReply.p95Ms / 1000).toFixed(1)} s.`,
    `By model: ${s.byModel.map((m) => `${m.name} ${m.runs} runs ${money(m.costUsd)}`).join('; ') || 'none'}.`,
    `By user: ${s.byUser.map((u) => `${u.name} ${u.runs} ${money(u.costUsd)}`).join('; ') || 'none'}.`,
    `Top tools: ${
      s.tools
        .slice(0, 8)
        .map((t) => `${t.name} ${t.calls}`)
        .join(', ') || 'none'
    }.`,
    `Rule-based analyses (0 tokens): ${
      Object.entries(s.analyses)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || 'none'
    }.`,
  ];
  return lines.join('\n');
}
