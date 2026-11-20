import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, resolvePath } from '../config.js';

// Usage log: one JSON line per Fenix run (agent replies, Grafana and TeamCity
// analyses), in one file per calendar month (UTC): data/usage/2026-11.jsonl.
// The current month's file is the only write target; files older than
// config.usage.retentionMonths are deleted when a new month starts. Message
// text is never stored.

const USAGE_DIR = join(resolvePath(config.dataDir), 'usage');
mkdirSync(USAGE_DIR, { recursive: true });

/**
 * @typedef {Object} ModelTokens
 * @property {number} input
 * @property {number} output
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} costUsd
 */

/**
 * @typedef {Object} UsageRecord
 * @property {string} ts - ISO time the run finished
 * @property {'agent' | 'grafana' | 'teamcity' | 'mcp'} kind - mcp: a tool call from Claude Code (its tokens are Claude Code's, not Fenix's)
 * @property {'ok' | 'error' | 'timeout' | 'busy' | 'budget'} outcome - budget: refused by a spending limit (no model call)
 * @property {string} [userId]
 * @property {string} [userName]
 * @property {'dm' | 'channel'} [where]
 * @property {Record<string, ModelTokens>} models - Per model ID; empty for runs without an LLM
 * @property {number} costUsd - This reply's cost (for a resumed thread, without the earlier replies)
 * @property {number} turns
 * @property {number} durationMs
 * @property {Record<string, number>} tools - Tool name -> calls
 * @property {boolean} [resumed] - Continued an existing thread conversation
 * @property {string} [error] - Short error label, e.g. error_max_turns
 * @property {string} [subject] - Non-content label for analyses, e.g. the alert rule
 */

/**
 * `2026-11` for a date, in UTC.
 * @param {Date} date
 * @returns {string}
 */
export function monthKey(date) {
  return date.toISOString().slice(0, 7);
}

/** @param {string} month */
const fileFor = (month) => join(USAGE_DIR, `${month}.jsonl`);

/** Months present on disk, oldest first. */
export function storedMonths() {
  return readdirSync(USAGE_DIR)
    .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
    .map((f) => f.slice(0, 7))
    .sort();
}

/**
 * Delete monthly files older than the retention window.
 * @param {string} currentMonth
 * @returns {string[]} months removed
 */
export function pruneOldMonths(currentMonth) {
  const [y, m] = currentMonth.split('-').map(Number);
  const oldestKept = monthKey(new Date(Date.UTC(y, m - config.usage.retentionMonths, 1)));
  const removed = storedMonths().filter((month) => month < oldestKept);
  for (const month of removed) unlinkSync(fileFor(month));
  return removed;
}

/**
 * Usage record for a rule-based analysis (no LLM, so no tokens or cost).
 * @param {'grafana' | 'teamcity' | 'mcp'} kind
 * @param {string} subject - Non-content label, e.g. the alert rule, build configuration, or tool name
 * @param {number} startedAt - Date.now() when the analysis began
 * @returns {Omit<UsageRecord, 'ts'>}
 */
export function ruleBasedRun(kind, subject, startedAt) {
  return {
    kind,
    outcome: 'ok',
    subject,
    models: {},
    costUsd: 0,
    turns: 0,
    durationMs: Date.now() - startedAt,
    tools: {},
  };
}

/** Sum of tokens across all models of a record. */
export function totalTokens(/** @type {UsageRecord} */ r) {
  return Object.values(r.models).reduce((sum, t) => sum + t.input + t.output + t.cacheRead + t.cacheWrite, 0);
}

/**
 * `2026-11-18` for a date, in config.timeZone: the day daily budgets and report days use.
 * @param {Date} date
 * @returns {string}
 */
export function localDay(date) {
  return date.toLocaleDateString('en-CA', { timeZone: config.timeZone });
}

/** A local day starts at most this long before now, whatever the time zone. */
const DAY_LOOKBACK_MS = 27 * 3600_000;

/**
 * Agent totals for the current month and day, kept in memory so footers and budget checks never re-read the log.
 * users: Slack user ID -> spend this month and today.
 */
const totals = {
  month: '',
  day: '',
  runs: 0,
  tokens: 0,
  costUsd: 0,
  /** @type {Map<string, { monthUsd: number, dayUsd: number }>} */
  users: new Map(),
};
let writeChain = Promise.resolve();

/** @param {string | undefined} userId */
function userTotals(userId) {
  const id = userId || 'unknown';
  if (!totals.users.has(id)) totals.users.set(id, { monthUsd: 0, dayUsd: 0 });
  return /** @type {{ monthUsd: number, dayUsd: number }} */ (totals.users.get(id));
}

/**
 * Bring the totals to the month and day of `now`, reading the log only when one of them changed. A new
 * month also deletes the months past retention.
 * @param {Date} now
 * @returns {void}
 */
function ensureCurrent(now) {
  const month = monthKey(now);
  const day = localDay(now);
  if (totals.month !== month) {
    if (totals.month) pruneOldMonths(month);
    Object.assign(totals, { month, runs: 0, tokens: 0, costUsd: 0 });
    totals.users.clear();
    for (const r of readMonth(month)) {
      if (r.kind !== 'agent') continue;
      totals.runs++;
      totals.tokens += totalTokens(r);
      totals.costUsd += r.costUsd;
      userTotals(r.userId).monthUsd += r.costUsd;
    }
    totals.day = '';
  }
  if (totals.day !== day) {
    totals.day = day;
    for (const u of totals.users.values()) u.dayUsd = 0;
    // The local day can start in the previous UTC month, so read by time range, not by month file
    for (const r of readRange(new Date(now.getTime() - DAY_LOOKBACK_MS), now)) {
      if (r.kind === 'agent' && localDay(new Date(r.ts)) === day) userTotals(r.userId).dayUsd += r.costUsd;
    }
  }
}

/**
 * Append one run to its month's log. Writes are chained so lines never interleave. Agent runs of the
 * current month (and day) are added to the in-memory totals.
 * @param {Omit<UsageRecord, 'ts'> & { ts?: string }} record
 * @returns {Promise<void>}
 */
export function recordUsage(record) {
  const at = record.ts ? new Date(record.ts) : new Date();
  const full = /** @type {UsageRecord} */ ({ ...record, ts: at.toISOString() });
  ensureCurrent(new Date());
  if (full.kind === 'agent' && monthKey(at) === totals.month) {
    totals.runs++;
    totals.tokens += totalTokens(full);
    totals.costUsd += full.costUsd;
    const u = userTotals(full.userId);
    u.monthUsd += full.costUsd;
    if (localDay(at) === totals.day) u.dayUsd += full.costUsd;
  }
  writeChain = writeChain
    .then(() => appendFile(fileFor(monthKey(at)), `${JSON.stringify(full)}\n`, 'utf-8'))
    .catch((e) => console.error(`Usage log write failed: ${e}`));
  return writeChain;
}

/**
 * Agent totals for the current month (UTC).
 * @returns {{ month: string, runs: number, tokens: number, costUsd: number }}
 */
export function monthToDate() {
  ensureCurrent(new Date());
  const { month, runs, tokens, costUsd } = totals;
  return { month, runs, tokens, costUsd };
}

/**
 * What each person's agent replies cost this month (UTC) and today (config.timeZone).
 * @returns {Map<string, { monthUsd: number, dayUsd: number }>} Slack user ID -> spend (a copy)
 */
export function spendByUser() {
  ensureCurrent(new Date());
  return new Map([...totals.users].map(([id, u]) => [id, { ...u }]));
}

/**
 * All records of one month; unreadable lines are skipped.
 * @param {string} month
 * @returns {UsageRecord[]}
 */
export function readMonth(month) {
  let raw;
  try {
    raw = readFileSync(fileFor(month), 'utf-8');
  } catch {
    return [];
  }
  /** @type {UsageRecord[]} */
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // a partially written last line after a crash; skip it
    }
  }
  return records;
}

/**
 * Records between two times, reading only the monthly files that overlap.
 * @param {Date} from
 * @param {Date} to
 * @returns {UsageRecord[]}
 */
export function readRange(from, to) {
  const first = monthKey(from);
  const last = monthKey(to);
  return storedMonths()
    .filter((m) => m >= first && m <= last)
    .flatMap(readMonth)
    .filter((r) => r.ts >= from.toISOString() && r.ts <= to.toISOString());
}

/**
 * Resolves once every write started so far has finished (for shutdown and tests).
 * @returns {Promise<void>}
 */
export function flushUsage() {
  return writeChain;
}
