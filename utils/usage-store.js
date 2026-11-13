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
 * @property {'agent' | 'grafana' | 'teamcity'} kind
 * @property {'ok' | 'error' | 'timeout' | 'busy'} outcome
 * @property {string} [userId]
 * @property {string} [userName]
 * @property {'dm' | 'channel'} [where]
 * @property {Record<string, ModelTokens>} models - Per model ID; empty for runs without an LLM
 * @property {number} costUsd
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
 * @param {'grafana' | 'teamcity'} kind
 * @param {string} subject - Non-content label, e.g. the alert rule or build configuration
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

/** Month-to-date totals, kept in memory so the reply footer never re-reads the log. */
const monthTotals = { month: '', runs: 0, tokens: 0, costUsd: 0 };
let writeChain = Promise.resolve();

/**
 * @param {string} month
 * @returns {void}
 */
function loadMonthTotals(month) {
  Object.assign(monthTotals, { month, runs: 0, tokens: 0, costUsd: 0 });
  for (const r of readMonth(month)) {
    if (r.kind !== 'agent') continue;
    monthTotals.runs++;
    monthTotals.tokens += totalTokens(r);
    monthTotals.costUsd += r.costUsd;
  }
}

/**
 * Append one run to the current month's log. Writes are chained so lines never interleave.
 * @param {Omit<UsageRecord, 'ts'> & { ts?: string }} record
 * @returns {Promise<void>}
 */
export function recordUsage(record) {
  const now = record.ts ? new Date(record.ts) : new Date();
  const month = monthKey(now);
  if (monthTotals.month !== month) {
    if (monthTotals.month) pruneOldMonths(month);
    loadMonthTotals(month);
  }
  const full = /** @type {UsageRecord} */ ({ ...record, ts: now.toISOString() });
  if (full.kind === 'agent') {
    monthTotals.runs++;
    monthTotals.tokens += totalTokens(full);
    monthTotals.costUsd += full.costUsd;
  }
  writeChain = writeChain
    .then(() => appendFile(fileFor(month), `${JSON.stringify(full)}\n`, 'utf-8'))
    .catch((e) => console.error(`Usage log write failed: ${e}`));
  return writeChain;
}

/**
 * Agent totals for the current month (UTC).
 * @returns {{ month: string, runs: number, tokens: number, costUsd: number }}
 */
export function monthToDate() {
  const month = monthKey(new Date());
  if (monthTotals.month !== month) loadMonthTotals(month);
  return { ...monthTotals };
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
